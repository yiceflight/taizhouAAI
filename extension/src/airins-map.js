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

export async function airinsMap(job) {
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
  const waitMapStable = async () => {
    // Parameter labels update before the WebGL layer; wait for rendered pixels.
    let previous = '', stable = 0;
    await wait(() => {
      const map = document.querySelector('canvas.mapboxgl-canvas');
      if (!map?.width || !map.height) return false;
      const current = map.toDataURL('image/png');
      stable = current === previous ? stable + 1 : 0; previous = current;
      return stable >= 5;
    });
  };
  const closePreview = async () => {
    document.querySelector('.image-preview-close')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    // Let the modal teardown finish before the next export. Without
    // this small yield some platform builds leave the old image node visible.
    await new Promise(resolve => setTimeout(resolve, 250));
  };
  const exportMap = async (attempt) => {
    await waitMapStable();
    // The map canvas can be stable while the WebGL trajectory layer is still
    // arriving after a parameter switch. Give that layer one paint interval
    // before opening the platform export modal.
    await new Promise(resolve => setTimeout(resolve, 500));
    document.querySelector('button.image-preview-control')?.click();
    try {
      const img = await wait(()=>{const e=document.querySelector('.image-preview-content img');return visible(e)&&e.complete&&e.naturalWidth>0&&e;});
      const source = img.src;
      if (!source.startsWith('data:image/png;base64,')) throw new Error('平台导出图像格式无效');
      if(img.naturalWidth*img.naturalHeight>20000000)throw new Error('平台地图图像过大');
      // The platform export already contains the complete rendered route. Do
      // not infer its extent from PNG colours: basemap pixels can share the
      // same palette and make a valid export look clipped (or make a partial
      // export look valid). Preserve the authoritative platform image as-is.
      return {method:'airins-export-full-v1',missionId:job.missionId,sourceChannel:'ad_9',capturedAt:Date.now(),width:img.naturalWidth,height:img.naturalHeight,
        crop:{x:0,y:0,width:img.naturalWidth,height:img.naturalHeight},originalWidth:img.naturalWidth,originalHeight:img.naturalHeight,paddingRatio:0.1,recoveryAttempt:attempt,legendLabels:labels,
        dataUrl:source,originalDataUrl:source};
    } finally {
      // Also clean up malformed, oversized, and timeout failures before the
      // next automatic attempt so a stale preview cannot be captured again.
      await closePreview();
    }
  };
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await exportMap(attempt); }
    catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      // A transient export/modal failure can still be retried, but route
      // completeness is now guaranteed by the platform export itself.
      await new Promise(resolve => setTimeout(resolve, 900 + attempt * 600));
      await waitMapStable();
    }
  }
  throw lastError || new Error('浓度轨迹图导出失败');
}

export async function captureAirinsMap(debuggerApi, tabId, missionId) {
  const response=await debuggerApi.sendCommand({tabId},'Runtime.evaluate',{
    expression:`(${airinsMap.toString()})(${JSON.stringify({missionId})})`,awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails || !response.result?.value)throw new Error(response.exceptionDetails?.exception?.description || '浓度轨迹图导出失败');
  return response.result.value;
}
