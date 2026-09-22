// Fixed, read-only report adapters. Never read cookies, tokens or storage.
export async function airinsReport(job) {
  if (location.origin !== 'https://aai.airins.cn' || !location.pathname.startsWith('/sniff')) throw new Error('请登录可飞嗅探平台');
  const base = 'https://api-aai.airins.cn/api/met/sniff/mission_based/historical_data/mission';
  const get = async (suffix, body) => {
    const response = await fetch(base + suffix, { credentials: 'include', signal: AbortSignal.timeout(30000), ...(body ? {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {}) });
    if (!response.ok) throw new Error(`可飞查询失败 (${response.status})`);
    const result = await response.json();
    if (result.isSuccess !== true) throw new Error('可飞未返回任务数据，请检查登录状态或稍后重试');
    return result.data;
  };
  if (job.type === 'flight-missions') {
    const cursor = Number.isSafeInteger(job.cursorId) && job.cursorId > 0 && Number.isSafeInteger(job.cursorTime) ? `?missionId=${job.cursorId}&listStartTime=${job.cursorTime}` : '';
    const data = await get('/list' + cursor);
    if (!Array.isArray(data.list)) throw new Error('可飞任务列表格式已变化');
    return {url:location.href, total:data.total, missions:data.list.map(m=>({missionId:m.missionId,missionName:m.missionName,startTime:m.startTime,endTime:m.endTime,geoLocation:m.geoLocation || ''}))};
  }
  if (!Number.isSafeInteger(job.missionId) || job.missionId <= 0) throw new Error('可飞任务编号无效');
  const data = await get('/raw/data/box', {missionId:job.missionId,filteringParams:[]});
  const ts = data.missionData?.ts, pm = data.missionData?.ad_9;
  if (!Array.isArray(ts) || !Array.isArray(pm) || !Array.isArray(data.positions) || !ts.length || ts.length > 20000 || ts.length !== pm.length || ts.length !== data.positions.length || ts.length !== data.missionNum) throw new Error('可飞采样数据不完整或超过 20000 点');
  // ad_9 is the platform's raw PM2.5 channel, μg/m³. Do not convert gas channels.
  return {url:location.href,missionId:job.missionId,unit:'μg/m³',points:ts.map((time,i)=>({time,pm25:pm[i],longitude:data.positions[i]?.[0],latitude:data.positions[i]?.[1]}))};
}
export async function djiReport(job) {
  const project = '/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
  if (location.origin !== 'https://fh.dji.com' || location.pathname.replace(/\/$/,'') !== project || !location.hash.startsWith('#/media?')) throw new Error('请打开泰州项目的司空媒体库');
  const visible = e => e.getClientRects().length > 0;
  const breadcrumb = document.querySelector('[aria-label="Breadcrumb"],.ant-breadcrumb');
  const folder = breadcrumb?.innerText?.trim() || '';
  if (!folder.endsWith('Immediate-Media')) throw new Error('请进入本次任务的 Immediate-Media 文件夹');
  const names = [...document.querySelectorAll('table tbody tr')].filter(visible).map(row => row.innerText.match(/DJI_\d{14}_[A-Za-z0-9_]+\.(?:jpe?g|png)/i)?.[0]).filter(Boolean);
  const unique = [...new Set(names)];
  if (!unique.length && !/暂无数据|无文件|No data|No files/i.test([...document.querySelectorAll('table')].map(e=>e.innerText).join(' '))) throw new Error('未识别到图片列表，无法确认文件夹是否为空');
  if (unique.length > 20) throw new Error('单次快报最多收录 20 张照片，请分批整理后重试');
  // Refuse silent omission of another page or a search filter.
  if ([...document.querySelectorAll('input')].some(e => /文件名称/.test(e.placeholder) && e.value.trim())) throw new Error('请清空司空文件名搜索后重试');
  const next = document.querySelector('.ant-pagination-next');
  if (next && next.getAttribute('aria-disabled') !== 'true' && !next.classList.contains('ant-pagination-disabled')) throw new Error('图片超过一页，请整理为不超过 20 张的单页任务文件夹');
  if (job.type === 'flight-dji-list') return {url:location.href,folder,files:unique};
  if (!unique.includes(job.name)) throw new Error('照片已不在当前任务文件夹中');
  // Opening a preview is read-only and refreshes the selected photo record.
  const target = [...document.querySelectorAll('table tbody tr')].find(row=>row.innerText.includes(job.name));
  const name = [...target.querySelectorAll('*')].find(e=>e.textContent.trim() === job.name && !e.children.length);
  if (!name) throw new Error('未找到照片预览入口');
  const stem = job.name.replace(/\.[^.]+$/, '');
  name.click();
  for(let attempt=0;attempt<20;attempt++){
    await new Promise(resolve=>setTimeout(resolve,300));
    // The fixed PreviewDetail prop is the selected media record. Traverse only
    // the media app's rendered VNodes; never read app stores or credentials.
    let selected=null;
    const queue=[...document.querySelectorAll('#disk-app')].map(el=>el._vnode).filter(Boolean),seen=new Set();
    for(let count=0;queue.length&&count<5000;count++){
      const node=queue.shift();if(!node||seen.has(node))continue;seen.add(node);
      const component=node.component;
      const file=component?.props?.previewItemProp;
      if(file&&String(file.name).replace(/\.(jpe?g|png)$/i,'')===stem){selected=file;break;}
      if(component?.subTree)queue.push(component.subTree);
      if(Array.isArray(node.children))queue.push(...node.children);
      if(node.suspense?.activeBranch)queue.push(node.suspense.activeBranch);
    }
    if(!selected?.url || !/^https:\/\//.test(selected.url))continue;
    const response=await fetch(selected.url,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('司空照片下载失败，请刷新媒体页后重试');
    const blob=await response.blob();if(blob.size>12000000)throw new Error('照片超过 12 MB');
    const bytes=new Uint8Array(await blob.arrayBuffer());
    const mime=bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes[0]===137&&bytes[1]===80?'image/png':null;
    if(!mime)throw new Error('司空照片不是 JPEG/PNG');
    const bitmap=await createImageBitmap(blob);const width=bitmap.width,height=bitmap.height;bitmap.close();
    if(width<600||height<400)throw new Error('司空仅返回缩略图，请等待原图上传');
    if((selected.ext?.width>0 && width!==Number(selected.ext.width))||(selected.ext?.height>0 && height!==Number(selected.ext.height)))throw new Error('下载照片尺寸与平台原图不符');
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(new Blob([bytes],{type:mime}));});
    return {url:location.href,folder,name:job.name,dataUrl,kind:'司空原始照片'};
  }
  throw new Error('未取得司空照片原图，请关闭预览后重试；如仍失败请检查照片是否已完成上传');
}
export function validatePhotoName(name, start, end) {
  const m = /^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[A-Za-z0-9_]+\.(jpe?g|png)$/i.exec(name);
  if (!m) throw new Error('无法从司空文件名核对拍摄时间');
  const time = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
  if (!Number.isFinite(time) || time < start - 300000 || time > end + 300000) throw new Error('司空照片与可飞任务时间不匹配');
  return time;
}
