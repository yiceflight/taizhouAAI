// UI only; does not invoke native commands or operate a drone.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WeatherStatus } from '../../src/components/WeatherPanel';
import type { WeatherView } from '../../src/lib/weather';
import '../../src/App.css';
if (!import.meta.env.DEV) throw Error('Development only');
const sample = (): WeatherView => ({location:'泰州环境监测 Dock 3',latitude:32.434525,longitude:119.92992,source:'DJI FlightHub 2',refreshing:false,allowed:true,level:'ok',label:'适合飞行',reasons:['司空判定：适合飞行'],current:{observedAt:Date.now()/1000,fetchedAt:Date.now()/1000,temperature:26.2,weatherCode:0,windSpeed:0,windGusts:null,windDirection:null,precipitation:0,forecast:{observedAt:Date.now()/1000,condition:'晴',temperature:22,humidity:48,precipitation:0},items:[{key:'windSpeed',label:'机场实测风速',value:'0 m/s',level:1},{key:'rainfall',label:'机场实测降雨',value:'无降雨',level:1},{key:'windSpeedOnline',label:'预测飞行风速',value:'3.1 m/s',level:1},{key:'rainfallOnline',label:'短时雨量',value:'无降雨',level:1}]}});
function Fixture() {
 const [mode,setMode]=useState('wind');
 let weather: WeatherView | undefined = sample();
 if (['wind','multiple','caution'].includes(mode)) {
   weather.allowed=false; weather.level=mode==='caution'?'caution':'unsafe'; weather.label=mode==='caution'?'不宜飞行':'无法飞行';
   weather.current!.items![2]={key:'windSpeedOnline',label:'预测飞行风速',value:mode==='caution'?'8.1 m/s':'12.1 m/s',level:mode==='caution'?2:3};
   weather.reasons=[`预测飞行风速：${weather.current!.items![2].value}`];
   if(mode==='multiple') { weather.current!.items![3]={key:'rainfallOnline',label:'短时雨量',value:'小雨',level:2}; weather.reasons.unshift('短时雨量：小雨'); }
 }
 if(mode==='expired') weather.current!.fetchedAt-=601;
 if(mode==='refreshing') weather.refreshing=true;
 if(mode==='error') {weather.allowed=false;weather.level='unknown';weather.reasons=['司空登录已失效，请重新登录后刷新天气。'];}
 if(mode==='missing') weather=undefined;
 return <main style={{padding:20}}><p style={{marginBottom:20}}>天气 UI 场景验证 · 模拟数据 · 不操作无人机</p><select aria-label="天气场景" value={mode} onChange={e=>setMode(e.target.value)} style={{marginBottom:20}}><option value="wind">预测风速阻飞</option><option value="multiple">多项异常</option><option value="caution">不宜飞行</option><option value="normal">适合飞行</option><option value="expired">已过期</option><option value="refreshing">更新中</option><option value="error">登录失效</option><option value="missing">暂无数据</option></select><header className="topbar"><div className="brand"><h1>江苏省泰州环境监测中心智能监测系统</h1></div><div className="topbar-status"><WeatherStatus weather={weather} busy={false} onRefresh={()=>{}}/><div className="drone-status drone-status-compact">无人机巡飞 · 待命</div></div></header></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
