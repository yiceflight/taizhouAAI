import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, it, expect, vi } from 'vitest';
import { DroneStatus } from '../src/components/DroneStatus';
import { MonitoringPanel } from '../src/components/MonitoringPanel';
import { defaultSettings, flightDisplay, flightSummary, noFlyPeriod, type MonitorView, type FlightEvent } from '../src/lib/workspace';
const now = Date.now();
const data = (): MonitorView => ({ enabled:true, syncing:false, lastAttempt:null, lastSuccess:null, error:null, total:0, rows:[], queryThrough:null,
  settings:{...defaultSettings,noFlyPeriods:[],requireManualConfirmation:false,takeoffDelayMinutes:5},
  flight:{enabled:true,threshold:1,delayMinutes:5,event:null},
  weather:{ location:'test',latitude:0,longitude:0,source:'test',refreshing:false,allowed:true,level:'ok',label:'通过',reasons:[],current:{observedAt:now/1000,fetchedAt:now/1000,temperature:20,weatherCode:0,windSpeed:1,windGusts:2,windDirection:0,precipitation:0} },
});
const event = (status: FlightEvent['status']): FlightEvent => ({id:'test-event',name:'测试任务',observedAt:'2026-09-22 21:00:00',potassium:2,status,error:null,preview:false,source:'auto',launchAt:now+65000});
const render = (d: MonitorView, ready=true) => parseHTML(renderToStaticMarkup(<DroneStatus data={d} ready={ready} started busy={false} action={async()=>true} onFlight={()=>{}}/>)).document;
const button = (d:Document,text:string) => [...d.querySelectorAll('button')].find(b=>b.textContent===text);
const reading = (d: MonitorView, potassium: number | null, age = 1) => {
  d.rows = [{ potassium, time: new Date(now + (8 - age) * 3600000).toISOString().slice(0,19).replace('T',' ') }];
  d.settings.potassiumThreshold = 0.4;
  return d;
};
describe('drone task display',()=>{
  it('shows status refresh only for checkable tasks and exposes check errors in the overview', () => {
    for (const state of ['ready', 'submitted', 'uncertain', 'flying', 'paused', 'flight_error'] as const) {
      const d = data(); d.flight.event = { ...event(state), statusCheckedAt: now, statusCheckError: '平台风速超限，请核查原任务' };
      expect(button(render(d), '刷新状态')).toBeDefined();
      const overview = parseHTML(renderToStaticMarkup(<MonitoringPanel data={d} ready started busy={false} action={async()=>true} onPrepare={()=>{}} onFlight={()=>{}} />)).document;
      if (state === 'flight_error') {
        expect(overview.querySelector('[role="status"]')).toBeNull();
        expect(overview.querySelector('.task-records')?.textContent).toContain('平台风速超限');
      } else {
        expect(overview.querySelector('[role="status"]')?.textContent).toContain('核查未完成');
        expect(overview.querySelector('[role="status"]')?.textContent).toContain('平台风速超限');
      }
    }
    for (const state of ['failed', 'preparing', 'submitting', 'completed'] as const) {
      const d = data(); d.flight.event = event(state);
      expect(button(render(d), '刷新状态')).toBeUndefined();
    }
  });
  it.each(['completed', 'failed', 'canceled', 'dismissed', 'not_flown', 'flight_error'] as const)('hides %s from both current displays and retains its receipt once in collapsed history', state => {
    const d=reading(data(),2);
    d.flight.event={...event(state), error:'原始平台回执', statusCheckedAt:now};
    d.flight.records=[d.flight.event];
    const before=JSON.stringify(d);
    for (const reportGenerating of [false,true]) {
      expect(renderToStaticMarkup(<DroneStatus compact data={d} ready started busy={false} action={async()=>true} onFlight={()=>{}} reportGenerating={reportGenerating}/>)).toBe('');
      const doc=parseHTML(renderToStaticMarkup(<MonitoringPanel data={d} ready started busy={false} action={async()=>true} onPrepare={()=>{}} onFlight={()=>{}} reportGenerating={reportGenerating}/>)).document;
      expect(doc.querySelector('.drone-status')).toBeNull();
      expect(doc.querySelector('.task-details-copy')).toBeNull();
      expect(doc.querySelector('.task-callout')).toBeNull();
      expect(doc.querySelectorAll('.task-records li')).toHaveLength(1);
      expect(doc.querySelector('.task-records')?.hasAttribute('open')).toBe(false);
      expect(doc.querySelector('.task-records')?.textContent).toContain('原始平台回执');
      expect(button(doc,'核对资料并生成报告')).toBeUndefined();
      if(state !== 'flight_error') expect(button(doc,state==='failed'?'重新发起任务':'立即执行任务')?.hasAttribute('disabled')).toBe(false);
    }
    expect(JSON.stringify(d)).toBe(before);
  });
  it.each(['countdown', 'preparing', 'ready', 'submitting', 'submitted', 'uncertain', 'flying', 'paused'] as const)('keeps %s visible in both current displays', state => {
    const d=data();d.flight.event=event(state);
    const header=parseHTML(renderToStaticMarkup(<DroneStatus compact data={d} ready started busy={false} action={async()=>true} onFlight={()=>{}}/>)).document;
    const doc=parseHTML(renderToStaticMarkup(<MonitoringPanel data={d} ready started busy={false} action={async()=>true} onPrepare={()=>{}} onFlight={()=>{}}/>)).document;
    expect(header.querySelector('.drone-status-copy')).not.toBeNull();
    expect(doc.querySelector('.drone-status-copy')).not.toBeNull();
    expect(doc.querySelector('.task-callout')).not.toBeNull();
  });
  it('uses Beijing time for multiple no-fly ranges and moves a recorded skip to history at the end', () => {
    const d=data();d.settings.noFlyPeriods=[{start:'05:00',end:'08:00'},{start:'23:00',end:'01:30'}];
    for(const [time,blocked] of [['04:59',false],['05:00',true],['08:00',false],['23:00',true],['00:30',true],['01:30',false]] as const) {
      expect(!!noFlyPeriod(d.settings,Date.parse(`2026-10-09T${time}:00+08:00`))).toBe(blocked);
    }
    d.rows=[{time:'2026-10-09 07:00:00',potassium:1.27}];
    d.flight.event={...event('restricted'),observedAt:d.rows[0].time,error:'禁飞时间：05:00–08:00（北京时间），超标仅记录，不执行起飞。'};
    d.flight.records=[d.flight.event];
    expect(flightSummary(d,true,Date.parse('2026-10-09T07:59:59+08:00')).title).toBe('禁飞时间 · 超标仅记录');
    for (const time of ['08:00:00','08:12:40','08:30:00']) {
      const at=Date.parse(`2026-10-09T${time}+08:00`);
      expect(flightSummary(d,true,at).title).toBe('K⁺ 超标 · 等待新小时数据');
      expect(flightSummary(d,true,at).detail).toContain('不自动补飞');
      expect(flightDisplay(d,at).event).toBeNull();
      expect(flightDisplay(d,at).records).toEqual([d.flight.event]);
    }
    d.rows=[{time:'2026-10-09 08:00:00',potassium:1.27}];
    expect(flightSummary(d,true,Date.parse('2026-10-09T08:30:00+08:00')).title).toBe('K⁺ 超标 · 等待巡飞任务');
  });
  it('clears both current displays at 08:00 while retaining the skipped 07:00 receipt once', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T07:59:59+08:00'));
      const d=data(); d.settings.noFlyPeriods=[{start:'05:00',end:'08:00'}];
      d.weather!.current!.observedAt=Date.now()/1000;
      d.weather!.current!.fetchedAt=Date.now()/1000;
      d.rows=[{time:'2026-10-09 07:00:00',potassium:1.27}];
      d.flight.event={...event('restricted'),observedAt:d.rows[0].time,error:'禁飞时间：05:00–08:00（北京时间），超标仅记录，不执行起飞。'};
      d.flight.records=[d.flight.event];
      expect(render(d).querySelector('.drone-status-copy')).toBeNull();
      vi.setSystemTime(new Date('2026-10-09T08:00:00+08:00'));
      const header=parseHTML(renderToStaticMarkup(<DroneStatus compact data={d} ready started busy={false} action={async()=>true} onFlight={()=>{}}/>)).document;
      expect(header.querySelector('.drone-status-copy')?.textContent).toContain('等待新小时数据');
      const doc=parseHTML(renderToStaticMarkup(<MonitoringPanel data={d} ready started busy={false} action={async()=>true} onPrepare={()=>{}} onFlight={()=>{}}/>)).document;
      expect(doc.querySelector('.drone-status-copy')?.textContent).not.toContain('禁飞时间');
      expect(doc.querySelector('.task-details-copy')).toBeNull();
      expect(doc.querySelectorAll('.task-records li')).toHaveLength(1);
      expect(doc.querySelector('.task-records')?.textContent).toContain(d.flight.event.error);
      expect(button(doc,'立即执行任务')?.disabled).toBe(false);
      d.flight.records=[];
      expect(flightDisplay(d).records).toEqual([d.flight.event]);
    } finally { vi.useRealTimers(); }
  });
  it('shows current status after a no-fly removal while retaining the historical reason below', () => {
    const d=reading(data(),2);
    d.flight.event=null;
    d.flight.records=[{...event('restricted'),observedAt:d.rows[0].time,error:'禁飞时间：05:00–08:00（北京时间），超标仅记录，不执行起飞。'}];
    const summary=flightSummary(d,true,now);
    expect(summary.title).toBe('K⁺ 超标 · 等待新小时数据');
    expect(summary.detail).toContain('不自动补飞');
    const doc=parseHTML(renderToStaticMarkup(<MonitoringPanel data={d} ready started busy={false} action={async()=>true} onPrepare={()=>{}} onFlight={()=>{}}/>)).document;
    expect(doc.querySelector('.drone-status-copy')?.textContent).not.toContain('禁飞时间');
    expect(doc.querySelector('.task-details-copy')).toBeNull();
    expect(doc.querySelector('.task-records')?.textContent).toContain('禁飞时间：05:00–08:00');
  });
  it('only describes automatic cancellation as suppressing the current episode',()=>{
    const d=reading(data(),0.9);
    for (const source of ['manual', 'preview', 'auto', undefined]) {
      d.flight.event={...event('canceled'),source,preview:source==='preview'};
      const summary=flightSummary(d,true,now);
      if(source==='auto') expect(summary.detail).toContain('本轮超标不再自动触发');
      else expect(summary.detail).not.toContain('本轮超标不再自动触发');
      if(source==='manual' || source==='preview') expect(summary.detail).toContain('不影响自动触发');
      expect(button(render(d),'立即执行任务')?.hasAttribute('disabled')).toBe(false);
    }
  });
  it('prompts for manual action in chart red when fresh K+ exceeds the configured threshold',()=>{
    const d=reading(data(),0.9);d.flight.enabled=false;d.settings.requireManualConfirmation=true;
    const doc=render(d);
    expect(doc.querySelector('.drone-status-danger')).not.toBeNull();
    expect(doc.documentElement.textContent).toContain('K⁺ 超标 · 需要执行任务');
    expect(doc.documentElement.textContent).toContain('K⁺ 0.9 > 0.4 μg/m³');
    expect(button(doc,'立即执行任务')?.hasAttribute('disabled')).toBe(false);
    expect(button(render(d,false),'立即执行任务')?.hasAttribute('disabled')).toBe(true);
    d.weather!.allowed=false;
    expect(button(render(d),'手动强制起飞')?.hasAttribute('disabled')).toBe(false);
    expect(flightSummary(d,true,now).detail).toContain('天气条件未通过');
  });
  it('does not trigger an exceedance reminder for equal, missing, expired, or future readings',()=>{
    for(const [k,age] of [[0.4,1],[0,1],[null,1],[0.9,4],[0.9,-1]] as const){
      const d=reading(data(),k,age);d.flight.enabled=false;
      expect(flightSummary(d,true,now).tone).not.toBe('danger');
      expect(flightSummary(d,true,now).needsManualLaunch).not.toBe(true);
    }
  });
  it('waits for a real automatic task and preserves cancellation and submission outcomes',()=>{
    const d=reading(data(),0.9);
    expect(flightSummary(d,true,now).title).toBe('K⁺ 超标 · 等待巡飞任务');
    expect(flightSummary(d,true,now).title).not.toContain('后起飞');
    d.flight.event=event('countdown');
    expect(render(d).querySelector('.drone-status-danger')).not.toBeNull();
    d.flight.event=event('canceled');
    expect(flightSummary(d,true,now).title).toContain('任务已取消');
    expect(flightSummary(d,true,now).needsManualLaunch).not.toBe(true);
    d.flight.event=event('submitted');
    expect(flightSummary(d,true,now).title).toContain('起飞请求已提交');
    expect(flightSummary(d,true,now).needsManualLaunch).not.toBe(true);
  });
  it('keeps verified execution visible and removes completed report prompts from the overview',()=>{
    const d=data();
    d.flight.event=event('submitted');
    expect(flightSummary(d,true,now).title).toContain('请求已提交');
    d.flight.event.statusCheckError='司空列表未识别到该任务';
    expect(flightSummary(d,true,now).detail).toContain('核查未完成');
    d.flight.event=event('flying');
    expect(flightSummary(d,true,now).title).toContain('正在执飞');
    d.flight.event=event('flight_error');
    expect(flightSummary(d,true,now).title).toContain('执飞异常');
    d.flight.event=event('completed');
    expect(flightSummary(d,true,now).title).toContain('巡飞已结束');
    expect(button(render(d),'核对资料并生成报告')).toBeUndefined();
    expect(render(d).querySelector('.drone-status-copy')).toBeNull();
    expect(button(render(d),'立即执行任务')).toBeDefined(); // Direct manual launch remains available.
    expect(flightSummary(d,true,now,true).title).toContain('正在生成');
    expect(flightSummary(d,true,now,false).title).toContain('巡飞已结束');
  });
  it('ticks the persisted countdown and allows cancellation while another operation is busy',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);
    const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window',window);vi.stubGlobal('document',window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    const root=createRoot(window.document.getElementById('root')!);
    const d=reading(data(),0.9);d.flight.event=event('countdown');
    const action=vi.fn(async()=>true);
    try {
      await act(async()=>root.render(<DroneStatus data={d} ready started busy action={action} onFlight={()=>{}}/>));
      expect(document.body.textContent).toContain('01:05 后起飞');
      await act(async()=>vi.advanceTimersByTime(2000));
      expect(document.body.textContent).toContain('01:03 后起飞');
      expect(button(document,'取消任务')?.hasAttribute('disabled')).toBe(false);
      await act(async()=>button(document,'取消任务')!.click());
      expect(action).toHaveBeenCalledExactlyOnceWith('cancel_flight',{eventId:'test-event'});
    } finally {
      await act(async()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals();
    }
  });
  it('keeps manual launch available without K+ data, but blocks on readiness loss',()=>{
    expect(button(render(data()),'立即执行任务')?.hasAttribute('disabled')).toBe(false);
    expect(button(render(data(),false),'立即执行任务')?.hasAttribute('disabled')).toBe(true);
  });
  it('uses the persisted deadline and never invents a flying state at zero',()=>{
    const d=data();d.flight.event=event('countdown');
    expect(flightSummary(d,true,now).title).toContain('01:05 后起飞');
    expect(flightSummary(d,true,now+70000).title).toContain('等待起飞检查');
    expect(button(render(d),'取消任务')).toBeDefined();
    expect(button(render(d),'立即执行任务')).toBeUndefined();
    d.settings.requireManualConfirmation=true;
    expect(flightSummary(d,true,now).title).toContain('等待准备');
  });
  it('permits cancellation during preparation but directs submitted and uncertain tasks to review',()=>{
    const d=data();d.flight.event=event('preparing');
    expect(button(render(d),'取消任务')).toBeDefined();
    for(const status of ['submitted','uncertain','submitting'] as const) {
      d.flight.event=event(status);const doc=render(d);
      expect(button(doc,'取消任务')).toBeUndefined();
      expect(button(doc,'立即执行任务')).toBeUndefined();
      if (status === 'submitting') expect(button(doc,'到司空核查任务 ↗')).toBeUndefined();
      else expect(button(doc,'到司空核查任务 ↗')).toBeDefined();
      expect(doc.documentElement.textContent).not.toContain('飞行中');
    }
    d.flight.event=event('canceled');
    expect(button(render(d),'立即执行任务')?.hasAttribute('disabled')).toBe(false);
  });
  it('keeps submitted and executing tasks tracked and directs users to the relevant platform',()=>{
    for(const state of ['ready','submitted','uncertain','paused','flight_error','flying'] as const) {
      const d=data();d.flight.event=event(state);
      const doc=parseHTML(renderToStaticMarkup(<DroneStatus data={d} ready started busy={false} action={async()=>true} onFlight={()=>{}} onAir={()=>{}}/>)).document;
      expect(button(doc,'归档提醒')).toBeUndefined();
      expect(button(doc,'暂不执行本次任务')).toBeUndefined();
      expect(button(doc,'重新发起任务')).toBeUndefined();
      const primary=doc.querySelector('.drone-actions > .drone-launch');
      expect(primary?.textContent).toBe(state==='ready'?'到司空确认起飞 ↗':'到司空核查任务 ↗');
    }
  });
  it('keeps one task link and hides unused actions for an uncertain flight', () => {
    const d = data(); d.flight.event = event('uncertain');
    const doc = parseHTML(renderToStaticMarkup(<MonitoringPanel data={d} ready started busy={false} action={async()=>true} onPrepare={()=>{}} onFlight={()=>{}} onAir={()=>{}} />)).document;
    const task = doc.querySelector('#monitoring-task-details')!;
    expect(task.textContent).toContain('查看任务 →');
    for (const label of ['查看任务详情', '查看实时监测', '核查后重新发起', '更多 ⋯']) expect(task.textContent).not.toContain(label);
    expect(button(doc, '刷新状态')).toBeDefined();
  });
  it('restores the ordinary launch entrance after FlightHub confirms weather blocked execution', () => {
    const d = data(); d.flight.event = { ...event('not_flown'), statusCheckedAt: now, error: '司空平台天气阻飞：在线天气风速 12.75m/s；未继续执行' };
    const doc = render(d);
    expect(doc.querySelector('.drone-status-copy')).toBeNull();
    expect(button(doc, '立即执行任务')?.hasAttribute('disabled')).toBe(false);
    expect(button(doc, '核查后重新发起')).toBeUndefined();
  });
});
