import { evaluateBackgroundRead } from '../extension/src/background-read.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { readDjiRoutes } from '../extension/src/dji-routes.js';
import { PLAN_URL } from '../extension/src/flight-plan.js';

const project = 'c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const folderId = '3f4c4581-41e6-4a1c-b426-3770687470d1';
async function readWithFolder(context, location) {
  const fetch = context.fetch;
  context.fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (new URL(url).searchParams.get('file_type') !== '1' || !response.ok) return response;
    const payload = await response.json();
    return { ...response, json: async () => payload.code === 0 ? { code: 0, data: { list: [{ id: folderId, name: '默认文件夹', sub_file_type: 4 }] } } : payload };
  };
  return vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`, context);
}
test('reads and normalizes route names from the fixed DJI project API', async () => {
  const location = new URL(PLAN_URL.replace('#/plan', '#/team'));
  const requests = [];
  const context = {
    location, URLSearchParams, crypto: { randomUUID: () => id(99) }, AbortSignal,
    globalThis: { localStorage: { getItem: key => key === 'x-user-token' ? 'token' : null } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ code: 0, data: { list: [
        { id: id(1), name: '东南火点巡查航线-改', update_time: 10 },
        { id: id(2), name: '东南火点巡查航线-改-副本(6)', update_time: 20 },
        { id: id(3), name: '东南火点巡查航线-改', update_time: 30 },
      ] } }) };
    },
  };
  const result = await readWithFolder(context, location);
  assert.equal(requests.length, 2);
  const request = new URL(requests[1].url);
  assert.equal(request.origin, 'https://es-flight-api-cn.djigate.com');
  assert.equal(request.pathname, `/wayline/api/v1/workspaces/${project}/web-waylines`);
  assert.equal(request.searchParams.get('parent_id'), '3f4c4581-41e6-4a1c-b426-3770687470d1');
  assert.equal(request.searchParams.get('size'), '20');
  assert.equal(request.searchParams.get('file_type'), '5');
  assert.equal(requests[0].options.headers['X-User-Token'], 'token');
  assert.equal(requests[0].options.headers['x-org-id'], 'b9fb201d-b230-433d-a1d5-e47736ca06f0');
  assert.equal(requests[0].options.headers['x-language-code'], 'zh');
  assert.equal(result.url, PLAN_URL);
  assert.equal([...result.routes.map(route => route.name)].join('|'), '东南火点巡查航线-改-副本(6)|东南火点巡查航线-改|东南火点巡查航线-改');
  assert.equal(result.routes[1].routeId, id(3));
});

test('fails before network access for another project or missing login', async () => {
  const location = new URL(PLAN_URL.replace('c7ea6bbc', 'aaaaaaaa').replace('#/plan', '#/team'));
  const context = { location, URLSearchParams, crypto: { randomUUID: () => id(1) }, AbortSignal, globalThis: {}, localStorage: { getItem: () => 'token' }, fetch: async () => { throw Error('must not fetch'); } };
  await assert.rejects(vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`, context), /项目不匹配/);
  location.href = PLAN_URL.replace('#/plan', '#/team');
  context.globalThis = { localStorage: { getItem: () => null } };
  context.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`, context), /登录已过期/);
});

test('falls back to another stored credential when the first token has expired', async () => {
  const location = new URL(PLAN_URL.replace('#/plan', '#/team'));
  const headers = [];
  const context = {
    location, URLSearchParams, crypto: { randomUUID: () => id(1) }, AbortSignal,
    globalThis: { localStorage: { getItem: key => key === 'x-user-token' ? 'expired-user' : key === 'x-auth-token' ? 'valid-auth' : null } },
    fetch: async (url, options) => {
      headers.push(options.headers);
      if (headers.length === 1) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, json: async () => ({ code: 0, data: { list: [{ id: id(2), name: '可用航线', update_time: 1 }] } }) };
    },
  };
  const result = await readWithFolder(context, location);
  assert.equal(headers[0]['X-Auth-Token'], 'valid-auth');
  assert.equal(headers[1]['X-User-Token'], 'expired-user');
  assert.equal(result.routes[0].name, '可用航线');
});

test('uses a refreshed session token when local storage still has an expired token', async () => {
  const location = new URL(PLAN_URL.replace('#/plan', '#/team'));
  const headers = [];
  const context = {
    location, URLSearchParams, crypto: { randomUUID: () => id(2) }, AbortSignal,
    globalThis: {
      localStorage: { getItem: key => key === 'x-user-token' ? 'expired-local' : null },
      sessionStorage: { getItem: key => key === 'x-user-token' ? 'fresh-session' : null },
    },
    fetch: async (url, options) => {
      headers.push(options.headers);
      if (headers.length === 1) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, json: async () => ({ code: 0, data: { list: [{ id: id(3), name: '会话航线', update_time: 1 }] } }) };
    },
  };
  const result = await readWithFolder(context, location);
  assert.equal(headers[0]['X-User-Token'], 'expired-local');
  assert.equal(headers[1]['X-User-Token'], 'fresh-session');
  assert.equal(result.routes[0].name, '会话航线');
});

test('uses the web library auth token and tolerates nested list responses', async () => {
  const location = new URL(PLAN_URL.replace('#/plan', '#/wayline'));
  const requests = [];
  const context = {
    location, URLSearchParams, crypto: { randomUUID: () => id(5) }, AbortSignal,
    globalThis: { localStorage: { getItem: key => key === 'x-auth-token' ? 'web-auth' : null } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ code: 0, data: { data: { list: [{ uuid: id(6), file_name: '网页航线', updated_at: '42' }] } } }) };
    },
  };
  const result = await readWithFolder(context, location);
  assert.equal(requests[0].options.headers['X-Auth-Token'], 'web-auth');
  assert.equal(result.routes[0].routeId, id(6));
  assert.equal(result.routes[0].name, '网页航线');
  assert.equal(result.routes[0].updateTime, 42);
});

test('worker retries another open project tab when the active tab has an expired session', async () => {
  const source = await readFile(new URL('../extension/src/service-worker.js', import.meta.url), 'utf8');
  const sync = source.slice(source.indexOf('async function syncDjiRoutes('), source.indexOf('async function bridgeTabs('));
  const tabs = [
    { id: 1, url: PLAN_URL, status: 'complete', active: true },
    { id: 2, url: PLAN_URL.replace('#/plan', '#/team'), status: 'complete', active: false },
  ];
  const calls = [];
  const result = { url: PLAN_URL, apiVersion: 1, routes: [{ routeId: id(4), name: '可用航线', updateTime: 1 }] };
  const context = vm.createContext({
    PLAN_URL, evaluateBackgroundRead,
    readDjiRoutes: async () => result,
    evaluationValue: response => response.result.value,
    debuggerSession: { acquire: async tabId => { calls.push(tabId); if (tabId === 1) throw new Error('司空登录已过期'); return true; }, release: async () => {} },
    chrome: {
      tabs: { query: async () => tabs, get: async id => tabs.find(tab => tab.id === id) },
      debugger: { sendCommand: async ({ tabId }) => ({ result: { value: tabId === 2 ? result : null } }) },
    },
  });
  vm.runInContext(sync, context);
  const actual = await vm.runInContext('syncDjiRoutes()', context);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(actual.routes, result.routes);
});

test('syncs nested folders and pagination without merging same-name routes', async () => {
  const location = new URL(PLAN_URL);
  const requests = [];
  const context = { location, URLSearchParams, crypto: { randomUUID: () => id(99) }, AbortSignal,
    globalThis: {}, fetch: async url => {
      const q = new URL(url).searchParams; requests.push(q);
      const list = q.get('file_type') === '1' ? [
        { id: id(80), name: '日常巡逻' }, { id: id(81), name: '子目录', parent_id: id(80) },
      ] : q.get('parent_id') === id(81) ? [{ id: id(40), name: '同名航线' }] :
        q.get('page') === '1' ? Array.from({length:20}, (_,i) => ({id:id(i+1),name:i===0?'同名航线':`航线${i}`})) : [{id:id(21),name:'第二页'}];
      return {ok:true,json:async()=>({code:0,data:{list,pagination:{total:q.get('file_type')==='1'?2:q.get('parent_id')===id(81)?1:21}}})};
    }};
  const result = await vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`,context);
  assert.equal(result.routes.length,22);
  assert.equal(result.routes.filter(r=>r.name==='同名航线').length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.routes.find(r=>r.routeId===id(40)).folderPath)),[{id:id(80),name:'日常巡逻'},{id:id(81),name:'子目录'}]);
  assert.ok(requests.some(q=>q.get('page')==='2'));
});

// Observed live: the default folder contains an empty child whose list is null.
for (const nested of [false, true]) {
  test(`accepts explicit empty folders and continues syncing (${nested ? 'nested envelope' : 'direct envelope'})`, async () => {
    const location = new URL(PLAN_URL);
    const requested = [];
    const context = { location, URLSearchParams, crypto: {randomUUID:()=>id(99)}, AbortSignal, globalThis:{},
      fetch: async url => {
        const q=new URL(url).searchParams; requested.push(q.get('parent_id'));
        const data=q.get('file_type')==='1' ? {list:[
          {id:id(80),parent_id:'',name:'Default Folder',sub_file_type:4},
          {id:id(81),parent_id:id(80),name:'空目录'},
          {id:id(82),parent_id:'',name:'日常巡逻'},
        ],pagination:{total:3}} : q.get('parent_id')===id(81) ? {list:null,pagination:{page:1,page_size:20,total:0}} :
          {list:[{id:q.get('parent_id')===id(80)?id(1):id(2),name:'巡查航线',parent_id:q.get('parent_id')}],pagination:{total:1}};
        return {ok:true,json:async()=>({code:0,data:nested?{data}:data})};
      }};
    const result=await vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`,context);
    assert.equal(result.routes.length,2);
    assert.ok(requested.includes(id(82)));
    assert.equal(result.routes.find(r=>r.routeId===id(1)).folderPath[0].name,'默认文件夹');
  });
}
for (const data of [{list:null,pagination:{total:1}}, {list:null}, {pagination:{total:0}}, {list:{},pagination:{total:0}}]) {
  test(`rejects incomplete or malformed lists: ${JSON.stringify(data)}`,async()=>{
    const location=new URL(PLAN_URL);
    const context={location,URLSearchParams,crypto:{randomUUID:()=>id(99)},AbortSignal,globalThis:{},fetch:async()=>({ok:true,json:async()=>({code:0,data})})};
    await assert.rejects(vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`,context),/响应格式已变化/);
  });
}
