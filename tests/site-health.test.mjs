import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { checkSiteHealth, captureHealth, openAirinsForHealth, openDjiForHealth, prioritizeHealthJobs } from '../extension/src/site-health.js';
import { findJiangsuApi } from '../extension/src/jiangsu.js';
const run = (url, extra = {}) => runInNewContext(`(${checkSiteHealth.toString()})((${findJiangsuApi.toString()}))`, {
  location: new URL(url), document: { querySelectorAll: () => [], querySelector: () => null }, AbortSignal, ...extra,
});
const map = 'http://61.155.4.60:18080/#/particle-analysis/feature-analysis/time-series';
const dji = 'https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/plan';
const air = 'https://aai.airins.cn/sniff/HistoryCloud';
test('health recovers from a replaced execution context in the same page without waiting for the next cycle', async () => {
  let elapsed = 0, calls = 0;
  const chrome = { tabs: { get: async () => ({url:dji,status:elapsed === 200 ? 'loading' : 'complete'}) } };
  const result = await captureHealth(chrome, async () => {
    if (++calls === 1) throw Error('Inspected target navigated or closed');
    return {url:dji,state:'ready'};
  }, 1, {now:()=>elapsed,pause:async()=>{elapsed+=200;}});
  assert.equal(result.state,'ready');
  assert.equal(calls,2);
  assert.equal(elapsed,400);
});
test('health retry is bounded and never follows navigation, retries network failures or retries auth results', async () => {
  for (const mode of ['changed','pending','loading','twice','network','auth']) {
    let elapsed=0,calls=0;
    const chrome={tabs:{get:async()=>({url:elapsed && mode==='changed' ? 'https://fh.dji.com/#/login' : dji,
      pendingUrl:elapsed && mode==='pending' ? 'https://evil.test' : undefined,
      status:elapsed && mode==='loading' ? 'loading' : 'complete'})}};
    const task=captureHealth(chrome,async()=>{
      calls++;
      if(mode==='auth') return {state:'login_required'};
      throw Error(mode==='network' ? 'network failure' : 'Inspected target navigated or closed');
    },1,{now:()=>elapsed,pause:async()=>{elapsed+=200;}});
    if(mode==='auth') assert.equal((await task).state,'login_required');
    else await assert.rejects(task);
    assert.equal(calls,mode==='twice' ? 2 : 1);
    assert.ok(elapsed<=2000);
  }
});
test('health never treats an open login page as authenticated or touches credential values', async () => {
  assert.equal((await run('https://fh.dji.com/#/login')).state, 'login_required');
  assert.equal((await run(air, { document: { querySelectorAll: () => [{ getClientRects: () => [1], get value() { throw Error('credential read'); } }] } })).state, 'login_required');
  await assert.rejects(run('https://evil.test', { document: { querySelectorAll() { throw Error('must not read'); } } }), /非授权/);
});
test('Airins requires successful business API, classifies auth, permission and network failures', async () => {
  let calls = 0;
  assert.equal((await run(air, { fetch: async (url, options) => { calls++; assert.equal(options.credentials, 'include'); assert.equal(options.method, undefined); assert.ok(url.endsWith('/mission/list')); return {ok:true,json:async()=>({isSuccess:true,data:{list:[]}})}; } })).state, 'ready');
  assert.equal(calls,1);
  for (const [status, state] of [[401,'login_required'],[403,'forbidden'],[500,'error']]) assert.equal((await run(air, { fetch: async () => ({ok:false,status}) })).state,state);
  assert.equal((await run(air, { fetch: async () => ({ok:true,json:async()=>({isSuccess:false,code:401})}) })).state,'login_required');
  assert.equal((await run(air, { fetch: async () => ({ok:true,json:async()=>({isSuccess:true,data:{}})}) })).state,'error');
  assert.equal((await run(air, { fetch: async () => {throw Error('network');} })).state,'error');
});
test('Jiangsu uses fixed read-only catalog and rejects expired or unavailable sessions', async () => {
  const vm = { $options: {name:'PM-time-series'}, $Ajax: { photoTimeSeriesData() {}, getNormalSixParamData() {}, componentDeviceOption: async p => {assert.equal(p.siteCodes,'321200');return {code:0,data:[]};} } };
  const document = {querySelectorAll:()=>[],querySelector:()=>({__vue__:vm})};
  assert.equal((await run(map,{document})).state,'ready');
  vm.$Ajax.componentDeviceOption = async () => ({code:44001});
  assert.equal((await run(map,{document})).state,'login_required');
  vm.$options.name = 'App';
  vm.$Ajax.componentDeviceOption = async () => ({code:0,data:[]});
  assert.equal((await run('http://61.155.4.60:18080/#/home/map',{document})).state,'ready');
  assert.equal((await run('http://61.155.4.60:18080/#/home/map')).state,'page_required');
  assert.equal((await run(map)).state,'page_required');
});
function djiSession(extra = {}) {
  return {
    localStorage: { getItem: key => key === 'x-auth-token' ? 'fixture-auth' : null },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { user_id: 'fixture-user' } }) }),
    ...extra,
  };
}
test('DJI verifies the server identity without loading any frontend modules or returning credentials', async () => {
  for (const useUserToken of [false, true]) {
    const reads = [];
    const context = djiSession({
      webpackChunkmain_app: new Proxy([], {get() { throw Error('must not inspect modules'); }}),
      localStorage: { getItem(key) { reads.push(key); return key === 'x-user-token' ? (useUserToken ? 'fixture-user-token' : null) : 'fixture-auth'; } },
      fetch: async (url, options) => {
        assert.equal(url, 'https://es-flight-api-cn.djigate.com/manage/api/v1/users/current');
        assert.equal(options.method, 'GET');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal);
        assert.deepEqual(Object.keys(options.headers), [useUserToken ? 'X-User-Token' : 'X-Auth-Token']);
        assert.equal(Object.values(options.headers)[0], useUserToken ? 'fixture-user-token' : 'fixture-auth');
        return {ok:true,status:200,json:async()=>({code:0,data:{user_id:'private-user-id',user_account:'private-account'}})};
      },
    });
    const result = await run(dji, context);
    assert.equal(result.state, 'ready');
    assert.deepEqual(Object.keys(result).sort(), ['message','state','url']);
    assert.doesNotMatch(JSON.stringify(result), /fixture-|private-/);
    assert.deepEqual(reads, useUserToken ? ['x-user-token'] : ['x-user-token','x-auth-token']);
  }
});
test('DJI refuses missing credentials, other projects and untrusted backend destinations before requesting', async () => {
  const noRequest = async () => { throw Error('must not request'); };
  assert.equal((await run(dji, djiSession({localStorage:{getItem:()=>null},fetch:noRequest}))).state, 'login_required');
  const noStorage = {getItem() {throw Error('must not read');}};
  assert.equal((await run('https://fh.dji.com/organization/other/project/other#/plan', djiSession({localStorage:noStorage,fetch:noRequest}))).state,'page_required');
  const result = await run(dji, djiSession({CURRENT_BE_ENV_CONFIG:{server_url:'https://evil.test'},localStorage:noStorage,fetch:noRequest}));
  assert.equal(result.message, '请使用司空中国区服务后重新验证');
  const login = await run('https://fh.dji.com/#/login', djiSession({localStorage:noStorage,fetch:noRequest}));
  assert.equal(login.state, 'login_required');
});
test('DJI classifies HTTP failures and requires a successful identity, not just an open page or stored token', async () => {
  for (const [status, state] of [[401,'login_required'],[403,'forbidden'],[500,'error']]) {
    assert.equal((await run(dji,djiSession({fetch:async()=>({ok:false,status,json(){throw Error('must not parse');}})}))).state,state);
  }
  for (const [body, state] of [
    [{code:200401},'login_required'], [{code:'200401'},'login_required'],
    [{code:403},'forbidden'], [{code:0,data:null},'error'],
    [{code:0,data:{}},'error'], [{code:0,data:{user_id:'  '}},'error'],
    [{code:1,data:{user_id:'fixture'}},'error'],
  ]) {
    assert.equal((await run(dji,djiSession({fetch:async()=>({ok:true,status:200,json:async()=>body})}))).state,state);
  }
});
test('DJI network, timeout, invalid JSON and storage failures stay errors without leaking their contents', async () => {
  for (const extra of [
    {fetch:async()=>{throw Error('secret-network-detail');}},
    {fetch:async()=>{throw new DOMException('secret-timeout-detail','TimeoutError');}},
    {fetch:async()=>({ok:true,status:200,json:async()=>{throw Error('secret-response');}})},
    {localStorage:{getItem(){throw Error('secret-storage');}}},
  ]) {
    const result=await run(dji,djiSession(extra));
    assert.equal(result.state,'error');
    assert.doesNotMatch(JSON.stringify(result), /secret-/);
  }
});
test('DJI discards successful identity replies after navigation, including while parsing the body', async () => {
  for (const duringJson of [false,true]) for (const [target,state] of [
    ['https://fh.dji.com/#/login','login_required'],
    ['https://fh.dji.com/organization/other/project/other#/plan','page_required'],
  ]) {
    const location = new URL(dji);
    const result=await run(dji,djiSession({location,fetch:async()=>{
      if (!duringJson) location.href=target;
      return {ok:true,status:200,json:async()=>{
        if (duringJson) location.href=target;
        return {code:0,data:{user_id:'fixture'}};
      }};
    }}));
    assert.equal(result.state,state);
  }
});
test('startup health checks prioritize Airins without moving flight jobs', () => {
  const jobs = [{type:'dji-submit'}, {type:'site-health',tabId:1}, {type:'capture'}, {type:'site-health',tabId:2}, {type:'airins-health-open'}];
  const tabs = [{id:1,url:map}, {id:2,url:dji}];
  assert.deepEqual(prioritizeHealthJobs(jobs,tabs).map(job=>job.type), ['dji-submit','airins-health-open','capture','site-health','site-health']);
  assert.equal(prioritizeHealthJobs(jobs,tabs)[3].tabId,1);
  assert.deepEqual(jobs.map(job=>job.type), ['dji-submit','site-health','capture','site-health','airins-health-open']);
});
test('missing Airins page opens in the background and validates the created tab', async () => {
  const created=[];
  let reads=0;
  const chrome={tabs:{query:async()=>[],create:async options=>{created.push(options);return{id:17,url:air,status:'loading'}},get:async()=>{reads++;return{id:17,url:air,status:'complete'}}}};
  const result=await openAirinsForHealth(chrome,async(tabId,job)=>{assert.equal(tabId,17);assert.equal(job.type,'site-health');return{url:air,state:'ready'};});
  assert.deepEqual(created,[{url:air,active:false}]);
  assert.equal(reads,1);
  assert.equal(result.tabId,17);
  assert.equal(result.state,'ready');
});

function browserFixture(url, initial = []) {
  const tabs = initial.map(tab => ({status:'complete', ...tab}));
  const created = [];
  let elapsed = 0;
  return { tabs, created, timing: {now:()=>elapsed,pause:async()=>{elapsed+=200;}}, chrome: {tabs: {
    query: async options => {assert.equal(options.url, `${new URL(url).origin}/*`);return tabs;},
    get: async id => {const tab=tabs.find(tab=>tab.id===id);assert.ok(tab);return tab;},
    create: async options => {created.push(options);const tab={id:17,url:options.url,status:'complete'};tabs.push(tab);return tab;},
  }}};
}
for (const [name, url, open] of [['Airins',air,openAirinsForHealth],['DJI',dji,openDjiForHealth]]) {
  test(`${name} startup opens a missing page once in the background and reuses it on repeated checks`, async () => {
    const f=browserFixture(url);
    const capture=async(id,job)=>{assert.equal(job.type,'site-health');return{url:f.tabs.find(tab=>tab.id===id).url,state:'ready'};};
    assert.equal((await open(f.chrome,capture,f.timing)).tabId,17);
    assert.equal((await open(f.chrome,capture,f.timing)).state,'ready');
    assert.deepEqual(f.created,[{url,active:false}]);
  });
  test(`${name} rechecks live tabs to avoid duplicates from stale client snapshots and waits for loading pages`, async () => {
    const f=browserFixture(url,[{id:4,url,status:'loading'}]);
    f.timing.pause=async()=>{f.tabs[0].status='complete';};
    const result=await open(f.chrome,async id=>{assert.equal(id,4);return{url,state:'ready'};},f.timing);
    assert.equal(result.tabId,4);assert.equal(f.created.length,0);
  });
  test(`${name} preserves login/permission errors and stops on timeout or unauthorized redirects`, async () => {
    for (const state of ['login_required','forbidden','error']) {
      const f=browserFixture(url,[{id:4,url:`${new URL(url).origin}/#/login`}]);
      const result=await open(f.chrome,async()=>({url:f.tabs[0].url,state}),f.timing);
      assert.equal(result.state,state);assert.equal(f.created.length,0);
    }
    const loading=browserFixture(url,[{id:4,url,status:'loading'}]);
    await assert.rejects(open(loading.chrome,()=>assert.fail('must wait for page'),loading.timing),/加载超时/);
    assert.equal(loading.created.length,0);
    const redirected=browserFixture(url);
    redirected.chrome.tabs.get=async()=>({id:17,url:'https://evil.test',status:'complete'});
    await assert.rejects(open(redirected.chrome,()=>assert.fail('must not capture outside origin'),redirected.timing),/非授权/);
    assert.equal(redirected.created.length,1);
    const login=browserFixture(url);
    login.chrome.tabs.get=async()=>({id:17,url:`${new URL(url).origin}/#/login`,status:'complete'});
    const result=await open(login.chrome,async()=>({url:`${new URL(url).origin}/#/login`,state:'login_required'}),login.timing);
    assert.equal(result.state,'login_required');
  });
}

test('Jiangsu launcher on the login route requests business verification without claiming login success', async () => {
  const url = 'http://61.155.4.60:18080/#/login';
  const document = { body: { innerText: '综合分析 离线分析 数据管理 运维中心 温室气体' }, querySelectorAll: () => [] };
  const result = await run(url, { document });
  assert.equal(result.state, 'page_required');
  assert.equal(result.needsBusinessPage, true);
  assert.equal((await run(url)).state, 'login_required');
  assert.equal((await run(url, { document: { ...document, querySelectorAll: () => [{ getClientRects: () => [1] }] } })).state, 'login_required');
  assert.equal((await run('https://fh.dji.com/#/login', { document })).state, 'login_required');
});
