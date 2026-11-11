import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { collectDjiWeather, openDjiWeather, WEATHER_URL, WEATHER_READ_TIMEOUT_MS } from '../extension/src/dji-weather.js';
const now = Date.now();
function fixture(change = {}) {
  const sn = 'AHRXNBN00A029A';
  const component = {
    $options: {name:'WeatherFullDisplay'}, $children: [], $t: x => x,
    currentDeviceDetail: {device_sn:sn,device_online_status:true},
    currentDeviceThingProperties: {latitude:32.434676,longitude:119.929701,wind_speed:20,rainfall:0,environment_temperature:22,osd_timestamp:now},
    airworthy:1,getTipByAirworthy:'适合飞行',fullWeatherConfig:[{key:'windSpeed',label:'实测风速'}],fullWeatherOnlineConfig:[],
    getWeatherData: () => ({value:'20 m/s',level:1}),
    ...change,
  };
  const calls = [];
  const forecast = { hourly: [{ time: new Date(now-60000).toISOString(), text: '阴', temp: 19, humidity: 80, precip: 0, wind360: 66, windDir: '东北偏东风' }] };
  let clock = now;
  class TestDate extends Date { static now() { return clock; } }
  const context = {
    URL, AbortSignal, Date: TestDate, setTimeout: fn => { clock += 250; fn(); },
    location: new URL(WEATHER_URL),
    localStorage: {getItem: key => key === 'x-user-token' ? 'test-token' : null},
    document: {querySelectorAll: () => [{__vue__:component}]},
    fetch: async (url, options) => {
      calls.push({url,options});
      return {ok:true,json:async () => ({code:0,data:url.endsWith('/topologies')
        ? {list:[{parents:[{device_sn:sn,device_model:{key:'3-3-0'},device_online_status:true}]}]}
        : forecast})};
    },
  };
  return {component,context,calls,forecast,run:()=>vm.runInNewContext(`(${collectDjiWeather})()`,context)};
}
test('returns numeric forecast direction independently of OSD wind speed and text direction', async () => {
  const f = fixture();
  f.component.currentDeviceThingProperties.wind_direction = 180;
  assert.equal((await f.run()).windDirection, 66);
  assert.equal((await f.run()).forecast.observedAt, Math.floor((now-60000)/1000));
  for (const [value, expected] of [[0,0],[360,0],[22.5,22.5],[337.5,337.5],[null,null],[undefined,null],['66',null],[-1,null],[361,null],[NaN,null],[Infinity,null]]) {
    f.forecast.hourly[0].wind360 = value;
    const result = await f.run();
    assert.equal(result.windDirection, expected, String(value));
    assert.equal(result.airworthy, 1); // Missing direction does not change the platform weather verdict.
  }
});
test('uses the latest current forecast without falling back to older or future wind', async () => {
  const f = fixture();
  const h = f.forecast.hourly[0];
  f.forecast.hourly = [{...h,time:new Date(now-7200000).toISOString(),wind360:180}, {...h,time:new Date(now+60000).toISOString(),wind360:270}, {...h,wind360:undefined}, {...h,time:new Date(now-1800000).toISOString(),wind360:90}];
  assert.equal((await f.run()).windDirection, null);
  f.forecast.hourly = f.forecast.hourly.filter(h => Date.parse(h.time) < now-3600000 || Date.parse(h.time) > now);
  await assert.rejects(f.run(), /当前时段数据/);
});
test('reads API data and DJI verdict independently of wind thresholds; credentials never leave the page', async () => {
  const f=fixture(); const result=await f.run();
  assert.equal(result.airworthy,1); assert.equal(result.windSpeed,20); assert.equal(result.forecast.temperature,19);
  assert.equal(result.temperature,22); assert.equal(result.rainfall,0); assert.equal(result.forecast.precipitation,0);
  assert.equal(JSON.stringify(result).includes('test-token'),false);
  assert.equal(f.calls.length,2);
  for(const {url,options} of f.calls) { assert.equal(new URL(url).origin,'https://es-flight-api-cn.djigate.com'); assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit'); }
  f.component.airworthy=3; f.component.getTipByAirworthy='无法飞行'; f.component.currentDeviceThingProperties.wind_speed=0;
  assert.equal((await f.run()).airworthy,3);
});
test('fails closed on stale OSD, offline devices, authentication failure, wrong region and navigation',async () => {
  const f=fixture(); f.component.currentDeviceThingProperties.osd_timestamp=now-121000;
  await assert.rejects(f.run(),/实时遥测时间过期/);
  const offline=fixture(); offline.component.currentDeviceDetail.device_online_status=false;
  await assert.rejects(offline.run(),/实时在线状态未就绪/);
  const auth=fixture(); auth.context.localStorage.getItem=()=>null;
  await assert.rejects(auth.run(),/登录/); assert.equal(auth.calls.length,0);
  const region=fixture(); region.context.CURRENT_BE_ENV_CONFIG={server_url:'https://example.com'};
  await assert.rejects(region.run(),/中国区/); assert.equal(region.calls.length,0);
  const nav=fixture(); nav.context.location=new URL('https://fh.dji.com/organization/other#/team');
  await assert.rejects(nav.run(),/项目不匹配/);
});
test('rejects business failure, missing current forecast and ambiguous component',async () => {
  const fail=fixture(); fail.context.fetch=async()=>({ok:true,json:async()=>({code:401})});
  await assert.rejects(fail.run(),/登录/);
  const missing=fixture(); const fetch=missing.context.fetch;
  missing.context.fetch=(url,options)=>url.endsWith('/topologies')?fetch(url,options):Promise.resolve({ok:true,json:async()=>({code:0,data:{hourly:[]}})});
  await assert.rejects(missing.run(),/当前时段/);
  const dup=fixture();dup.context.document.querySelectorAll=()=>[{__vue__:dup.component},{__vue__:{...dup.component}}];
  await assert.rejects(dup.run(),/不唯一/);
});
test('background refresh only reloads its dedicated tab; never navigates user tabs',async()=>{
  let saved,created=0,reloads=0,tab={id:7,url:WEATHER_URL,status:'complete'};
  const listeners = new Set();
  const chrome={storage:{local:{get:async()=>({weatherTabId:saved}),set:async x=>{saved=x.weatherTabId;}}},tabs:{onUpdated:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},get:async()=>tab,create:async options=>{assert.equal(options.active,false);created++;return tab;},reload:async id=>{assert.equal(id,7);reloads++;setImmediate(()=>{for(const fn of listeners)fn(7,{status:'complete'});});}}};
  const capture=async(id,job)=>{assert.equal(id,7);assert.equal(job.type,'dji-weather');return 'receipt';};
  assert.equal(await openDjiWeather(chrome,capture),'receipt');
  assert.equal(await openDjiWeather(chrome,capture),'receipt');
  assert.equal(created,1);assert.equal(reloads,1);
});

test('rejects device replacement during the forecast request', async () => {
  const f=fixture(); const fetch=f.context.fetch;
  f.context.fetch=async(url,options)=>{const response=await fetch(url,options);if(url.endsWith('/v2')) f.component.currentDeviceDetail.device_sn='another';return response;};
  await assert.rejects(f.run(),/机场或坐标发生变化/);
});

test('waits for the reloaded document even when tabs.get still reports the old document complete', async () => {
  const listeners = new Set();
  let captures = 0, reloadStarted;
  const started = new Promise(resolve => { reloadStarted = resolve; });
  const chrome = {
    storage: { local: { get: async () => ({ weatherTabId: 7 }) } },
    tabs: {
      get: async () => ({ id: 7, url: WEATHER_URL, status: 'complete' }),
      reload: async () => { reloadStarted(); },
      onUpdated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    },
  };
  const pending = openDjiWeather(chrome, async () => { captures++; return 'fresh'; });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captures, 0);
  for (const fn of listeners) fn(8, { status: 'complete' });
  assert.equal(captures, 0);
  for (const fn of listeners) fn(7, { status: 'complete' });
  assert.equal(await pending, 'fresh');
  assert.equal(captures, 1);
  assert.equal(listeners.size, 0);
});

test('cleans up the page listener when reload fails', async () => {
  const listeners = new Set();
  const chrome = {
    storage: { local: { get: async () => ({ weatherTabId: 7 }) } },
    tabs: {
      get: async () => ({ id: 7, url: WEATHER_URL, status: 'complete' }),
      reload: async () => { throw new Error('tab closed'); },
      onUpdated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    },
  };
  await assert.rejects(openDjiWeather(chrome, () => assert.fail('must not capture')), /tab closed/);
  assert.equal(listeners.size, 0);
});

test('reports the specific missing weather item or component instead of suggesting an adapter upgrade', async () => {
  const missing = fixture({getWeatherData: () => ({value:'--',level:1})});
  await assert.rejects(missing.run(), /气象条目未就绪（windSpeed）/);
  const component = fixture(); component.context.document.querySelectorAll = () => [];
  await assert.rejects(component.run(), /机场设备卡片尚未加载/);
  const osd = fixture(); delete osd.component.currentDeviceThingProperties.osd_timestamp;
  await assert.rejects(osd.run(), /尚未收到机场实时遥测/);
});

// Exercise the worker watchdog without spending real time waiting on Chrome.
test('weather read survives the former 20s cutoff and restores focus on completion', async t => {
  const { evaluateBackgroundRead } = await import('../extension/src/background-read.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const focus = [];
  const api = { sendCommand: async (_, method, args) => {
    if (method === 'Runtime.evaluate') return new Promise(resolve => { finish = resolve; });
    focus.push(args.enabled);
  } };
  const pending = evaluateBackgroundRead(api, 7, {}, WEATHER_READ_TIMEOUT_MS);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(44000); // 12s topology + 20s component + 12s forecast.
  finish({ result: { value: 'fresh-weather' } });
  assert.deepEqual(await pending, { result: { value: 'fresh-weather' } });
  assert.deepEqual(focus, [true, false]);
});
test('a stalled weather page still times out and restores focus', async t => {
  const { evaluateBackgroundRead } = await import('../extension/src/background-read.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const focus = [];
  const api = { sendCommand: async (_, method, args) => {
    if (method === 'Runtime.evaluate') return new Promise(() => {});
    focus.push(args.enabled);
  } };
  const pending = evaluateBackgroundRead(api, 7, {}, WEATHER_READ_TIMEOUT_MS);
  const rejected = assert.rejects(pending, /后台页面读取超时/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(WEATHER_READ_TIMEOUT_MS);
  await rejected;
  assert.deepEqual(focus, [true, false]);
});

test('expands a collapsed airport group before waiting for lazily mounted cards', async () => {
  const f = fixture();
  let expanded = false, opened = false, clicks = 0, polls = 0;
  const group = { textContent: ' 机场/地面站 ', getAttribute: () => expanded ? 'true' : 'false', click: () => { clicks++; expanded = true; } };
  const card = { $options: { name: 'TsaDeviceItem' }, device: { parents: [{ device_sn: 'AHRXNBN00A029A' }] }, onOpenLiveDetail: () => { opened = true; } };
  f.context.document.querySelectorAll = selector => {
    if (selector.includes('[role="button"]')) return [group];
    if (selector.includes('#real-time-app-container')) return opened ? [{ __vue__: f.component }] : [];
    return expanded && ++polls >= 3 ? [{ __vue__: card }] : [];
  };
  assert.equal((await f.run()).airworthy, 1);
  assert.equal(clicks, 1);
  assert.equal(opened, true);
});

test('does not collapse an expanded group while opening its device detail', async () => {
  const f = fixture();
  let opened = false;
  const group = { textContent: '机场/地面站', getAttribute: () => 'true', click: () => assert.fail('must not collapse group') };
  const card = { $options: { name: 'TsaDeviceItem' }, device: { parents: [{ device_sn: 'AHRXNBN00A029A' }] }, onOpenLiveDetail: () => { opened = true; } };
  f.context.document.querySelectorAll = selector => selector.includes('[role="button"]') ? [group]
    : selector.includes('#real-time-app-container') ? opened ? [{ __vue__: f.component }] : [] : [{ __vue__: card }];
  assert.equal((await f.run()).airworthy, 1);
});

test('an hour of logged-out weather retries keeps the same redirected tab', async () => {
  for (const pending of [false, true]) {
    let saved, created = 0;
    const tab = {id: 7, url: WEATHER_URL, status: 'complete'};
    const chrome = {storage: {local: {
      get: async () => ({weatherTabId: saved}), set: async value => {saved = value.weatherTabId;},
    }}, tabs: {
      create: async () => { created++; tab.url = 'https://fh.dji.com/#/login'; return tab; },
      get: async () => tab,
    }};
    const capture = () => assert.fail('must not read weather while logged out');
    await assert.rejects(openDjiWeather(chrome, capture), /登录/);
    if (pending) { tab.url = WEATHER_URL; tab.pendingUrl = 'https://fh.dji.com/#/login'; }
    for (let i = 0; i < 120; i++) await assert.rejects(openDjiWeather(chrome, capture), /登录/);
    assert.equal(created, 1);
    assert.equal(saved, 7);
  }
});
