import type { WeatherCheck } from './weather';
export type Mission = { missionId:number; missionName:string; startTime:number; endTime:number; geoLocation:string };
export type Point = { time:number; pm25:number|null; longitude:number|null; latitude:number|null };
export type CollectedFlight = { dataGeneration?: number; withoutAirData?:boolean; localEventId?:string|null; mission:Mission; air:{ url:string;missionId:number;unit:string;points:Point[];chart?:{map?:{method:string;missionId:number;dataUrl:string;originalDataUrl:string;width:number;height:number}|null;method:string;sourceChannel:string;missionId:number;startTime:number;endTime:number;pointCount:number;maximum:number;minimum:number;capturedAt:number;width:number;height:number;dataUrl:string}|null;channels?:Record<string,{sourceChannel:string;unit:string;values:(number|null)[]}> }; media:{url:string;folder:string;files:string[]};photos:{name:string;dataUrl:string;kind:string;presentation?:{method:string;width:number;height:number;imageRect?:{x:number;y:number;width:number;height:number};annotationCount:number;labels:string[];capturedAt:number;dataUrl:string|null}|null}[] };
export type FlightSummary = { withoutAirData?:boolean; localEventId?:string|null; id:string;createdAt:number;title:string;path:string;photoCount:number;issueCount?:number|null;pointCount:number;warning:string;mission?:Mission|null;airUrl?:string;mediaUrl?:string };
export type FlightTime = { startTime: number; endTime: number; durationMs: number; source: 'dji-plan'; precision: 'minute' };
export type LocalFlightEvent = { id:string; observedAt:string; name:string; status:string; source?:string; potassium?:number|null; pm25?:number|null; route?:string|null; error?:string|null; launchAt?:number|null; statusCheckError?:string|null; statusCheckedAt?:number|null; weatherOverrideConfirmedAt?:number|null; weatherChecks?: WeatherCheck[]; resolvedAt?: number | null; flightTime?: FlightTime | null };

export type DjiTask = { mission: Mission; status: string; mediaReady: boolean; noMedia?: boolean; taskId?: string; mediaFolderId?: number | null; mediaUploadedCount?: number; mediaExpectedCount?: number; plannedStartTime?: number; actualTimeMissing?: boolean; taskType?: string; routeName?: string; partialReason?: string };
export const flightKey = (mission: Mission) => `flight-${mission.startTime}-${mission.endTime}-${mission.missionName}`;
export type PatrolTask = { key: string; mission: Mission | null; report: FlightSummary | null; localEvent?: LocalFlightEvent; djiTask?: DjiTask };
const shanghaiDay = (value: number) => value > 0 && Number.isFinite(value)
  ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
  : '';
function patrolTaskDay(task: PatrolTask): string {
  const start = task.djiTask?.mission.startTime || task.djiTask?.plannedStartTime || task.mission?.startTime || task.report?.mission?.startTime || 0;
  if (start > 0) return shanghaiDay(start);
  const observed = task.localEvent ? Date.parse(`${task.localEvent.observedAt.replace(' ', 'T')}+08:00`) : NaN;
  return Number.isFinite(observed) ? shanghaiDay(observed) : '';
}
/** Automatic report generation is limited to executions on today's Beijing date. */
export function isTodayPatrolTask(task: PatrolTask, now = Date.now()): boolean {
  const today = shanghaiDay(now);
  return !!today && patrolTaskDay(task) === today;
}
export function visibleReportTasks(tasks: PatrolTask[], djiTasks: DjiTask[] = []): PatrolTask[] {
  const withoutFailed = tasks.filter(task => task.djiTask?.status !== '执行失败');
  // Once司空 has returned records for a Beijing calendar day, that day's
  // task set is authoritative. Airins history and local receipts can contain
  // nearby/generated rows for the same flight; keeping them would inflate the
  // count and show records absent from the platform list.
  const authoritativeDays = new Set(djiTasks.map(task => shanghaiDay(task.mission.startTime || task.plannedStartTime || 0)).filter(Boolean));
  if (!authoritativeDays.size) return withoutFailed;
  return withoutFailed.filter(task => task.djiTask || !authoritativeDays.has(patrolTaskDay(task)));
}
export const AIRINS_HISTORY_URL = 'https://aai.airins.cn/sniff/HistoryCloud';
export const DJI_MEDIA_URL = 'https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/media';
export const DJI_PLAN_URL = DJI_MEDIA_URL.replace('#/media', '#/plan');
export function djiMediaFolderUrl(folderId?: number | null): string {
  return typeof folderId === 'number' && Number.isSafeInteger(folderId) && folderId > 0
    ? `${DJI_MEDIA_URL}?page=1&size=50&pid=${folderId}`
    : DJI_MEDIA_URL;
}
export function airinsMissionUrl(mission: Mission): string {
  return `${AIRINS_HISTORY_URL}?missionId=${encodeURIComponent(mission.missionId)}`;
}
export function missionOriginLabel(mission: Pick<Mission, 'missionName'>): string {
  if (/^(?:钾离子超标巡查|PM2\.5超标巡查)-\d{8}-\d{2}$/.test(mission.missionName)) return '本应用 · 自动巡查';
  if (/^手动巡查-\d{8}-\d{2}-[a-f0-9]{8}$/.test(mission.missionName)) return '本应用 · 手动起飞';
  if (/^司空填写演练-\d{8}-\d{2}$/.test(mission.missionName)) return '本应用 · 填写演练';
  return '司空平台任务';
}
export function localFlightOriginLabel(event: LocalFlightEvent): string {
  if (event.source === 'auto') return '本应用 · 自动巡查';
  if (event.source === 'preview') return '本应用 · 填写演练';
  if (event.source === 'manual') return '本应用 · 手动起飞';
  const label = missionOriginLabel({ missionName: event.name });
  return label === '司空平台任务' ? '本应用 · 手动起飞' : label;
}
export function localFlightDisplay(event: LocalFlightEvent): { label: string; action: string; submitted: boolean } {
  const submitted = ['submitting', 'submitted', 'uncertain', 'flying', 'paused', 'completed', 'flight_error'].includes(event.status);
  const states: Record<string, [string, string]> = {
    countdown: ['等待起飞检查', '等待倒计时结束'],
    preparing: event.source === 'preview' ? ['正在演练填写', '仅演练 · 不提交起飞'] : ['正在准备起飞', '等待起飞前检查'],
    ready: event.source === 'preview' ? ['填写演练已就绪', '仅演练 · 不提交起飞'] : ['待人工确认', '请到司空确认计划'],
    submitting: ['正在提交起飞请求', '等待司空回执'],
    submitted: ['起飞请求已提交', '等待司空确认执行'],
    flying: ['正在执飞', '等待飞行结束'],
    completed: ['飞行已结束', '未关联可飞采样任务'],
    flight_error: ['执飞异常', '请到司空核查飞行记录'],
    paused: ['任务暂停', '请到司空核查任务'],
    uncertain: ['结果待核查', '请到司空核查 · 不自动重试'],
    not_flown: ['未起飞 · 司空天气阻飞', '请到司空确认，可切换 Chrome 页面'],
    failed: ['起飞未完成 · 待人工核验', event.source === 'auto' ? '未起飞 · 新小时数据到达后重新判断' : '未起飞 · 可手动重新发起'],
    restricted: ['禁飞时间 · 仅记录', '未执行起飞'],
    canceled: ['已取消', '本次任务已取消'],
  };
  const [label, action] = states[event.status] ?? ['任务状态待核查', '请核查任务状态'];
  return { label: event.resolvedAt ? `已结束处理 · 原状态：${label}` : label, action: event.resolvedAt ? '已保留任务记录' : action, submitted };
}
// FlightHub execution and Airins sampling are independent records. A missing
// Airins match does not negate the flight receipt or supply actual flight times.
export function localFlightMission(event: LocalFlightEvent): Mission | null {
  const time = event.flightTime;
  if (event.status !== 'completed' || !time || time.source !== 'dji-plan' || time.precision !== 'minute'
    || !Number.isFinite(time.startTime) || !Number.isFinite(time.endTime) || time.startTime <= 0
    || time.durationMs <= 0 || time.durationMs >= 86400000 || time.endTime - time.startTime !== time.durationMs) return null;
  return { missionId: 0, missionName: event.name, startTime: time.startTime, endTime: time.endTime, geoLocation: '' };
}
export const flightMinuteTime = (value: number) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export function localFlightTimeDisplay(event: LocalFlightEvent): { label: string; detail: string } {
  const mission = localFlightMission(event);
  if (mission) return { label: `${flightMinuteTime(mission.startTime)} 至 ${flightMinuteTime(mission.endTime)}`, detail: `司空实际时间 · 执行时长 ${event.flightTime!.durationMs / 60000} 分钟（分钟精度）` };
  const confirmed: Record<string, string> = {
    completed: '司空已确认飞行结束',
    flying: '司空已确认正在执飞',
    paused: '司空任务已暂停',
    flight_error: '司空执行异常，请核查飞行记录',
  };
  if (confirmed[event.status]) return { label: '实际飞行时间待补全', detail: confirmed[event.status] };
  if (['submitting', 'submitted', 'uncertain'].includes(event.status)) {
    return { label: '飞行结果待核查', detail: '尚未取得实际飞行起止时间' };
  }
  return { label: '尚无飞行记录', detail: '' };
}
export function patrolTasks(missions: Mission[], reports: FlightSummary[], localEvent?: LocalFlightEvent | null, records: LocalFlightEvent[] = [], clearedAt = 0, djiTasks: DjiTask[] = []): PatrolTask[] {
  const tasks = new Map<string, PatrolTask>();
  const nearStart = (a: Mission, b: Mission) => a.startTime > 0 && b.startTime > 0
    && Math.abs(a.startTime - b.startTime) <= 300000;
  const nearTime = (a: Mission, b: Mission) => nearStart(a, b) && a.endTime > a.startTime && b.endTime > b.startTime
    && Math.abs(a.endTime - b.endTime) <= 300000;
  // Airins and FlightHub do not always stop their clocks at the same point:
  // the records in the live pages can share a takeoff minute while their end
  // times differ by several minutes. Prefer a complete window match, then use
  // a unique start-time match. Never use this fallback when another execution
  // has the same start window, because that would attach the sampling link to
  // the wrong flight.
  const executionMatches = (targets: PatrolTask[], mission: Mission) => {
    const candidates = targets.filter(task => task.mission && nearStart(task.mission, mission));
    const complete = candidates.filter(task => nearTime(task.mission!, mission));
    return (complete.length === 1 ? complete : candidates).filter(task =>
      djiTasks.filter(t => nearStart(t.mission, task.mission!)).length === 1,
    );
  };
  // A DJI execution is an identity, not a fuzzy match to another DJI execution.
  djiTasks = [...new Map(djiTasks.filter(t => (t.mission.startTime || t.plannedStartTime || 0) > clearedAt).map(t => [t.taskId ? `dji-${t.taskId}` : flightKey(t.mission), t])).values()];
  if (clearedAt > 0) {
    missions = missions.filter(mission => mission.startTime > clearedAt);
    reports = reports.filter(report => report.createdAt > clearedAt && (!report.mission || report.mission.startTime > clearedAt));
  }
  for (const report of [...reports].sort((a, b) => b.createdAt - a.createdAt)) {
    const key = report.mission?.missionId ? `mission-${report.mission.missionId}` : report.localEventId ? `event-${report.localEventId}` : report.mission ? flightKey(report.mission) : `report-${report.id}`;
    if (!tasks.has(key)) tasks.set(key, { key, mission: report.mission ?? null, report });
  }
  for (const mission of missions) {
    const key = `mission-${mission.missionId}`;
    const aliases = [...tasks.values()].filter(task => task.mission && !task.mission.missionId && nearStart(task.mission, mission)
      && missions.filter(m => nearStart(m, task.mission!)).length === 1
      && djiTasks.filter(t => nearStart(t.mission, mission)).length <= 1);
    const linked = aliases.length === 1 ? aliases[0] : null;
    if (linked) tasks.delete(linked.key);
    tasks.set(key, { key, mission, report: tasks.get(key)?.report ?? linked?.report ?? null });
  }
  const associationTargets = [...tasks.values()];
  for (const djiTask of djiTasks) {
    const mission = djiTask.mission;
    if ((mission.startTime || djiTask.plannedStartTime || 0) <= clearedAt) continue;
    // Airins may return a generated timestamp as the mission name. Keep the
    // Airins ID/location for the link, but use a unique execution-time match
    // so nearby executions remain separate.
    const matches = executionMatches(associationTargets, mission);
    if (matches.length === 1) {
      matches[0].djiTask = djiTask;
      // Keep Airins id/location for sampling links, but display and save the
      // authoritative DJI plan name.
      matches[0].mission = { ...matches[0].mission!, missionName: mission.missionName };
    }
    else {
      const key = djiTask.taskId ? `dji-${djiTask.taskId}` : flightKey(mission);
      tasks.set(key, { key, mission, report: tasks.get(key)?.report ?? null, djiTask });
    }
  }
  for (const event of [...records, ...(localEvent ? [localEvent] : [])]) {
    if (event.status === 'dismissed') continue;
    const linked = tasks.get(`event-${event.id}`);
    if (linked) {
      linked.localEvent = event;
      if (!linked.report && !linked.mission?.missionId) linked.mission = localFlightMission(event);
      continue;
    }
    const matches = [...tasks.values()].filter(task => task.mission?.missionName === event.name && (!event.flightTime || Math.abs(task.mission.startTime - event.flightTime.startTime) <= 300000));
    if (matches.length === 1) {
      matches[0].localEvent = event;
    } else {
      tasks.set(`event-${event.id}`, { key: `event-${event.id}`, mission: localFlightMission(event), report: null, localEvent: event });
    }
  }
  const start = (task: PatrolTask) => (task.mission?.startTime || task.djiTask?.plannedStartTime) ?? task.report?.createdAt ?? (task.localEvent ? Date.parse(`${task.localEvent.observedAt.replace(' ', 'T')}+08:00`) : 0);
  return [...tasks.values()].sort((a, b) => start(b) - start(a));
}

export const beijingTime = (value:number) => new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function flightCharts(data:CollectedFlight):[string,string] {
  if (data.withoutAirData) return ['', ''];
  const points = [...data.air.points].sort((a,b)=>a.time-b.time);
  const chart = (route:boolean) => {
    const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=610;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('无法绘制监测图表');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,1400,610);ctx.font='22px sans-serif';ctx.fillStyle='#1f302b';
    ctx.fillText(route?'可飞采样航迹':'PM2.5 采样序列（μg/m³）',90,40);
    const left=100,top=85,width=1200,height=420;
    let coordinates:({x:number;y:number;label:string}|null)[];
    if(route){coordinates=points.map(p=>p.longitude!==null && p.latitude!==null ? {x:p.longitude,y:p.latitude,label:beijingTime(p.time)}:null);}
    else{coordinates=points.map(p=>p.pm25===null?null:{x:p.time,y:p.pm25,label:beijingTime(p.time)});}
    const rows=coordinates;
    const valid=rows.filter((p):p is {x:number;y:number;label:string}=>p!==null && Number.isFinite(p.x)&&Number.isFinite(p.y));
    if(valid.length<2)throw new Error('缺少足够的监测点，无法绘图');
    let xmin=Math.min(...valid.map(p=>p.x)),xmax=Math.max(...valid.map(p=>p.x));
    let ymin=Math.min(...valid.map(p=>p.y)),ymax=Math.max(...valid.map(p=>p.y));
    if(route){
      const cx=(xmin+xmax)/2,cy=(ymin+ymax)/2,cos=Math.cos(cy*Math.PI/180);
      const dy=Math.max(ymax-ymin,(xmax-xmin)*cos/(width/height),0.0001)*1.15;
      const dx=dy*(width/height)/cos;xmin=cx-dx/2;xmax=cx+dx/2;ymin=cy-dy/2;ymax=cy+dy/2;
    }else{ymin=Math.max(0,ymin-(ymax-ymin)*0.1);ymax=Math.max(ymin+1,ymax+(ymax-ymin)*0.1);if(xmax===xmin)xmax=xmin+1000;}
    const x=(v:number)=>left+(v-xmin)/(xmax-xmin)*width,y=(v:number)=>top+height-(v-ymin)/(ymax-ymin)*height;
    ctx.lineWidth=1;ctx.font='20px sans-serif';
    for(let i=0;i<=4;i++){
      const yy=top+height*i/4;ctx.strokeStyle='#d9e2dd';ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(left+width,yy);ctx.stroke();ctx.fillStyle='#55665f';ctx.textAlign='right';ctx.fillText((ymax-(ymax-ymin)*i/4).toFixed(route?4:1),left-15,yy+7);
      const value=xmin+(xmax-xmin)*i/4;ctx.textAlign='center';ctx.fillText(route?value.toFixed(4):new Date(value).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),left+width*i/4,top+height+38);
    }
    ctx.lineWidth=3;ctx.strokeStyle='#15766b';ctx.beginPath();let connected=false;
    for(const p of rows){if(!p){connected=false;continue;}if(connected)ctx.lineTo(x(p.x),y(p.y));else ctx.moveTo(x(p.x),y(p.y));connected=true;}ctx.stroke();
    if(route){for(const [i,color,label] of [[0,'#167c55','起点'],[valid.length-1,'#b5433c','终点']] as const){const p=valid[i];ctx.fillStyle=color;ctx.beginPath();ctx.arc(x(p.x),y(p.y),7,0,2*Math.PI);ctx.fill();ctx.textAlign='left';ctx.fillText(label,x(p.x)+10,y(p.y)+(i===0?28:-12));}}
    ctx.fillStyle='#55665f';ctx.textAlign='left';ctx.font='19px sans-serif';ctx.fillText(route?'横轴：经度  纵轴：纬度；平台原始坐标，无底图':'北京时间；暂无数据时断开；未对原始样本平滑或按小时重采样',left,590);
    return canvas.toDataURL('image/png');
  };
  return [chart(false),chart(true)];
}
