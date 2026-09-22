export type Mission = { missionId:number; missionName:string; startTime:number; endTime:number; geoLocation:string };
export type Point = { time:number; pm25:number|null; longitude:number|null; latitude:number|null };
export type CollectedFlight = { mission:Mission; air:{ url:string;missionId:number;unit:string;points:Point[] }; media:{url:string;folder:string;files:string[]};photos:{name:string;dataUrl:string;kind:string}[] };
export type FlightSummary = { id:string;createdAt:number;title:string;path:string;photoCount:number;pointCount:number;warning:string };
export const beijingTime = (value:number) => new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function flightCharts(data:CollectedFlight):[string,string] {
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
    ctx.fillStyle='#55665f';ctx.textAlign='left';ctx.font='19px sans-serif';ctx.fillText(route?'横轴：经度  纵轴：纬度；平台原始坐标，无底图':'北京时间；缺测点断开；未对原始样本平滑或按小时重采样',left,590);
    return canvas.toDataURL('image/png');
  };
  return [chart(false),chart(true)];
}
