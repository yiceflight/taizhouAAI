import { evaluateBackgroundRead } from '../extension/src/background-read.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { readDjiRoutes } from '../extension/src/dji-routes.js';
import { PLAN_URL } from '../extension/src/flight-plan.js';

const project = 'c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
  const result = await vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`, context);
  assert.equal(requests.length, 1);
  const request = new URL(requests[0].url);
  assert.equal(request.origin, 'https://es-flight-api-cn.djigate.com');
  assert.equal(request.pathname, `/wayline/api/v1/workspaces/${project}/web-waylines`);
  assert.equal(request.searchParams.get('parent_id'), '3f4c4581-41e6-4a1c-b426-3770687470d1');
  assert.equal(request.searchParams.get('size'), '20');
  assert.equal(request.searchParams.get('file_type'), '5');
  assert.equal(requests[0].options.headers['X-User-Token'], 'token');
  assert.equal(requests[0].options.headers['x-org-id'], 'b9fb201d-b230-433d-a1d5-e47736ca06f0');
  assert.equal(requests[0].options.headers['x-language-code'], 'zh');
  assert.equal(result.url, PLAN_URL);
  assert.equal([...result.routes.map(route => route.name)].join('|'), '东南火点巡查航线-改-副本(6)|东南火点巡查航线-改');
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
  const result = await vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`, context);
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
  const result = await vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`, context);
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
  const result = await vm.runInNewContext(`(${readDjiRoutes.toString()})(${JSON.stringify(location.href)})`, context);
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
