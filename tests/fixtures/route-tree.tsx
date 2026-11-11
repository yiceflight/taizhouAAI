// UI fixture only: no bridge calls or flight operations.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RouteSelect } from '../../src/components/RouteSelect';
import '../../src/App.css';
if (!import.meta.env.DEV) throw Error('Development only');
const routes = [
  {routeId:'a',name:'油烟排查航线',folderPath:[{id:'smoke',name:'油烟巡查'}]},
  {routeId:'b',name:'北沿江高铁航线',folderPath:[{id:'rail',name:'北沿江高铁航线'}]},
  ...['东侧火点巡查航线','西南侧火点巡查航线','东南侧火点巡查航线','正南侧火点巡查航线'].map((name,i)=>({routeId:`daily-${i}`,name,folderPath:[{id:'daily',name:'日常巡逻航线'}]})),
  {routeId:'c',name:'烟花航线',folderPath:[{id:'default',name:'默认文件夹'}]},
];
function Fixture() {
 const dialog=useRef<HTMLDialogElement>(null);
 const [value,setValue]=useState('日常巡逻航线 / 东侧火点巡查航线');
 useEffect(()=>{dialog.current?.showModal()},[]);
 return <dialog ref={dialog} style={{width:620,maxWidth:'calc(100vw - 48px)',padding:32,border:'1px solid #cbdcd1',borderRadius:12}}><h2>巡查航线</h2><p style={{margin:'16px 0',color:'#718175'}}>展开文件夹后选择航线</p><RouteSelect id="route" label="默认航线" routes={routes} value={value} placeholder="请选择航线" onValueChange={setValue}/><p style={{marginTop:24}}>已选：{value}</p></dialog>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
