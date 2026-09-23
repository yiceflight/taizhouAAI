import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, it, expect, vi } from 'vitest';
import { DroneStatus } from '../src/components/DroneStatus';
import { defaultSettings, flightSummary, type MonitorView, type FlightEvent } from '../src/lib/workspace';
const now = Date.now();
const data = (): MonitorView => ({ enabled:true, syncing:false, lastAttempt:null, lastSuccess:null, error:null, total:0, rows:[], queryThrough:null,
  settings:{...defaultSettings,requireManualConfirmation:false,takeoffDelayMinutes:5},
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
  it('prompts for manual action in chart red when fresh K+ exceeds the configured threshold',()=>{
    const d=reading(data(),0.9);d.flight.enabled=false;d.settings.requireManualConfirmation=true;
    const doc=render(d);
    expect(doc.querySelector('.drone-status-danger')).not.toBeNull();
    expect(doc.documentElement.textContent).toContain('K⁺ 超标 · 需要执行任务');
    expect(doc.documentElement.textContent).toContain('K⁺ 0.9 > 0.4 μg/m³');
    expect(button(doc,'执行任务')?.hasAttribute('disabled')).toBe(false);
    expect(button(render(d,false),'执行任务')?.hasAttribute('disabled')).toBe(true);
    d.weather!.allowed=false;
    expect(button(render(d),'执行任务')?.hasAttribute('disabled')).toBe(true);
    expect(flightSummary(d,true,now).detail).toContain('天气条件未通过');
  });
  it('does not trigger an exceedance reminder for equal, missing, expired, or future readings',()=>{
    for(const [k,age] of [[0.4,1],[0,1],[null,1],[0.9,4],[0.9,-1]] as const){
      const d=reading(data(),k,age);d.flight.enabled=false;
      expect(flightSummary(d,true,now).tone).not.toBe('danger');
      expect(button(render(d),'执行任务')).toBeUndefined();
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
    expect(button(render(d),'执行任务')).toBeUndefined();
    d.flight.event=event('submitted');
    expect(flightSummary(d,true,now).title).toContain('起飞请求已提交');
    expect(button(render(d),'执行任务')).toBeUndefined();
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
    expect(button(render(data()),'手动起飞')?.hasAttribute('disabled')).toBe(false);
    expect(button(render(data(),false),'手动起飞')?.hasAttribute('disabled')).toBe(true);
  });
  it('uses the persisted deadline and never invents a flying state at zero',()=>{
    const d=data();d.flight.event=event('countdown');
    expect(flightSummary(d,true,now).title).toContain('01:05 后起飞');
    expect(flightSummary(d,true,now+70000).title).toContain('等待起飞检查');
    expect(button(render(d),'取消任务')).toBeDefined();
    expect(button(render(d),'手动起飞')).toBeUndefined();
    d.settings.requireManualConfirmation=true;
    expect(flightSummary(d,true,now).title).toContain('等待准备');
  });
  it('permits cancellation during preparation but directs submitted and uncertain tasks to review',()=>{
    const d=data();d.flight.event=event('preparing');
    expect(button(render(d),'取消任务')).toBeDefined();
    for(const status of ['submitted','uncertain','submitting'] as const) {
      d.flight.event=event(status);const doc=render(d);
      expect(button(doc,'取消任务')).toBeUndefined();
      expect(button(doc,'手动起飞')).toBeUndefined();
      expect(button(doc,'查看任务')).toBeDefined();
      expect(doc.documentElement.textContent).not.toContain('飞行中');
    }
    d.flight.event=event('canceled');
    expect(button(render(d),'手动起飞')?.hasAttribute('disabled')).toBe(false);
  });
});
