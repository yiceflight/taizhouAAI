// UI only; does not invoke native commands or operate a drone.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WeatherPanel } from '../../src/components/WeatherPanel';
import type { WeatherView } from '../../src/lib/weather';
import '../../src/App.css';
if (!import.meta.env.DEV) throw Error('Development only');
const sample: WeatherView = {location:'泰州环境监测 Dock 3',latitude:32.434525,longitude:119.92992,source:'Open-Meteo',refreshing:false,allowed:true,level:'ok',label:'天气条件通过',reasons:['无降水，风速及阵风均低于 7 m/s。'],current:{observedAt:Date.now()/1000,fetchedAt:Date.now()/1000,temperature:22.3,weatherCode:0,windSpeed:2.38,windGusts:4.6,windDirection:100,precipitation:0}};
function Fixture() {
 const [mode,setMode]=useState('normal');
 const weather=mode==='missing'?undefined:mode==='rain'?{...sample,allowed:false,level:'unsafe' as const,label:'不宜起飞',reasons:['当前有降水，不满足无降水起飞条件。'],current:{...sample.current!,weatherCode:61,precipitation:.2}}:sample;
 return <main style={{maxWidth:960,margin:'24px auto',padding:20}}><p style={{marginBottom:20}}>天气 UI 场景验证 · 模拟数据 · 不操作无人机</p><select aria-label="天气场景" value={mode} onChange={e=>setMode(e.target.value)} style={{marginBottom:20}}><option value="normal">正常天气</option><option value="rain">下雨</option><option value="missing">暂无数据</option></select><WeatherPanel weather={weather} busy={false} onRefresh={()=>{}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
