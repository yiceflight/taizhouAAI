import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, it, expect } from 'vitest';
import { WeatherPanel, WeatherStatus } from '../src/components/WeatherPanel';
import { DroneStatus } from '../src/components/DroneStatus';
import { defaultSettings, type MonitorView } from '../src/lib/workspace';
import { weatherPasses, type WeatherView } from '../src/lib/weather';
const good = (): WeatherView => ({ location:'泰州环境监测 Dock 3', latitude:32.434525, longitude:119.92992, source:'DJI FlightHub 2', refreshing:false, allowed:true, level:'ok', label:'天气条件通过', reasons:['无降水'], current:{observedAt:Date.now()/1000,fetchedAt:Date.now()/1000,temperature:0,weatherCode:0,windSpeed:0,windGusts:0,windDirection:0,precipitation:0} });
const doc = (element: React.ReactElement) => parseHTML(renderToStaticMarkup(element)).document;
const noop = () => {}; const action = async () => true;
const monitor = (weather?: WeatherView):MonitorView => ({weather,enabled:true,syncing:false,lastAttempt:null,lastSuccess:null,error:null,total:0,rows:[],queryThrough:null,settings:{...defaultSettings,noFlyPeriods:[]},flight:{enabled:false,threshold:1,event:null}});
describe('weather gates',()=>{
  it('preserves zero weather values and explains unknown weather',()=>{
    const d=doc(<WeatherPanel weather={good()} busy={false} onRefresh={noop}/>);
    expect(d.documentElement.textContent).toContain('0 °C');
    expect(d.documentElement.textContent).toContain('天气条件通过');
    expect(d.documentElement.textContent).toContain('适飞结论采用司空当前项目的天气判定');
    expect(d.documentElement.textContent).not.toContain('12 m/s');
    const missing=doc(<WeatherPanel busy={false} onRefresh={noop}/>);
    expect(missing.documentElement.textContent).toContain('暂无法判断');
    expect(missing.documentElement.textContent).not.toContain('天气条件通过');
  });
  it('blocks launches for missing, unsafe, and stale platform weather',()=>{
    const safe=good();
    const stale={...safe,current:{...safe.current!,fetchedAt:Date.now()/1000-601}};
    expect(weatherPasses(safe)).toBe(true);
    for(const weather of [undefined,{...safe,allowed:false,level:'unsafe' as const},stale]) {
      expect(weatherPasses(weather)).toBe(false);
      const props={data:monitor(weather),ready:true,started:true,busy:false,action,onPrepare:noop,onFlight:noop};
      for(const ui of [<DroneStatus {...props}/>]) {
        const d=doc(ui);
        expect([...d.querySelectorAll('button')].find(b=>b.textContent==='立即执行任务')).toBeUndefined();
        const b=[...d.querySelectorAll('button')].find(b=>b.textContent==='司空气象未通过');
        expect(b?.hasAttribute('disabled')).toBe(true);
      }
    }
    const d=doc(<DroneStatus data={monitor(safe)} ready started busy={false} action={action} onFlight={noop}/>);
    expect([...d.querySelectorAll('button')].find(b=>b.textContent==='立即执行任务')?.hasAttribute('disabled')).toBe(false);
  });
});

describe('weather status explanation', () => {
  const blocked = (): WeatherView => ({ ...good(), allowed: false, level: 'unsafe', label: '无法飞行', reasons: ['预测飞行风速：12.1 m/s'], current: { ...good().current!, items: [
    { key: 'windSpeed', label: '机场实测风速', value: '0 m/s', level: 1 },
    { key: 'windSpeedOnline', label: '预测飞行风速', value: '12.1 m/s', level: 3 },
  ] } });
  const trigger = (weather?: WeatherView) => doc(<WeatherStatus weather={weather} busy={false} onRefresh={noop}/>).querySelector('.weather-status-trigger')!;
  it('explains blocked flight with forecast wind instead of reassuring measured wind', () => {
    const weather = blocked();
    expect(trigger(weather).textContent).toContain('无法飞行');
    expect(trigger(weather).textContent).toContain('预测飞行风速：12.1 m/s');
    expect(trigger(weather).textContent).not.toContain('0 m/s');
    const panel = doc(<WeatherPanel weather={weather} busy={false} onRefresh={noop}/>);
    expect(panel.querySelector('[aria-label="机场实测"]')?.textContent).toContain('0 m/s');
    expect(panel.querySelector('[aria-label="司空预报"] .weather-metric-alert')?.textContent).toContain('12.1 m/s');
  });
  it('ranks platform severity and counts additional reasons without duplicates', () => {
    const weather = blocked();
    weather.current!.items!.unshift({ key: 'rainfallOnline', label: '短时雨量', value: '小雨', level: 2 });
    weather.reasons.unshift('短时雨量：小雨');
    expect(trigger(weather).querySelector('.weather-status-reason')?.textContent).toBe('预测飞行风速：12.1 m/s');
    expect(trigger(weather).textContent).toContain('另 1 项');
  });
  it('shows ordinary weather only for a fresh passing verdict', () => {
    expect(trigger(good()).textContent).toContain('晴 · 0 °C · 实测风速 0 m/s');
    const weather = blocked();
    weather.level = 'caution'; weather.label = '不宜飞行';
    weather.current!.items![1].level = 2;
    expect(trigger(weather).textContent).toContain('不宜飞行');
    expect(trigger(weather).textContent).toContain('预测飞行风速');
  });
  it('prioritizes unavailable, refreshing and expired data over cached metrics', () => {
    const weather = blocked();
    const failed = { ...weather, level: 'unknown' as const, reasons: ['司空登录已失效，请重新登录。'] };
    expect(trigger(failed).textContent).toContain('司空登录已失效');
    expect(trigger(failed).textContent).not.toContain('12.1');
    expect(trigger({ ...weather, refreshing: true }).textContent).toContain('正在更新天气');
    for (const sample of [good(), blocked()]) {
      sample.current!.fetchedAt -= 601;
      expect(trigger(sample).textContent).toContain('天气已过期');
      expect(trigger(sample).textContent).not.toContain('m/s');
    }
    expect(trigger().textContent).toContain('等待司空气象数据');
  });
});
