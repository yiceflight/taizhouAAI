// Crop the platform's exported raster, without redrawing or interpolating readings.
export function trajectoryCrop(pixels, width, height, palette) {
  if (width < 200 || height < 200 || width * height > 20000000 || pixels.length !== width * height * 4 || !palette.length) throw new Error('轨迹图像尺寸或色标无效');
  let left = width, top = height, right = -1, bottom = -1, count = 0;
  // Keep every matching pixel: separate route legs must not be discarded as noise.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, r = pixels[i], g = pixels[i+1], b = pixels[i+2];
    if (pixels[i+3] < 200 || Math.max(r,g,b) < 190 || Math.max(r,g,b)-Math.min(r,g,b) < 100) continue;
    if (!palette.some(c => Math.abs(r-c[0]) <= 12 && Math.abs(g-c[1]) <= 12 && Math.abs(b-c[2]) <= 12)) continue;
    left = Math.min(left,x); right = Math.max(right,x); top = Math.min(top,y); bottom = Math.max(bottom,y); count++;
  }
  if (count < 100 || right-left < 30 || bottom-top < 30) throw new Error('未可靠识别完整浓度轨迹，请调整地图后重试');
  if (left < 4 || top < 4 || right >= width-4 || bottom >= height-4) throw new Error('浓度轨迹触及地图边缘，可能不完整，请缩小地图后重试');
  const px = Math.max(48, Math.ceil((right-left+1)*0.1));
  const py = Math.max(48, Math.ceil((bottom-top+1)*0.1));
  const x = Math.max(0,left-px), y = Math.max(0,top-py);
  return {x,y,width:Math.min(width,right+px+1)-x,height:Math.min(height,bottom+py+1)-y};
}

// Airins' history page can remove the query string after it has mounted
// the Vue route (and some builds add a trailing slash).  A missing query is
// safe here because the tab is created by the report worker for this exact
// mission immediately before capture; an explicit, different mission id is
// still rejected so a stale page can never be used silently.
export function airinsHistoryRouteMatches(url, missionId) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://aai.airins.cn' || parsed.pathname.replace(/\/+$/, '') !== '/sniff/HistoryCloud') return false;
    const pageMissionId = parsed.searchParams.get('missionId');
    return pageMissionId == null || pageMissionId === String(missionId);
  } catch {
    return false;
  }
}

export async function airinsMap(job, crop) {
  // Runtime.evaluate serializes this function and executes it in the page.
  // Keep the route guard inside the serialized function; module-level helpers
  // are not available in that isolated execution context.
  const historyRouteMatches = (url, missionId) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://aai.airins.cn' || parsed.pathname.replace(/\/+$/, '') !== '/sniff/HistoryCloud') return false;
      const pageMissionId = parsed.searchParams.get('missionId');
      return pageMissionId == null || pageMissionId === String(missionId);
    } catch {
      return false;
    }
  };
  if (!historyRouteMatches(location.href, job.missionId)) throw new Error('轨迹图航次不匹配');
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).display !== 'none';
  const wait = async read => { for(let i=0;i<80;i++){const v=read();if(v)return v;await new Promise(r=>setTimeout(r,250));}throw new Error('可飞轨迹图未完成加载'); };
  const normal = s => s.replace(/₂/g,'2').replace(/₅/g,'5').replace(/\s/g,'');
  if (visible(document.querySelector('.history-charts-expand'))) document.querySelector('button.charts-show-control-btn')?.click();
  const selector = await wait(()=>document.querySelector('.sensor-select-collection'));
  if (!normal(selector.textContent).startsWith('PM2.5')) {
    selector.click();
    const item = await wait(()=>[...document.querySelectorAll('.sensor-list .item')].find(e=>visible(e)&&normal(e.textContent)==='PM2.5'));
    item.click();
  }
  await wait(()=>normal(selector.textContent)==='PM2.5(µg/m³)' || normal(selector.textContent)==='PM2.5(μg/m³)');
  if (!document.querySelector('.flex-center-layer-mode')?.textContent.includes('点云')) throw new Error('请选择浓度点云轨迹图层');
  const legend = [...document.querySelectorAll('.bar-line')].find(visible);
  const gradient = legend && getComputedStyle(legend.querySelector('.bar-line-item')).backgroundImage;
  const palette = [...(gradient || '').matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g)].map(m=>m.slice(1).map(Number));
  const labels = [...(legend?.querySelectorAll('.value') || [])].map(e=>e.textContent.trim());
  if (palette.length < 2 || labels.length !== 2) throw new Error('未取得平台浓度色标');
  // Parameter labels update before the WebGL layer; wait for rendered pixels.
  let previous = '', stable = 0;
  await wait(() => {
    const map = document.querySelector('canvas.mapboxgl-canvas');
    if (!map?.width || !map.height) return false;
    const current = map.toDataURL('image/png');
    stable = current === previous ? stable + 1 : 0; previous = current;
    return stable >= 3;
  });
  document.querySelector('button.image-preview-control')?.click();
  const img = await wait(()=>{const e=document.querySelector('.image-preview-content img');return visible(e)&&e.complete&&e.naturalWidth>0&&e;});
  const source = img.src;
  if (!source.startsWith('data:image/png;base64,')) throw new Error('平台导出图像格式无效');
  const canvas = document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  if(canvas.width*canvas.height>20000000)throw new Error('平台地图图像过大');
  const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
  const rect=crop(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height,palette);
  const out=document.createElement('canvas');out.width=Math.max(600,rect.width);out.height=Math.round(rect.height*out.width/rect.width)+100;
  const c=out.getContext('2d');c.fillStyle='white';c.fillRect(0,0,out.width,out.height);
  c.drawImage(canvas,rect.x,rect.y,rect.width,rect.height,0,0,out.width,out.height-100);
  // Reproduce the actual platform legend (including its bounds), not a new scale.
  const bar=c.createLinearGradient(160,0,out.width-50,0);
  palette.slice().reverse().forEach((rgb,i)=>bar.addColorStop(i/(palette.length-1),`rgb(${rgb.join(',')})`));
  c.fillStyle=bar;c.fillRect(160,out.height-70,out.width-210,14);
  c.fillStyle='#222';c.font='20px sans-serif';c.fillText('PM2.5 (µg/m³)',16,out.height-55);
  c.fillText(labels[0],160,out.height-28);c.textAlign='right';c.fillText(labels[1],out.width-50,out.height-28);
  document.querySelector('.image-preview-close')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return {method:'airins-export-crop-v1',missionId:job.missionId,sourceChannel:'ad_9',capturedAt:Date.now(),width:out.width,height:out.height,
    crop:rect,originalWidth:canvas.width,originalHeight:canvas.height,paddingRatio:0.1,legendLabels:labels,
    dataUrl:out.toDataURL('image/png'),originalDataUrl:source};
}

export async function captureAirinsMap(debuggerApi, tabId, missionId) {
  const response=await debuggerApi.sendCommand({tabId},'Runtime.evaluate',{
    expression:`(${airinsMap.toString()})(${JSON.stringify({missionId})},(${trajectoryCrop.toString()}))`,awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails || !response.result?.value)throw new Error(response.exceptionDetails?.exception?.description || '浓度轨迹图导出失败');
  return response.result.value;
}
