import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { JIANGSU_URL, normalizeHourly, queryJiangsuHourly } from '../extension/src/jiangsu.js';
const raw = () => ({ url: JIANGSU_URL, city: '泰州市', cityCode: '321200', unit: 'μg/m³', dataSource: 'A_6', commonSiteType: '30', startTime: '2026-09-22 00:00:00', endTime: '2026-09-22 03:00:00', potassium: { times: ['2026-09-22 00:00:00','2026-09-22 01:00:00','2026-09-22 02:00:00','2026-09-22 03:00:00'], values: [0,null,1.2,null] }, normal: [{time:'2026-09-22 01:00:00',pm25:'35'},{time:'2026-09-22 02:00:00',pm25:20},{time:'2026-09-22 03:00:00',pm25:'--'}] });
test('aligns by source time, preserves zero and missing values, omits empty trailing slots', () => {
  assert.deepEqual(normalizeHourly(raw()).rows, [{time:'2026-09-22 00:00:00',potassium:0},{time:'2026-09-22 01:00:00',potassium:null},{time:'2026-09-22 02:00:00',potassium:1.2}]);
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
  const vm={$options:{name:'PM-time-series'},$Ajax:{
    componentDeviceOption: async p => {calls.push(p);return ok([{deviceTypeCode:'IC',factorGroupList:[{factorList:[{factorCode:'potassium-test',factorName:'K⁺',unit:'μg/m³'}]}]}]);},
    photoTimeSeriesData: async p => {calls.push(p);return ok([{factorCode:'potassium-test',dataTimes:raw().potassium.times,values:raw().potassium.values}]);},
    getNormalSixParamData: async () => {throw new Error('must not request PM2.5');},
  }};
  const result=await runInNewContext(`(${queryJiangsuHourly.toString()})('2026-09-22 00:00:00','2026-09-22 03:00:00')`,{location:new URL(JIANGSU_URL),document:{querySelector:()=>({__vue__:{$options:{name:"wrapper"},$children:[vm]}})}});
  assert.equal(normalizeHourly(result).rows.length,3);
  assert.equal(calls[1].siteCode,'321200');assert.equal(calls[1].timeType,'HOUR');assert.equal(calls[1].dataSource,'A_6');assert.equal(calls.length,2);assert.equal('normal' in result,false);
  vm.$Ajax.photoTimeSeriesData=async()=>({code:44001,data:null});
  await assert.rejects(runInNewContext(`(${queryJiangsuHourly.toString()})()`,{location:new URL(JIANGSU_URL),document:{querySelector:()=>({__vue__:{$options:{name:"wrapper"},$children:[vm]}})}}),/登录状态/);
});
test('login redirect is rejected before querying DOM', async () => {
  await assert.rejects(runInNewContext(`(${queryJiangsuHourly.toString()})()`,{location:new URL('http://61.155.4.60:18080/#/login'),get document(){throw Error('must not read')}}),/先登录/);
});
