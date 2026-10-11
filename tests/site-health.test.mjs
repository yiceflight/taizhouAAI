import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { checkSiteHealth, openAirinsForHealth, openDjiForHealth, prioritizeHealthJobs } from '../extension/src/site-health.js';
import { findJiangsuApi } from '../extension/src/jiangsu.js';
const run = (url, extra = {}) => runInNewContext(`(${checkSiteHealth.toString()})((${findJiangsuApi.toString()}))`, {
  location: new URL(url), document: { querySelectorAll: () => [], querySelector: () => null }, AbortSignal, ...extra,
});
const map = 'http://61.155.4.60:18080/#/particle-analysis/feature-analysis/time-series';
const dji = 'https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/plan';
const air = 'https://aai.airins.cn/sniff/HistoryCloud';
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
  const vm = { $options: {name:'PM-time-series'}, $Ajax: { photoTimeSeriesData() {}, componentDeviceOption: async p => {assert.equal(p.siteCodes,'321200');return {code:0,data:[]};} } };
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
test('DJI reuses only the existing HTTP client and verifies identity rather than URL presence', async () => {
  assert.equal((await run(dji)).state,'error');
  let response={data:{code:0,data:{uuid:'fixture'}}};
  const chunks=[];
  chunks.push=chunk=>chunk[2](id=>{assert.equal(id,'4994');return {ZP:{get:async(path,opts)=>{assert.equal(path,'/manage/api/v1/users/current');assert.equal(opts.timeout,12000);return response;}}};});
  assert.equal((await run(dji,{webpackChunkmain_app:chunks})).state,'ready');
  response={data:{code:401}};
  assert.equal((await run(dji,{webpackChunkmain_app:chunks})).state,'login_required');
  response={data:{code:0,data:null}};
  assert.equal((await run(dji,{webpackChunkmain_app:chunks})).state,'error');
  assert.equal((await run('https://fh.dji.com/organization/other/project/other#/plan')).state,'page_required');
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
