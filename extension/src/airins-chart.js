// Runs only in a report-owned HistoryCloud tab opened for one mission.
// Use the site's rendered chart, never redraw samples or read application stores.
export async function airinsChart(job) {
  if (location.origin !== 'https://aai.airins.cn' || location.pathname !== '/sniff/HistoryCloud') throw new Error('可飞图表页面不匹配');
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const normalize = text => text.replace(/₂/g, '2').replace(/₅/g, '5').replace(/\s/g, '');
  const pause = () => new Promise(resolve => setTimeout(resolve, 250));
  const wait = async read => {
    for (let i = 0; i < 80; i++) { const result = read(); if (result) return result; await pause(); }
    throw new Error('可飞 PM2.5 图表尚未加载完成');
  };
  if (job.phase === 'prepare') {
    await wait(() => visible(document.querySelector('.history-charts canvas')));
    if (!visible(document.querySelector('.history-charts-expand'))) {
      const button = document.querySelector('button.charts-show-control-btn');
      if (!visible(button)) throw new Error('未找到可飞曲线展开按钮');
      button.click();
    }
    const selector = await wait(() => { const el = document.querySelector('.charts-expand-right .param-check'); return visible(el) && el; });
    if (normalize(selector.textContent) !== 'PM2.5') {
      selector.click();
      const item = await wait(() => {
        const menu = document.getElementById(selector.getAttribute('aria-controls'));
        return [...(menu?.querySelectorAll('[role="menuitem"]') || [])].find(el => visible(el) && normalize(el.textContent) === 'PM2.5');
      });
      item.click();
    }
    await wait(() => normalize(selector.textContent) === 'PM2.5');
    const dismiss = document.querySelector('.chart-keyboard-guide__dismiss');
    if (visible(dismiss)) dismiss.click();
    return { prepared: true };
  }
  const panel = document.querySelector('.charts-expand-right');
  const chart = panel?.querySelector('.history-charts-expand');
  if (!visible(panel) || !visible(chart) || normalize(panel.querySelector('.param-check')?.textContent || '') !== 'PM2.5'
      || !/[µμ]g\/m³/.test(panel.querySelector('.sensor-selector')?.textContent || '')) throw new Error('可飞当前图表不是 PM2.5 质量浓度曲线');
  const times = [...panel.querySelectorAll('.charts-info .time span')].map(el => Date.parse(el.textContent.trim().replace(' ', 'T') + '+08:00'));
  const countRow = [...document.querySelectorAll('.task-info-item')].find(el => el.querySelector('.item-label')?.textContent.trim() === '数据量');
  const count = Number(countRow?.querySelector('.item-val')?.textContent.replace(/,/g, '').trim());
  const extrema = [...panel.querySelectorAll('.charts-info > span')].map(el => Number(el.textContent.trim()));
  if (times.length !== 2 || times[0] !== job.startTime || times[1] !== job.endTime || count !== job.pointCount
      || extrema.length !== 2 || Math.abs(extrema[0] - job.maximum) > 0.11 || Math.abs(extrema[1] - job.minimum) > 0.11) {
    throw new Error('可飞图表时段、点数或浓度与本航次原始采样不一致');
  }
  if (document.fonts?.status === 'loading' || [...document.querySelectorAll('.el-loading-mask,.chart-keyboard-guide')].some(visible)) throw new Error('可飞图表仍在加载或被提示遮挡');
  const box = panel.getBoundingClientRect();
  if (box.width < 500 || box.height < 150 || box.left < 0 || box.top < 0 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) throw new Error('可飞曲线显示区域不完整，请放大浏览器窗口');
  const clip = {x: Math.floor(box.left + scrollX), y: Math.floor(box.top + scrollY), width: Math.floor(box.width), height: Math.floor(box.height), scale: 1};
  const canvases = [...chart.querySelectorAll('canvas')];
  if (!canvases.length || canvases.some(c => !c.width || !c.height)) throw new Error('可飞曲线画布为空');
  const signature = JSON.stringify([clip, panel.textContent, count, ...canvases.map(c => c.toDataURL('image/png'))]);
  return {clip, signature};
}

export async function captureAirinsChart(debuggerApi, tabId, air, getTabs = () => globalThis.chrome?.tabs) {
  const times = air.points.map(p => p.time), values = air.points.map(p => p.pm25).filter(v => Number.isFinite(v));
  if (!values.length) throw new Error('可飞 PM2.5 无有效数值，无法核对图表');
  const expected = {missionId: air.missionId, startTime: Math.min(...times), endTime: Math.max(...times), pointCount: times.length,
    maximum: Math.max(...values), minimum: Math.min(...values)};
  const deadline = Date.now() + 35000;
  const command = async (method, params, cleanup = false) => {
    const remaining = cleanup ? 2000 : Math.min(30000, deadline - Date.now());
    if (remaining <= 0) throw new Error('可飞图表截图超时');
    let timer;
    try { return await Promise.race([
      debuggerApi.sendCommand({tabId}, method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('可飞图表截图超时')), remaining); }),
    ]); } finally { clearTimeout(timer); }
  };
  const inspect = async phase => {
    const response = await command('Runtime.evaluate', {expression: `(${airinsChart.toString()})(${JSON.stringify({...expected, phase})})`, awaitPromise:true, returnByValue:true});
    if (response.exceptionDetails || !response.result?.value) throw new Error(response.exceptionDetails?.exception?.description || '可飞图表读取失败');
    return response.result.value;
  };
  const collapse = async () => {
    const response = await command('Runtime.evaluate', {
      expression: `(() => { const b = document.querySelector('button.charts-show-control-btn'); if (!b || !b.getClientRects().length) return false; b.click(); return true; })()`,
      returnByValue: true,
    });
    return response?.result?.value === true;
  };
  // Chrome can suspend painting in a hidden tab. The platform's expanded
  // chart is only painted while the renderer is visible, so a background tab
  // leaves an unpainted panel even though CDP can evaluate and screenshot it.
  // This tab was created by the extension for this read; briefly activate it
  // so the operator's work tab is never navigated, then restore their tab.
  // Worker-side tab updates are bounded: a suspended Chrome service can leave
  // an awaited call hanging and would otherwise consume the whole capture.
  const tabsCall = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), 2500))]).catch(() => null);
  let previous;
  const focus = async () => {
    const tabsApi = getTabs?.();
    if (!tabsApi) return;
    const tab = await tabsCall(tabsApi.get(tabId));
    if (!tab) return;
    const current = await tabsCall(tabsApi.query({active:true,windowId:tab.windowId}));
    previous = (current || []).find(old => old.id !== tabId) || previous;
    if (!tab.active) await tabsCall(tabsApi.update(tabId, {active:true}));
  };
  const restore = async () => {
    const tabsApi = getTabs?.();
    if (!tabsApi || !previous) return;
    const old = await tabsCall(tabsApi.get(previous.id));
    if (old) await tabsCall(tabsApi.update(old.id, {active:true}));
  };
  await focus();
  await command('Emulation.setFocusEmulationEnabled', {enabled:true});
  try {
    await inspect('prepare');
    let plan, last, stable = 0, error, lastError, reopen = 0;
    for (let i = 0; i < 24 && Date.now() < deadline; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const next = await inspect('inspect');
        stable = next.signature === last ? stable + 1 : 0;
        last = next.signature;
        if (stable >= 2) { plan = next; break; }
      } catch (e) {
        // The panel can be clipped by a small window. Collapse it once and
        // let the platform reopen it at its own (scaled) size. Reopening is
        // bounded so a slow PC is not spent reopening a panel that never fits.
        if (/显示区域不完整|截图尺寸不符/.test(e?.message || '') && reopen < 2) {
          reopen++;
          await collapse().catch(() => {});
          await inspect('prepare').catch(() => {});
        }
        error = e; lastError = e; stable = 0;
      }
    }
    if (!plan) {
      const smallWindow = /显示区域不完整|截图尺寸不符/.test(lastError?.message || '');
      throw smallWindow
        ? new Error('可飞曲线显示区域超出窗口，本机窗口过小；请最大化 Chrome 窗口后重试')
        : lastError || error || new Error('可飞曲线尚未稳定');
    }
    const {data} = await command('Page.captureScreenshot', {format:'png', fromSurface:true, captureBeyondViewport:true, clip:plan.clip});
    if (!data || data.length > 16000000) throw new Error('可飞曲线截图为空或超过12 MB');
    const header = Uint8Array.from(atob(data.slice(0,32)), c => c.charCodeAt(0));
    const view = new DataView(header.buffer);
    if (header.length !== 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(12) !== 0x49484452) throw new Error('可飞截图不是有效PNG');
    const width = view.getUint32(16), height = view.getUint32(20);
    if (width < 500 || height < 150 || width * height > 20000000 || Math.abs(width - height * plan.clip.width / plan.clip.height) > 3) throw new Error('可飞截图尺寸不符');
    if ((await inspect('inspect')).signature !== plan.signature) throw new Error('可飞曲线在截图期间发生变化');
    return {...expected, method:'airins-page-screenshot', sourceChannel:'ad_9', capturedAt:Date.now(), width, height, dataUrl:`data:image/png;base64,${data}`};
  } finally {
    await collapse().catch(() => {});
    await command('Emulation.setFocusEmulationEnabled', {enabled:false}, true).catch(() => {});
    await restore();
  }
}
