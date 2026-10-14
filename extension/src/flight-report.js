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
  // Navigate only rendered media folders. Never query application stores or credentials.
  if (job.type === 'flight-dji-list' && job.startTime !== undefined) {
    if (!Number.isSafeInteger(job.startTime) || !Number.isSafeInteger(job.endTime) || job.startTime <= 0 || job.endTime <= job.startTime || job.endTime - job.startTime > 86400000) throw new Error('自动匹配的飞行时间无效');
    const deadline = Date.now() + 65000;
    const crumb = () => document.querySelector('[aria-label="Breadcrumb"],.ant-breadcrumb');
    const rows = () => [...document.querySelectorAll('table tbody tr')].filter(visible);
    const signature = () => rows().map(row => row.innerText).join('\n');
    const loading = () => [...document.querySelectorAll('.ant-spin-spinning,.el-loading-mask,[aria-busy="true"]')].some(visible);
    const wait = async (condition, label) => {
      let stable = 0;
      for (let attempt = 0; attempt < 50 && Date.now() < deadline; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (condition() && !loading()) { if (++stable >= 3) return; } else stable = 0;
      }
      throw new Error(`司空${label}未完成，请等待媒体库加载后重试`);
    };
    const leaf = (root, text) => [...root.querySelectorAll('*')].find(e => !e.children.length && e.textContent.trim() === text);
    const navigate = async hash => {
      if (location.hash === hash) { await wait(() => rows().length || /暂无数据|无文件|No data|No files/i.test(document.querySelector('table')?.innerText || ''), '列表加载'); return; }
      const before = signature();
      location.hash = hash;
      await wait(() => location.hash === hash && signature() !== before, '列表切换');
    };
    // Reset to the unfiltered first page even when a different flight is open.
    const search = [...document.querySelectorAll('input')].find(e => /文件名称/.test(e.placeholder));
    if (search?.value.trim()) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('无法清空司空文件名搜索，请刷新媒体库后重试');
      setter.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await wait(() => !search.value, '搜索清空');
    }
    if (job.folderId != null) {
      if (!Number.isSafeInteger(job.folderId) || job.folderId <= 0) throw new Error('司空任务媒体目录编号无效');
      await navigate(`#/media?page=1&size=50&pid=${job.folderId}`);
      if (new URLSearchParams(location.hash.split('?')[1]).get('pid') !== String(job.folderId)) throw new Error('司空媒体目录不匹配');
    } else {
    const rootHash = page => `#/media?page=${page}&size=50`;
    const candidates = [];
    let complete = false;
    let scanned = 0;
    for (let page = 1; page <= 20; page++) {
      await navigate(rootHash(page));
      if (/(?:\d{4}-\d{2}-\d{2}|Immediate-Media)/.test(crumb()?.innerText || '')) throw new Error('司空媒体库未返回任务列表，请刷新后重试');
      const current = rows();
      for (const row of current) {
        // Use only the name cell, never the creation-time column.
        const name = [...row.querySelectorAll('td')].map(cell => cell.innerText.trim()).find(text => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*\(UTC\+08\)/.test(text));
        if (!name) continue;
        const stamp = name.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*\(UTC\+08\)/);
        const time = Date.parse(`${stamp[1]}T${stamp[2]}+08:00`);
        if (Math.abs(time - job.startTime) <= 300000) candidates.push({ name, page });
      }
      if (candidates.length > 1) throw new Error('飞行开始时间前后 5 分钟内存在多个司空航次，无法唯一匹配，未采集照片');
      scanned += current.length;
      const totalText = [...document.querySelectorAll('table th')].map(e => e.innerText).join(' ');
      const total = totalText.match(/\(\s*\d+\s*\/\s*(\d+)\s*\)/)?.[1];
      const next = document.querySelector('.ant-pagination-next,[aria-label="Next Page"],[title="下一页"]');
      if (total != null ? scanned >= Number(total) : next ? next.getAttribute('aria-disabled') === 'true' || next.classList.contains('ant-pagination-disabled') : current.length < 50) { complete = true; break; }
    }
    if (!complete) throw new Error('司空航次列表未完整读取，暂不能确认唯一匹配，请缩小媒体库范围后重试');
    if (!candidates.length) throw new Error('未找到开始时间前后 5 分钟内的司空航次，请等待任务媒体上传后重试');
    const match = candidates[0];
    await navigate(rootHash(match.page));
    const target = rows().map(row => leaf(row, match.name)).find(Boolean);
    if (!target) throw new Error('匹配的司空航次已变化，请重新读取');
    const rootRows = signature();
    target.click();
    await wait(() => (crumb()?.innerText || '').includes(match.name) && signature() !== rootRows, '航次打开');
    }
    const immediate = rows().map(row => leaf(row, 'Immediate-Media')).find(Boolean);
    if (!immediate) throw new Error('已按时间找到司空航次，但尚无 Immediate-Media 照片文件夹，请等待照片上传后重试');
    const taskRows = signature();
    immediate.click();
    await wait(() => (crumb()?.innerText || '').trim().endsWith('Immediate-Media') && signature() !== taskRows, '照片文件夹打开');
  }
  const breadcrumb = document.querySelector('[aria-label="Breadcrumb"],.ant-breadcrumb');
  const folder = breadcrumb?.innerText?.trim() || '';
  if (!folder.endsWith('Immediate-Media')) throw new Error('请进入本次任务的 Immediate-Media 文件夹');
  if ([...document.querySelectorAll('input')].some(e => /文件名称/.test(e.placeholder) && e.value.trim())) throw new Error('请清空司空文件名搜索后重试');
  const pageNames = () => [...document.querySelectorAll('table tbody tr')].filter(visible).flatMap(row => {
    const value = row.innerText;
    const name = value.match(/DJI_\d{14}_[A-Za-z0-9_]+\.(?:jpe?g|png)/i)?.[0];
    if (!name && /\.(?:jpe?g|png|tiff?|dng|webp)\b/i.test(value)) throw new Error('存在无法核对拍摄时间或不支持格式的图片，未生成不完整报告');
    return name ? [name] : [];
  });
  const goPage = async page => {
    const params = new URLSearchParams(location.hash.split('?')[1]);
    if (Number(params.get('page') || 1) === page) return;
    const before = pageNames().join('|');
    params.set('page', String(page)); location.hash = '#/media?' + params.toString();
    let stable = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (pageNames().join('|') !== before && ![...document.querySelectorAll('.ant-spin-spinning,[aria-busy="true"]')].some(visible)) {
        if (++stable >= 3) return;
      } else stable = 0;
    }
    throw new Error('司空图片翻页未完成，未生成不完整报告');
  };
  if (job.page != null) {
    if (!Number.isInteger(job.page) || job.page < 1 || job.page > 20) throw new Error('照片页码无效');
    await goPage(job.page);
  }
  const unique = [...new Set(pageNames())];
  if (!unique.length && !/暂无数据|无文件|No data|No files/i.test([...document.querySelectorAll('table')].map(e=>e.innerText).join(' '))) throw new Error('未识别到图片列表，无法确认文件夹是否为空');
  if (job.type === 'flight-dji-list') {
    // Legacy manual probes cannot prove a complete multipage inventory.
    const initialNext = document.querySelector('.ant-pagination-next');
    if (job.startTime == null && initialNext && initialNext.getAttribute('aria-disabled') !== 'true' && !initialNext.classList.contains('ant-pagination-disabled')) throw new Error('图片超过一页，请按飞行时间自动匹配后重试');
    await goPage(1);
    const files = [], filePages = {};
    for (let page = 1; page <= 20; page++) {
      for (const name of pageNames()) {
        if (filePages[name]) throw new Error('司空照片跨页重复，列表可能正在变化，请重试');
        files.push(name); filePages[name] = page;
      }
      if (files.length > 200) throw new Error('单次报告超过 200 张照片，未截断或生成不完整报告');
      const next = document.querySelector('.ant-pagination-next');
      if (!next || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('ant-pagination-disabled')) {
        if ((document.querySelector('[aria-label="Breadcrumb"],.ant-breadcrumb')?.innerText?.trim() || '') !== folder) throw new Error('采集期间照片文件夹已变化');
        return { url: location.href, folder, files, filePages, matchedStartTime: job.startTime, matchedTaskFolderId: job.folderId ?? null };
      }
      await goPage(page + 1);
    }
    throw new Error('照片列表超过 20 页，未生成不完整报告');
  }
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
