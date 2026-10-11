import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, it, expect } from 'vitest';
import { WeatherPanel } from '../src/components/WeatherPanel';
import { DroneStatus } from '../src/components/DroneStatus';
import { defaultSettings, type MonitorView } from '../src/lib/workspace';
import { weatherPasses, type WeatherView } from '../src/lib/weather';
const good = (): WeatherView => ({ location:'泰州环境监测 Dock 3', latitude:32.434525, longitude:119.92992, source:'Open-Meteo', refreshing:false, allowed:true, level:'ok', label:'天气条件通过', reasons:['无降水'], current:{observedAt:Date.now()/1000,fetchedAt:Date.now()/1000,temperature:0,weatherCode:0,windSpeed:0,windGusts:0,windDirection:0,precipitation:0} });
const doc = (element: React.ReactElement) => parseHTML(renderToStaticMarkup(element)).document;
const noop = () => {}; const action = async () => true;
const monitor = (weather?: WeatherView):MonitorView => ({weather,enabled:true,syncing:false,lastAttempt:null,lastSuccess:null,error:null,total:0,rows:[],queryThrough:null,settings:{...defaultSettings,noFlyPeriods:[]},flight:{enabled:false,threshold:1,event:null}});
describe('weather gates',()=>{
  it('preserves zero weather values and explains unknown weather',()=>{
    const d=doc(<WeatherPanel weather={good()} busy={false} onRefresh={noop}/>);
    expect(d.documentElement.textContent).toContain('0 °C');
    expect(d.documentElement.textContent).toContain('天气条件通过');
    expect(d.documentElement.textContent).toContain('达到 7 m/s 暂停并需人工确认');
    expect(d.documentElement.textContent).toContain('达到 12 m/s 禁止起飞');
    const missing=doc(<WeatherPanel busy={false} onRefresh={noop}/>);
    expect(missing.documentElement.textContent).toContain('暂无法判断');
    expect(missing.documentElement.textContent).not.toContain('天气条件通过');
  });
  it('keeps normal weather gates false and exposes explicit manual override on blocked weather',()=>{
    const safe=good();
    const stale={...safe,current:{...safe.current!,fetchedAt:Date.now()/1000-601}};
    expect(weatherPasses(safe)).toBe(true);
    for(const weather of [undefined,{...safe,allowed:false,level:'unsafe' as const},stale]) {
      expect(weatherPasses(weather)).toBe(false);
      const props={data:monitor(weather),ready:true,started:true,busy:false,action,onPrepare:noop,onFlight:noop};
      for(const ui of [<DroneStatus {...props}/>]) {
        const d=doc(ui);
        expect([...d.querySelectorAll('button')].find(b=>b.textContent==='立即执行任务')).toBeUndefined();
        const b=[...d.querySelectorAll('button')].find(b=>b.textContent==='手动强制起飞');
        expect(b?.hasAttribute('disabled')).toBe(false);
      }
    }
    const d=doc(<DroneStatus data={monitor(safe)} ready started busy={false} action={action} onFlight={noop}/>);
    expect([...d.querySelectorAll('button')].find(b=>b.textContent==='立即执行任务')?.hasAttribute('disabled')).toBe(false);
  });
});
