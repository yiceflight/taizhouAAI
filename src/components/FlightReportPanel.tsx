import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {tabKey,type BrowserTab} from '../lib/workspace';
import {beijingTime,flightCharts,type Mission,type CollectedFlight,type FlightSummary} from '../lib/flightReport';
export function FlightReportPanel({tabs}:{tabs:BrowserTab[]}) {
 const [djiKey,setDjiKey]=useState(''),[airKey,setAirKey]=useState('');
 const [missions,setMissions]=useState<Mission[]>([]),[missionId,setMissionId]=useState('');
 const [total,setTotal]=useState(0),[loading,setLoading]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [reports,setReports]=useState<FlightSummary[]>([]),[preview,setPreview]=useState<CollectedFlight|null>(null),[charts,setCharts]=useState<[string,string]|null>(null);
 const lock=useRef(false);
 const dji=tabs.filter(t=>{try{const u=new URL(t.url);return u.origin==='https://fh.dji.com' && u.hash.startsWith('#/media');}catch{return false;}});
 const air=tabs.filter(t=>{try{const u=new URL(t.url);return u.origin==='https://aai.airins.cn' && u.pathname.startsWith('/sniff');}catch{return false;}});
 const selectedDji=dji.find(t=>tabKey(t)===djiKey),selectedAir=air.find(t=>tabKey(t)===airKey);
 const selected=missions.find(m=>String(m.missionId)===missionId);
 useEffect(()=>{if(isTauri())invoke<FlightSummary[]>('list_flight_reports').then(setReports).catch(e=>setError(String(e)));},[]);
 const load=async(more=false)=>{if(!selectedAir||lock.current)return;lock.current=true;setLoading(true);setError('');setPreview(null);setCharts(null);try{
   const result=await invoke<{missions:Mission[];total:number}>('list_flight_missions',{session:selectedAir.session,tabId:selectedAir.id,cursorId:more?missions[missions.length-1]?.missionId:null,cursorTime:more?missions[missions.length-1]?.startTime:null});setMissions(items=>more?[...items,...result.missions.filter(m=>!items.some(i=>i.missionId===m.missionId))]:result.missions);setTotal(result.total);if(!more)setMissionId('');if(more&&!result.missions.length)setTotal(missions.length);
 }catch(e){setError(String(e));}finally{lock.current=false;setLoading(false);}};
 const generate=async()=>{if(!selected||!selectedDji||!selectedAir||lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('正在读取完整 PM2.5 序列并逐张导出司空图片，请保持所选页面打开…');setPreview(null);setCharts(null);
 try{const data=await invoke<CollectedFlight>('collect_flight_report',{request:{djiSession:selectedDji.session,djiTabId:selectedDji.id,sniffSession:selectedAir.session,sniffTabId:selectedAir.id,mission:selected}});const images=flightCharts(data);setPreview(data);setCharts(images);setMessage('正在保存 Word 快报和原始资料…');const report=await invoke<FlightSummary>('save_flight_report',{data,charts:images});setReports(items=>[report,...items]);setMessage(`已保存 Word 快报：${report.photoCount} 张照片、${report.pointCount} 个采样点。${report.warning}`);
 }catch(e){setError(String(e));setMessage('');}finally{lock.current=false;setBusy(false);}};
 return <section className="flight-report-builder" aria-label="巡飞 Word 快报">
  <h3>巡飞 Word 快报</h3><p>飞行结束、资料上传完成后，选择可飞历史任务和对应的司空 Immediate-Media 文件夹。生成的 Word、照片与原始采样数据保存在本机，可随时重新生成。</p>
  <div className="flight-report-fields">
   <label>可飞页面<select value={selectedAir?airKey:''} disabled={busy||loading} onChange={e=>{setAirKey(e.target.value);setMissions([]);setMissionId('');setTotal(0);}}><option value="">选择已登录的可飞页面</option>{air.map(t=><option key={tabKey(t)} value={tabKey(t)}>{t.title} · {t.url}</option>)}</select></label>
   <button className="secondary-button" disabled={!selectedAir||busy||loading} onClick={()=>void load()}>{loading?'读取中…':'读取飞行任务'}</button>
   <label>已结束的飞行任务<select value={missionId} disabled={busy||loading} onChange={e=>setMissionId(e.target.value)}><option value="">请选择本次任务</option>{missions.map(m=><option key={m.missionId} value={m.missionId} disabled={m.endTime>Date.now()-60000}>{m.missionName} · {beijingTime(m.startTime)}</option>)}</select></label>
   {total>missions.length&&<button className="secondary-button" disabled={busy||loading} onClick={()=>void load(true)}>加载更早任务（已加载 {missions.length} / {total}）</button>}
   <label>司空媒体页<select value={selectedDji?djiKey:''} disabled={busy||loading} onChange={e=>setDjiKey(e.target.value)}><option value="">选择本次 Immediate-Media 文件夹所在页</option>{dji.map(t=><option key={tabKey(t)} value={tabKey(t)}>{t.title} · {t.url.split('#')[1]}</option>)}</select></label>
   <button className="primary-button" disabled={!selected||!selectedDji||!selectedAir||busy||loading} onClick={()=>void generate()}>{busy?'采集并生成中…':'生成 Word 快报'}</button>
  </div>
  {selected&&<p className="capture-help">{beijingTime(selected.startTime)} — {beijingTime(selected.endTime)} · {selected.geoLocation}</p>}
  {message&&<p role="status" className="capture-help">{message}</p>}{error&&<p role="alert" className="site-message">{error}</p>}
  {charts&&preview&&<details className="flight-preview"><summary>查看本次 PM2.5、航线和照片（{preview.photos.length} 张）</summary><img src={charts[0]} alt="本航次 PM2.5 采样曲线"/><img src={charts[1]} alt="本航次经纬度航迹"/>{preview.photos.map(p=><figure key={p.name}><img src={p.dataUrl} alt={p.name}/><figcaption>{p.name}</figcaption></figure>)}</details>}
  <div className="flight-history">{reports.length===0?<p className="muted">尚未生成巡飞 Word 快报</p>:reports.map(r=><article key={r.id}><div><strong>{r.title}</strong><p>{beijingTime(r.createdAt)} · {r.photoCount} 张照片 · {r.pointCount} 个采样点{r.warning&&` · ${r.warning}`}</p></div><button className="secondary-button" onClick={()=>void invoke('open_flight_report',{id:r.id}).catch(e=>setError(String(e)))}>打开 Word</button></article>)}</div>
 </section>;
}
