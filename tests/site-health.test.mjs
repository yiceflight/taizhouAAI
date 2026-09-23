import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { checkSiteHealth } from '../extension/src/site-health.js';
const run = (url, extra = {}) => runInNewContext(`(${checkSiteHealth.toString()})()`, {
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
