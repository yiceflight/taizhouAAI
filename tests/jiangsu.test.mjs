import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { JIANGSU_URL, normalizeHourly, queryJiangsuHourly, prepareJiangsuForHealth, findJiangsuApi } from '../extension/src/jiangsu.js';
const raw = () => ({ url: JIANGSU_URL, city: '泰州市', cityCode: '321200', unit: 'μg/m³', dataSource: 'A_6', commonSiteType: '30', startTime: '2026-09-22 00:00:00', endTime: '2026-09-22 03:00:00', potassium: { times: ['2026-09-22 00:00:00','2026-09-22 01:00:00','2026-09-22 02:00:00','2026-09-22 03:00:00'], values: [0,null,1.2,null] }, normal: [{time:'2026-09-22 01:00:00',pm25:'35'},{time:'2026-09-22 02:00:00',pm25:20},{time:'2026-09-22 03:00:00',pm25:'--'}] });
function browserFixture(initial = []) {
  const tabs = initial.map(tab => ({ status: 'complete', ...tab }));
  const created = [];
  let elapsed = 0;
  return {
    tabs, created,
    timing: { now: () => elapsed, pause: async () => { elapsed += 250; } },
    chrome: { tabs: {
      query: async options => { assert.equal(options.url, 'http://61.155.4.60:18080/*'); return tabs; },
      get: async id => { const tab = tabs.find(tab => tab.id === id); assert.ok(tab); return tab; },
      create: async options => { created.push(options); const tab = {id:17,url:options.url,status:'complete'}; tabs.push(tab); return tab; },
    } },
  };
}
test('startup with no Jiangsu tabs opens the fixed business page once and reuses it', async () => {
  const f = browserFixture();
  const capture = async (id, job) => {assert.equal(job.type,'site-health');return {url:JIANGSU_URL,state:'ready'};};
  assert.equal((await prepareJiangsuForHealth(f.chrome,capture,f.timing)).tabId,17);
  assert.equal((await prepareJiangsuForHealth(f.chrome,capture,f.timing)).state,'ready');
  assert.deepEqual(f.created,[{url:JIANGSU_URL,active:false}]);
});
test('logged-in map is reused without opening or navigating to a business page', async () => {
  const home = 'http://61.155.4.60:18080/#/home/map';
  const f = browserFixture([{id:1,url:home}]);
  const capture = async (id, job) => {
    assert.equal(id,1); assert.equal(job.type,'site-health');
    return {url:home,state:'ready'};
  };
  assert.equal((await prepareJiangsuForHealth(f.chrome,capture,f.timing)).tabId,1);
  assert.equal((await prepareJiangsuForHealth(f.chrome,capture,f.timing)).state,'ready');
  assert.equal(f.created.length,0); assert.equal(f.tabs[0].url,home);
});
test('stale login or failing business tab cannot hide a valid map session', async () => {
  for (const staleState of ['login_required','error','forbidden']) {
    const f=browserFixture([{id:1,url:'http://61.155.4.60:18080/#/particle-analysis/feature-analysis/time-series'},{id:2,url:JIANGSU_URL},{id:3,url:'http://61.155.4.60:18080/#/login'}]);
    const result=await prepareJiangsuForHealth(f.chrome,async id=>({url:f.tabs.find(t=>t.id===id).url,state:id===2?'ready':staleState}),f.timing);
    assert.equal(result.state,'ready'); assert.equal(result.tabId,2); assert.equal(f.created.length,0);
  }
});
test('a loading business tab is reused even when another source tab needs login', async () => {
  const f = browserFixture([{id:1,url:'http://61.155.4.60:18080/#/login'},{id:2,url:JIANGSU_URL,status:'loading'}]);
  f.timing.pause = async () => {f.tabs[1].status='complete';};
  const result = await prepareJiangsuForHealth(f.chrome, async id => {
    return id === 2 ? {url:JIANGSU_URL,state:'ready'} : {url:f.tabs[0].url,state:'login_required'};
  }, f.timing);
  assert.equal(result.tabId,2); assert.equal(f.created.length,0);
});
test('a login tab that reaches the business route while loading is reused until its component mounts', async () => {
  const f = browserFixture([{id:2,url:'http://61.155.4.60:18080/#/login',status:'loading'}]);
  f.timing.pause = async () => {f.tabs[0].status='complete';f.tabs[0].url=JIANGSU_URL;};
  let checks = 0;
  const result = await prepareJiangsuForHealth(f.chrome,async()=>({url:JIANGSU_URL,state:++checks===1?'page_required':'ready'}),f.timing);
  assert.equal(result.state,'ready'); assert.equal(result.tabId,2); assert.equal(f.created.length,0);
});
test('login, expired session, permission, and network errors remain actionable without opening more tabs', async () => {
  for (const state of ['login_required','forbidden','error']) {
    const f = browserFixture([{id:1,url:'http://61.155.4.60:18080/#/home/map'}]);
    const result = await prepareJiangsuForHealth(f.chrome, async () => ({url:f.tabs[0].url,state}), f.timing);
    assert.equal(result.state,state); assert.equal(result.tabId,1); assert.equal(f.created.length,0);
  }
  const f = browserFixture([{id:1,url:JIANGSU_URL}]);
  assert.equal((await prepareJiangsuForHealth(f.chrome,async()=>({url:JIANGSU_URL,state:'login_required'}),f.timing)).state,'login_required');
});
test('missing component and loading documents time out honestly without duplicate tabs', async () => {
  for (const status of ['loading','complete']) {
    const f = browserFixture([{id:2,url:JIANGSU_URL,status}]);
    const result = await prepareJiangsuForHealth(f.chrome,async()=>({url:JIANGSU_URL,state:'page_required'}),f.timing);
    assert.equal(result.state,'error'); assert.match(result.message,/加载超时/); assert.equal(f.created.length,0);
  }
});
test('background business-page login redirect prompts login, while unauthorized redirects stop before capture', async () => {
  for (const outside of [false,true]) {
    const f = browserFixture();
    f.chrome.tabs.create = async options => ({id:17,url:options.url,status:'loading'});
    f.chrome.tabs.get = async () => ({id:17,url:outside?'https://evil.test/':'http://61.155.4.60:18080/#/login',status:'complete'});
    const capture = async id => {assert.equal(id,17);assert.equal(outside,false);return {url:'http://61.155.4.60:18080/#/login',state:'login_required'};};
    if (outside) await assert.rejects(prepareJiangsuForHealth(f.chrome,capture,f.timing),/非授权/);
    else assert.equal((await prepareJiangsuForHealth(f.chrome,capture,f.timing)).state,'login_required');
  }
});
test('aligns by source time and preserves zero, interior missing values and trailing missing hours', () => {
  assert.deepEqual(normalizeHourly(raw()).rows, [{time:'2026-09-22 00:00:00',potassium:0,pm25:null},{time:'2026-09-22 01:00:00',potassium:null,pm25:35},{time:'2026-09-22 02:00:00',potassium:1.2,pm25:20},{time:'2026-09-22 03:00:00',potassium:null,pm25:null}]);
});
test('latest missing hours advance past the last numeric reading, including an entirely missing batch', () => {
  const r = raw();
  r.startTime = '2026-10-10 11:00:00';
  r.endTime = '2026-10-10 14:00:00';
  r.potassium = { times: ['2026-10-10 14:00:00', '2026-10-10 11:00:00', '2026-10-10 12:00:00', '2026-10-10 13:00:00'], values: ['--', 0.03, '', null] };
  r.normal = [];
  assert.deepEqual(normalizeHourly(r).rows, [
    {time:'2026-10-10 11:00:00',potassium:0.03,pm25:null},
    {time:'2026-10-10 12:00:00',potassium:null,pm25:null},
    {time:'2026-10-10 13:00:00',potassium:null,pm25:null},
    {time:'2026-10-10 14:00:00',potassium:null,pm25:null},
  ]);
  r.potassium.values = ['--', '—', undefined, 'null'];
  const missing = normalizeHourly(r).rows;
  assert.equal(missing.length, 4);
  assert.ok(missing.every(row => row.potassium === null));
  assert.equal(missing.at(-1).time, r.endTime);
});
test('does not invent hours absent from the source response', () => {
  const r = raw();
  r.potassium = { times: [r.startTime, r.endTime], values: [0.03, null] };
  r.normal = [];
  assert.deepEqual(normalizeHourly(r).rows, [{time:r.startTime,potassium:0.03,pm25:null},{time:r.endTime,potassium:null,pm25:null}]);
  r.potassium = { times: [], values: [] };
  assert.deepEqual(normalizeHourly(r).rows, []);
});
test('rejects invalid timestamps, duplicates, out-of-range data and malformed measurements', () => {
  for (const bad of ['2026-09-22 00:30:00','2026-02-30 00:00:00','2026-09-23 00:00:00']) { const r=raw();r.potassium.times[0]=bad;assert.throws(()=>normalizeHourly(r)); }
  for (const bad of [true,{},'-1','N/A','1 μg/m³',NaN,Infinity]) { const r=raw();r.potassium.values[0]=bad;assert.throws(()=>normalizeHourly(r)); }
  const dup=raw();dup.potassium.times.push(dup.potassium.times[0]);dup.potassium.values.push(0);assert.throws(()=>normalizeHourly(dup),/重复/);
  const mismatch=raw();mismatch.potassium.values.pop();assert.throws(()=>normalizeHourly(mismatch),/数量/);
});
test('page adapter uses verified API shape and fixed Taizhou hourly city mixed scope without extracting credentials', async () => {
  const calls=[];
  const ok = data => ({code:0,data});
  const vm={$options:{name:'MapView'},$Ajax:{
    componentDeviceOption: async p => {calls.push(p);return ok([{deviceTypeCode:'IC',factorGroupList:[{factorList:[{factorCode:'potassium-test',factorName:'K⁺',unit:'μg/m³'}]}]}]);},
    photoTimeSeriesData: async p => {calls.push(p);return ok([{factorCode:'potassium-test',dataTimes:raw().potassium.times,values:raw().potassium.values}]);},
    getNormalSixParamData: async p => {calls.push(p);return ok(raw().normal.map(row => ({dataTime:row.time,pm25:row.pm25})));},
  }};
  const result=await runInNewContext(`(${queryJiangsuHourly.toString()})('2026-09-22 00:00:00','2026-09-22 03:00:00',(${findJiangsuApi.toString()}))`,{location:new URL(JIANGSU_URL),document:{querySelector:()=>({__vue__:{$options:{name:"wrapper"},$children:[vm]}})}});
  assert.equal(normalizeHourly(result).rows.length,4);
  assert.deepEqual(normalizeHourly(result).rows.at(-1), {time:'2026-09-22 03:00:00',potassium:null,pm25:null});
  assert.equal(calls[1].siteCode,'321200');assert.equal(calls[1].timeType,'HOUR');assert.equal(calls[1].dataSource,'A_6');assert.equal(calls[2].commonSiteType,'30');assert.equal(calls.length,3);assert.ok('normal' in result);
  vm.$Ajax.photoTimeSeriesData=async()=>({code:44001,data:null});
  await assert.rejects(runInNewContext(`(${queryJiangsuHourly.toString()})(undefined,undefined,(${findJiangsuApi.toString()}))`,{location:new URL(JIANGSU_URL),document:{querySelector:()=>({__vue__:{$options:{name:"wrapper"},$children:[vm]}})}}),/登录状态/);
});
test('login redirect is rejected before querying DOM', async () => {
  await assert.rejects(runInNewContext(`(${queryJiangsuHourly.toString()})(undefined,undefined,(${findJiangsuApi.toString()}))`,{location:new URL('http://61.155.4.60:18080/#/login'),get document(){throw Error('must not read')}}),/登录.*重新验证/);
});
