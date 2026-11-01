// Development-only UI fixture. No native calls, credentials or business requests.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import App from '../../src/App';
import { defaultSettings, type WorkspaceSettings } from '../../src/lib/workspace';
let settings = { ...defaultSettings };
import { targetSites } from '../../src/config/sites';
if (!import.meta.env.DEV) throw Error('UI fixtures must not run in a production build');
Object.assign(globalThis, { isTauri: true });
let scenario = 'missing';
let started = false;
const tabs = targetSites.map((s,i) => ({session:'fixture',id:i+1,title:s.name,url:s.url,status:'complete'}));
const getReadiness = () => ({
  pluginReady: scenario !== 'missing', pluginMessage: scenario === 'missing' ? '尚未连接插件。请安装或启用插件，并保持 Chrome 运行。' : '插件已连接，版本兼容', checking: false, started,
  ready: !['missing','login'].includes(scenario),
  sites: targetSites.map((s,i) => ({id:s.id,state:scenario === 'missing' ? 'blocked' : scenario === 'login' && i === 1 ? 'login_required' : 'ready',message:scenario === 'login' && i === 1 ? '登录已过期，请重新登录司空' : '登录有效，业务接口可读取',checkedAt:'2026-09-22 18:00:00',session:'fixture',tabId:i+1,url:s.url})),
});
let enabled = true;
let flightEvent: any = null;
let flightRecords: any[] = [];
const fixtureRoutes = [{ routeId: 'fixture-north', name: '北侧巡查航线 · 模拟' }, { routeId: 'fixture-southeast', name: '东南侧巡查航线 · 模拟' }];
const now = new Date(); now.setMinutes(0,0,0);
const date = (time:number) => new Date(time+8*3600000).toISOString().slice(0,19).replace('T',' ');
const getMonitor = () => ({settings,enabled,syncing:false,lastAttempt:date(Date.now()),lastSuccess:date(Date.now()),error:null,total:168,queryThrough:date(now.getTime()),
  rows: Array.from({length:168},(_,i)=>({time:date(now.getTime() - (i+(scenario==='stale'?8:0))*3600000),potassium: i===0 && scenario==='stale' ? null : 0.32+(Math.sin(i)*0.12),pm25:33+Math.round(Math.cos(i)*10)})),
  weather:{location:'泰州环境监测 Dock 3',latitude:32.43,longitude:119.93,source:'测试天气',refreshing:false,allowed:true,level:'ok',label:'天气条件通过',reasons:['模拟天气'],current:{observedAt:Date.now()/1000,fetchedAt:Date.now()/1000,temperature:22,weatherCode:0,windSpeed:2,windGusts:3,windDirection:90,precipitation:0}},
  flight:{threshold:settings.potassiumThreshold,delayMinutes:settings.takeoffDelayMinutes,event:flightEvent,records:flightRecords,routes:fixtureRoutes,selectedRoute:fixtureRoutes[0].name,routesSyncedAt:now.getTime()},
});
mockIPC(async (command, payload) => {
  if(command==='diagnose_bridge')return {
    checkedAt:new Date().toISOString(),appVersion:'0.2.4',platform:'windows',channel:'正式版',address:'127.0.0.1:14520',
    extensionId:'knpgppgofegbnimjoahnifpmhgmgnicf',minimumExtensionVersion:'0.7.14',
    checks:[
      {id:'files',label:'随 App 附带的插件目录',state:'pass',detail:'目录和入口文件可读取：D:\\江苏省泰州环境监测中心智能监测系统\\extension',suggestion:'此项不能确认 Chrome 实际加载的是这个目录。'},
      {id:'tcp',label:'本机端口',state:'pass',detail:'127.0.0.1:14520 TCP 连接成功',suggestion:''},
      {id:'service',label:'当前客户端服务',state:'pass',detail:'当前 App 的本机服务回应正常，身份核对通过',suggestion:''},
      {id:'plugin',label:'浏览器插件心跳',state:scenario==='missing'?'warning':'pass',detail:scenario==='missing'?'未收到有效插件心跳，无法据此判断插件是否已安装':'收到插件 v0.7.14 的有效心跳；网站登录状态请查看网站验证',suggestion:scenario==='missing'?'若本机服务通过：打开 Chrome 扩展管理页，确认插件已启用、ID 与下方一致，并重新加载当前 App 提供的插件目录；查看插件的“错误”和 Service Worker。App 内的端口检测不能证明 Chrome 到 App 的请求未被拦截。':''},
    ],
  };
  if(command==='get_bridge_status')return {connected:scenario!=='missing',clients:scenario==='missing'?0:1,versions:['0.7.0'],tabs,error:null};
  if(command==='get_readiness'||command==='check_readiness')return getReadiness();
  if(command==='get_monitoring')return getMonitor();
  if(command==='refresh_flight_status'){
    if(flightEvent?.id!==payload?.eventId)throw Error('任务已变化');
    flightRecords=[{...flightEvent,statusCheckedAt:Date.now(),statusCheckError:'司空列表未识别到该任务状态。已手动刷新并解除本地任务占用，原起飞结果仍未确认。'},...flightRecords];
    flightEvent=null;
    return;
  }
  if(command==='cancel_flight'){if(flightEvent?.id!==payload?.eventId)throw Error('任务已变化');flightEvent={...flightEvent,status:'canceled',launchAt:null};return;}
  if(command==='launch_flight'){flightEvent={id:'fixture-manual',observedAt:date(now.getTime()),potassium:null,name:'手动巡查 · UI 模拟',status:'submitted',error:null,preview:false,source:'manual',launchAt:null};return;}
  if(command==='resolve_flight'){flightEvent={...flightEvent,status:'dismissed'};return;}
  if(command==='refresh_weather')return;
  if(command==='save_workspace_settings'){settings=payload?.settings as WorkspaceSettings;return;}
  if(command==='get_extension_directory')return {path:'/UI-TEST/extension',platform:'macos'};
  if(command==='plugin:app|version')return '0.2.0';
  if(command==='list_reports')return [];
  if(command==='list_flight_reports')return [{id:'fixture-report',title:'场景示例 · 周山河巡飞',createdAt:Date.now()-3600000,photoCount:2,pointCount:1246,warning:'PM2.5 全部为 0，请核查传感器'}];
  if(command==='start_workspace'){if(!getReadiness().ready)throw Error('网站未通过验证'); started=true;return;}
  if(command==='set_monitoring_enabled'){enabled=!!payload?.enabled;return;}
  if(command==='list_flight_missions')return {missions:[{missionId:1,missionName:'示例已结束任务',startTime:Date.now()-7200000,endTime:Date.now()-3600000,geoLocation:'泰州'}],total:1};
  if(command==='open_business_site')return;
  throw Error(`UI 场景测试不执行操作：${command}`);
});
const controls=document.getElementById('fixture-controls')!;
controls.style.cssText='height:40px;background:#392f55;color:white;display:flex;align-items:center;gap:14px;padding:0 18px;font:13px sans-serif';
controls.innerHTML='<strong>UI 场景测试 · 模拟数据，非真实运行状态</strong><label>场景 <select aria-label="测试场景" style="width:180px;padding:3px"><option value="missing">插件未连接</option><option value="login">司空登录失效</option><option value="ready">全部验证通过</option><option value="normal">正常监测</option><option value="stale">旧数据与暂无数据</option><option value="task">待人工确认</option><option value="countdown">自动起飞倒计时</option><option value="uncertain">提交结果待核查</option></select></label>';
const root=createRoot(document.getElementById('root')!);
function render(){root.render(<App key={scenario}/>);}
controls.querySelector('select')!.addEventListener('change',e=>{scenario=(e.target as HTMLSelectElement).value;started=['normal','stale','task','countdown','uncertain'].includes(scenario);
  flightEvent=['task','countdown','uncertain'].includes(scenario)?{id:'fixture-event',observedAt:date(now.getTime()),potassium:1.2,name:'演示巡查任务',status:scenario==='task'?'ready':scenario,error:null,preview:scenario==='task',source:'auto',launchAt:scenario==='countdown'?Date.now()+180000:null}:null;
  if(scenario==='countdown')settings={...settings,takeoffDelayMinutes:3,requireManualConfirmation:false};
  render();});
const style=document.createElement('style');style.textContent='.app-shell{height:calc(100dvh - 40px)}';document.head.append(style);
render();
