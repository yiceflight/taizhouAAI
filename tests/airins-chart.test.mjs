import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {airinsChart, captureAirinsChart} from '../extension/src/airins-chart.js';

const start = Date.parse('2026-10-25T09:01:11+08:00'), end = start + 1000;
function fixture() {
  const {document} = parseHTML(`<div class="task-info-item"><div class="item-label">数据量</div><div class="item-val">2</div></div>
    <div class="charts-expand-right"><div class="sensor-selector"><div class="param-check">PM₂.₅</div>(µg/m³)</div>
    <div class="history-charts-expand"><canvas width="840" height="170"></canvas></div>
    <div class="charts-info"><span>133</span><span>11</span><div class="time"><span>2026-10-25 09:01:11</span><span>2026-10-25 09:01:12</span></div></div></div>`);
  for (const el of document.querySelectorAll('*')) {
    el.getClientRects = () => [{}];
    el.getBoundingClientRect = () => ({left:10,top:10,right:910,bottom:260,width:900,height:250});
  }
  const canvas = document.querySelector('canvas'); canvas.width=840; canvas.height=170; canvas.toDataURL=()=> 'canvas-content';
  const job = {phase:'inspect', startTime:start,endTime:end,pointCount:2,maximum:133,minimum:11};
  const context = {document,location:{origin:'https://aai.airins.cn',pathname:'/sniff/HistoryCloud'},getComputedStyle:()=>({visibility:'visible',display:'block'}),innerWidth:1000,innerHeight:800,scrollX:0,scrollY:0};
  return {document, job, run:() => vm.runInNewContext(`(${airinsChart.toString()})(${JSON.stringify(job)})`,context)};
}
test('chart inspector verifies platform metric, complete time range, sample count and extrema', async()=>{
  const f=fixture(); assert.equal((await f.run()).clip.width,900);
  f.document.querySelector('.param-check').textContent='PM₁₀'; await assert.rejects(f.run(),/不是 PM2.5/);
  f.document.querySelector('.param-check').textContent='PM₂.₅';
  for (const [field,value] of [['startTime',start+1],['pointCount',3],['maximum',132],['minimum',12]]) {
    const before=f.job[field];f.job[field]=value; await assert.rejects(f.run(),/不一致/);f.job[field]=before;
  }
});
test('chart inspector refuses cropped chart and changes its signature for changed pixels', async()=>{
  const f=fixture();const before=await f.run(); f.document.querySelector('canvas').toDataURL=()=> 'changed';
  assert.notEqual((await f.run()).signature,before.signature);
  f.document.querySelector('.charts-expand-right').getBoundingClientRect=()=>({left:10,top:10,right:1100,bottom:260,width:1090,height:250});
  await assert.rejects(f.run(),/不完整/);
});
test('capture rejects a chart changed during screenshot and always releases focus emulation', async()=>{
  const commands=[];let captured=false;
  const bytes=Buffer.alloc(24);bytes.writeUInt32BE(0x89504e47,0);bytes.writeUInt32BE(0x49484452,12);bytes.writeUInt32BE(900,16);bytes.writeUInt32BE(250,20);
  const api={sendCommand:async(_,method,params)=>{
    commands.push({method,params});
    if(method==='Page.captureScreenshot'){captured=true;return {data:bytes.toString('base64')};}
    if(method==='Runtime.evaluate')return {result:{value:{clip:{x:0,y:0,width:900,height:250,scale:1},signature:captured?'changed':'stable'}}};
    return {};
  }};
  await assert.rejects(captureAirinsChart(api,7,{missionId:1,points:[{time:start,pm25:11},{time:end,pm25:133}]}),/发生变化/);
  assert.equal(commands.at(-1).method,'Emulation.setFocusEmulationEnabled');assert.equal(commands.at(-1).params.enabled,false);
});
