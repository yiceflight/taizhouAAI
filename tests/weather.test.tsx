import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, it, expect } from 'vitest';
import { WeatherPanel, WeatherStatus } from '../src/components/WeatherPanel';
import { DroneStatus } from '../src/components/DroneStatus';
import { defaultSettings, type MonitorView } from '../src/lib/workspace';
import { weatherPasses, forecastWindLabel, type WeatherView } from '../src/lib/weather';
const good = (): WeatherView => ({ location:'泰州环境监测 Dock 3', latitude:32.434525, longitude:119.92992, source:'DJI FlightHub 2', refreshing:false, allowed:true, level:'ok', label:'天气条件通过', reasons:['无降水'], current:{observedAt:Date.now()/1000,fetchedAt:Date.now()/1000,temperature:0,weatherCode:0,windSpeed:0,windGusts:0,windDirection:0,precipitation:0} });
const doc = (element: React.ReactElement) => parseHTML(renderToStaticMarkup(element)).document;
const noop = () => {}; const action = async () => true;
const monitor = (weather?: WeatherView):MonitorView => ({weather,enabled:true,syncing:false,lastAttempt:null,lastSuccess:null,error:null,total:0,rows:[],queryThrough:null,settings:{...defaultSettings,noFlyPeriods:[]},flight:{threshold:1,event:null,selectedRoute:'测试航线'}});
describe('weather gates',()=>{
  it('keeps successful data usable for 30 minutes and rejects it after expiry', () => {
    const weather = good(), now = Date.now()/1000;
    weather.current!.fetchedAt = now - 1799;
    weather.current!.observedAt = now - 1919; // Accepted telemetry can start 2 minutes old.
    expect(weatherPasses(weather)).toBe(true);
    const panel = doc(<WeatherPanel weather={weather} busy={false} onRefresh={noop}/>);
    expect(panel.querySelector('section')?.textContent).toContain('每 5 分钟更新');
    expect(panel.querySelector('section')?.textContent).toContain('数据有效期 30 分钟');
    weather.current!.fetchedAt = now - 1801;
    expect(weatherPasses(weather)).toBe(false);
    expect(doc(<WeatherPanel weather={weather} busy={false} onRefresh={noop}/>).querySelector('section')?.textContent).toContain('天气已过期');
  });

  it('shows the eight-sector direction under forecast only and marks stale or missing data', () => {
    const weather = good();
    const now = Date.now()/1000;
    weather.current!.forecast = {observedAt:now-60,condition:'晴',temperature:22,humidity:80,precipitation:0};
    weather.current!.windDirection = 66;
    const panel = doc(<WeatherPanel weather={weather} busy={false} onRefresh={noop}/>);
    expect(panel.querySelector('[aria-label="司空预报"]')?.textContent).toContain('预报风向东北风');
    expect(panel.querySelector('[aria-label="机场实测"]')?.textContent).not.toContain('风向');
    expect(forecastWindLabel(weather,now)).toBe('东北风');
    expect(forecastWindLabel({...weather,level:'unknown'},now)).toBe('暂不可用');
    weather.current!.forecast.observedAt = now-3601;
    expect(forecastWindLabel(weather,now)).toBe('已过期');
    weather.current!.windDirection = null;
    expect(forecastWindLabel(weather,now)).toBe('未取得');
  });
  it('preserves zero weather values and explains unknown weather',()=>{
    const d=doc(<WeatherPanel weather={good()} busy={false} onRefresh={noop}/>);
    expect(d.documentElement.textContent).toContain('0 °C');
    expect(d.documentElement.textContent).toContain('天气条件通过');
    expect(d.documentElement.textContent).toContain('是否允许起飞由大疆后台决定');
    expect(d.documentElement.textContent).not.toContain('12 m/s');
    const missing=doc(<WeatherPanel busy={false} onRefresh={noop}/>);
    expect(missing.documentElement.textContent).toContain('暂无天气数据');
    expect(missing.documentElement.textContent).not.toContain('天气条件通过');
  });
  it('keeps task entry available for unsafe, missing or stale weather',()=>{
    const safe=good();
    const stale={...safe,current:{...safe.current!,fetchedAt:Date.now()/1000-1801}};
    expect(weatherPasses(safe)).toBe(true);
    for(const weather of [undefined,{...safe,allowed:false,level:'unsafe' as const},stale]) {
      expect(weatherPasses(weather)).toBe(false);
      const props={data:monitor(weather),ready:true,started:true,busy:false,action,onPrepare:noop,onFlight:noop};
      for(const ui of [<DroneStatus {...props}/>]) {
        const d=doc(ui);
        expect([...d.querySelectorAll('button')].find(b=>b.textContent==='立即执行任务')?.hasAttribute('disabled')).toBe(false);
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
  it('keeps cached metrics visible while refreshing and explains unavailable or expired data', () => {
    const weather = blocked();
    const failed = { ...weather, level: 'unknown' as const, reasons: ['司空登录已失效，请重新登录。'] };
    expect(trigger(failed).textContent).toContain('司空登录已失效');
    expect(trigger(failed).textContent).not.toContain('12.1');
    const refreshing = trigger({ ...weather, refreshing: true });
    expect(refreshing.textContent).toContain('无法飞行');
    expect(refreshing.textContent).toContain('正在更新天气');
    expect(refreshing.textContent).toContain('预测飞行风速：12.1 m/s');
    const refreshingSafe = trigger({ ...good(), refreshing: true });
    expect(refreshingSafe.textContent).toContain('天气条件通过');
    expect(refreshingSafe.textContent).toContain('晴 · 0 °C · 实测风速 0 m/s');
    for (const sample of [good(), blocked()]) {
      sample.current!.fetchedAt -= 1801;
      expect(trigger(sample).textContent).toContain('天气已过期');
      expect(trigger(sample).textContent).not.toContain('m/s');
    }
    expect(trigger().textContent).toContain('暂无天气数据，将自动获取');
    const missing = { ...good(), current: null, level: 'unknown' as const, reasons: ['测试版插件未连接，请加载开发版插件。'] };
    expect(trigger(missing).textContent).not.toContain('插件未连接');
    expect(trigger({ ...missing, refreshing: true }).textContent).toContain('正在向司空获取最新天气');
  });
});
