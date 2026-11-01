import { readOnlyJob, createReadScheduler } from './read-scheduler.js';
import { collectDjiWeather, openDjiWeather, WEATHER_READ_TIMEOUT_MS } from './dji-weather.js';
import { checkSiteHealth, openAirinsForHealth, openDjiForHealth, prioritizeHealthJobs } from './site-health.js';
import { readDjiTasks } from './dji-tasks.js';
import { readDjiRoutes } from './dji-routes.js';
import { airinsReport, djiReport } from './flight-report.js';
import { captureAirinsChart } from './airins-chart.js';
import { djiPhotoPresentation, captureDjiPresentation } from './dji-photo-presentation.js';
import { SITE_PATTERNS, allowedUrl, evaluationValue, pageSnapshot } from "./bridge-core.js";
import { queryJiangsuHourly, normalizeHourly, prepareJiangsuForHealth, findJiangsuApi, enterJiangsuAnalysis } from "./jiangsu.js";
import { PLAN_URL, PLAN_RECIPE, validatePlanJob, validateSubmitJob, fillFlightPlan, readFlightStatus, readFlightSubmissionIssue } from "./flight-plan.js";
import { ENDPOINT } from "./bridge-config.js";
import { REALTIME_URL, selectAirinsPm25 } from './airins-realtime.js';
import { createDebuggerSession } from './debugger-session.js';
import { evaluateBackgroundRead } from './background-read.js';
const sessionReady = (async () => {
  const saved = await chrome.storage.local.get("bridgeSession");
  if (saved.bridgeSession) return saved.bridgeSession;
  const session = crypto.randomUUID();
  await chrome.storage.local.set({ bridgeSession: session });
  return session;
})();
let polling = false;
let rerunRequested = false;
let keepingAlive = false;
let keepAliveSupported = false;
let capturing = false;
let activeReportCaptures = 0;
const readScheduler = createReadScheduler(executeJob, () => void heartbeat());
const reportTabs = new Map();
const REPORT_MEDIA_ROOT = 'https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/media?page=1&size=50';
const REPORT_TAB_PREFIX = 'flight-report-tab:';

const reportKey = job => typeof job?.mediaKey === 'string' && /^[\w:.-]{1,240}$/.test(job.mediaKey) ? job.mediaKey : null;
async function waitTab(tabId, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  while (tab && tab.status !== 'complete' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!tab || tab.status !== 'complete') throw new Error('司空媒体页加载超时，请检查 Chrome');
  return tab;
}
async function reportTabFor(job) {
  const key = reportKey(job);
  if (!key) throw new Error('巡飞报告媒体任务缺少有效任务标识');
  const savedKey = REPORT_TAB_PREFIX + key;
  const existing = reportTabs.get(key) || (await chrome.storage.local.get(savedKey))[savedKey];
  if (Number.isInteger(existing)) {
    const tab = await chrome.tabs.get(existing).catch(() => null);
    if (tab?.url?.startsWith('https://fh.dji.com/') && tab.url.includes('#/media')) {
      await waitTab(tab.id);
      reportTabs.set(key, existing);
      return { key, tab };
    }
  }
  const tab = await chrome.tabs.create({ url: REPORT_MEDIA_ROOT, active: false });
  try {
    await waitTab(tab.id);
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
  reportTabs.set(key, tab.id);
  await chrome.storage.local.set({ [savedKey]: tab.id });
  return { key, tab };
}
async function closeReportTab(key, tabId) {
  if (!key) return;
  const current = reportTabs.get(key);
  if (Number.isInteger(tabId) && (current == null || current === tabId)) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  if (current === tabId || current == null) reportTabs.delete(key);
  await chrome.storage.local.remove(REPORT_TAB_PREFIX + key);
}
const debuggerSession = createDebuggerSession(chrome.debugger, allowedUrl);

async function post(path, body) {
  const response = await fetch(`${ENDPOINT}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Taizhou-Bridge": "1" },
    body: JSON.stringify({ session: await sessionReady, ...body }), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`客户端连接失败 (${response.status})`);
  return response.json();
}
async function enterJiangsuBusiness(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (new URL(tab.url).origin !== 'http://61.155.4.60:18080') throw new Error('江苏大气站入口来源不匹配');
  const attached = await debuggerSession.acquire(tabId);
  try {
    const response = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(${enterJiangsuAnalysis.toString()})()`, returnByValue: true,
    });
    if (evaluationValue(response)?.opened !== true) throw new Error('未能进入综合分析，请手动进入后重新验证');
  } finally { await debuggerSession.release(tabId, attached); }
}
async function capture(tabId, job) {
  const parallelReport = reportJob(job);
  const independentRead = readOnlyJob(job);
  if (!parallelReport && !independentRead && capturing) throw new Error("另一个采集正在执行，请稍后重试");
  if (!parallelReport && !independentRead) capturing = true;
  if (parallelReport) activeReportCaptures += 1;
  let targetTabId = tabId;
  let mediaKey = null;
  let completed = false;
  let attached = false;
  let airChartTab = null;
  try {
    if (job?.type === 'flight-airins' && job.captureChart) {
      if (!Number.isSafeInteger(job.missionId) || job.missionId <= 0) throw new Error('可飞任务编号无效');
      airChartTab = await chrome.tabs.create({url: `https://aai.airins.cn/sniff/HistoryCloud?missionId=${job.missionId}`, active:false});
      targetTabId = airChartTab.id;
      await waitTab(targetTabId);
    }
    if (parallelReport) {
      const owned = await reportTabFor(job);
      targetTabId = owned.tab.id;
      mediaKey = owned.key;
    }
    const tab = await chrome.tabs.get(targetTabId);
    if (!allowedUrl(tab.url)) throw new Error("仅支持三个已授权业务网站");
    if (tab.status !== "complete") throw new Error("页面尚未加载完成");
    attached = await debuggerSession.acquire(targetTabId);
    const flight = job?.type?.startsWith('flight-');
    const expression = job?.type === "dji-weather" ? `(${collectDjiWeather.toString()})()` : flight ? `(${(job.type.startsWith('flight-dji') ? djiReport : airinsReport).toString()})(${JSON.stringify(job)}, ${djiPhotoPresentation.toString()})` : null;
    const response = await evaluateBackgroundRead(chrome.debugger, targetTabId, {
      expression: (job?.type === "site-health" ? `Promise.race([(${checkSiteHealth.toString()})((${findJiangsuApi.toString()})), new Promise(resolve => setTimeout(() => resolve({url:location.href,state:"error",message:"验证超时，请检查网络后重试"}), 15000))])` : expression) || (job?.type === "jiangsu-hourly" ? `Promise.race([(${queryJiangsuHourly.toString()})(${JSON.stringify(job.startTime)}, ${JSON.stringify(job.endTime)}, (${findJiangsuApi.toString()})), new Promise((_, reject) => setTimeout(() => reject(new Error("江苏大气站查询超时")), 35000))])` : `(${pageSnapshot.toString()})()`), awaitPromise: true, returnByValue: true,
    }, job?.type === 'dji-weather' ? WEATHER_READ_TIMEOUT_MS : job?.type === 'site-health' ? 20000 : 80000);
    const data = evaluationValue(response);
    const current = await chrome.tabs.get(targetTabId);
    if (!allowedUrl(data.url) || current.url !== data.url || new URL(data.url).origin !== new URL(tab.url).origin) throw new Error("采集期间页面发生跳转，请重试");
    if (["site-health", "dji-weather"].includes(job?.type)) return data;
    if (flight) {
      if (airChartTab) {
        data.chart = await captureAirinsChart(chrome.debugger, targetTabId, data);
        if ((await chrome.tabs.get(targetTabId)).url !== data.url) throw new Error('可飞截图期间页面发生跳转');
      }
      if (job.type === 'flight-dji-image' && !data.dataUrl) throw new Error('未取得照片原图，请关闭照片预览后重试；若持续失败，请更新司空适配器');
      if (job.type === 'flight-dji-image') {
        if (!data.capturePlan) throw new Error('未核对照片标注，未保存不完整图片');
        data.presentation = await captureDjiPresentation(chrome.debugger, targetTabId, {name: job.name}, data.capturePlan, djiPhotoPresentation);
        delete data.capturePlan;
        if ((await chrome.tabs.get(targetTabId)).url !== data.url) throw new Error('照片合成期间页面发生跳转，请重试');
      }
      if (new TextEncoder().encode(JSON.stringify(data)).length > 34000000) throw new Error('巡飞资料超过单次传输限制');
      completed = true;
      if (job.type === 'flight-dji-list' && (!Array.isArray(data.files) || data.files.length === 0)) await closeReportTab(mediaKey, targetTabId);
      return data;
    }
    if (job?.type === "jiangsu-hourly") return normalizeHourly(data);
    if (!data.text && data.tables.length === 0) throw new Error("页面没有可采集的正文或表格；请登录并打开具体业务页面");
    return data;
  } finally {
    try { await debuggerSession.release(targetTabId, attached); }
    finally { if (airChartTab) await chrome.tabs.remove(airChartTab.id).catch(() => {}); }
    if (parallelReport && (!completed || job.closeAfter)) await closeReportTab(mediaKey, targetTabId);
    if (!parallelReport && !independentRead) capturing = false;
    if (parallelReport) activeReportCaptures = Math.max(0, activeReportCaptures - 1);
  }
}
async function prepareFlight(job) {
  validatePlanJob(job);
  if (capturing) throw new Error("另一个任务正在执行，请稍后重试");
  capturing = true;
  let tabId;
  let attached = false;
  let prepared = false;
  try {
    const key = `flight-${job.eventId}`;
    const saved = (await chrome.storage.local.get(key))[key];
    let tab = saved && await chrome.tabs.get(saved).catch(() => null);
    if (tab && ![PLAN_URL, `${PLAN_URL}/create-plan`].includes(tab.url)) throw new Error("原计划页面已跳转，请关闭该标签页后重试");
    if (!tab) {
      tab = await chrome.tabs.create({ url: PLAN_URL, active: true });
      await chrome.storage.local.set({ [key]: tab.id });
    } else await chrome.tabs.update(tab.id, { active: true });
    tabId = tab.id;
    const deadline = Date.now() + 20000;
    while (tab.status !== "complete" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      tab = await chrome.tabs.get(tabId);
    }
    if (tab.status !== "complete") throw new Error("司空页面加载超时，请检查 Chrome");
    if (![PLAN_URL, `${PLAN_URL}/create-plan`].includes(tab.url)) throw new Error("请先登录司空，再重试填写");
    attached = await debuggerSession.acquire(tabId);
    const reviewKey = `flight-review-${job.eventId}`;
    const fields = [
      ['计划名称', job.name], ['任务类型', '普通任务', '普通任务'],
      ['执行航线', `${job.route} / 平台副本`],
      ['设备', `${PLAN_RECIPE.device} · ${PLAN_RECIPE.dock} · ${PLAN_RECIPE.aircraft}`, '选择设备'],
      ['任务精度', PLAN_RECIPE.precision, PLAN_RECIPE.precision],
      ['任务策略', PLAN_RECIPE.strategy, PLAN_RECIPE.strategy],
      ['多模态识别', '关闭'], ['自动断点续飞', '关闭'], ['智能规划最佳返航路线', '关闭'],
      ['最低返航高度（相对机场）', `${PLAN_RECIPE.returnHeight} 米`],
      ['航线飞行中失联', PLAN_RECIPE.lostLink, PLAN_RECIPE.lostLink],
      ['完成动作', PLAN_RECIPE.completion], ['媒体存储位置', PLAN_RECIPE.media],
      ['站内通知', '开启'], ['短信', '关闭'], ['邮件', '关闭'],
      ['告警频率', '0 分钟'], ['订阅人员', PLAN_RECIPE.subscriber],
      ['订阅人员勾选', '仅运维'],
    ].map(([label, value, check]) => ({ label, value, check: check || label }));
    if (job.autoSubmit) {
      await chrome.storage.local.set({ [reviewKey]: { tabId, startedAt: null, canceled: false } });
      const panel = await chrome.tabs.sendMessage(tabId, { type: 'flight.review.start', eventId: job.eventId, name: job.name, autoSubmit: true, fields });
      if (!panel?.ok) throw new Error('司空核对面板无法显示，已停止自动确认');
    }
    const response = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `(${fillFlightPlan.toString()})(${JSON.stringify({...PLAN_RECIPE, route: job.route})}, ${JSON.stringify(job.name)}, ${JSON.stringify(PLAN_URL)})`,
      awaitPromise: true, returnByValue: true,
    });
    const result = evaluationValue(response);
    const current = await chrome.tabs.get(tabId);
    if (result.status !== "ready" || result.submitted !== false || result.name !== job.name || current.url !== result.url) throw new Error("司空填写回执不匹配，请检查页面");
    if (job.autoSubmit) {
      const review = (await chrome.storage.local.get([reviewKey]))[reviewKey];
      if (review?.canceled) throw new Error('用户已取消本次作业');
      if (!fields.every(field => result.verified?.includes(field.check))) throw new Error('司空核对面板字段未全部通过');
      await chrome.storage.local.set({ [reviewKey]: { ...review, startedAt: Date.now() } });
      const panel = await chrome.tabs.sendMessage(tabId, { type: 'flight.review.verified', eventId: job.eventId, verified: result.verified });
      if (!panel?.ok) throw new Error('司空核对面板无法更新，已停止自动确认');
    }
    prepared = true;
    return result;
  } finally {
    if (!prepared && tabId && job.autoSubmit) await chrome.tabs.sendMessage(tabId, { type: 'flight.review.close', eventId: job.eventId }).catch(() => {});
    await debuggerSession.release(tabId, attached);
    capturing = false;
  }
}
async function submitFlight(job) {
  validateSubmitJob(job);
  if (capturing) throw new Error('另一个任务正在执行，起飞请求未执行');
  capturing = true;
  let tabId;
  let attached = false;
  try {
    const key = `flight-${job.eventId}`;
    const claim = `flight-submit-${job.eventId}`;
    const saved = await chrome.storage.local.get([key, claim]);
    if (saved[claim]) throw new Error('此任务已经尝试提交，请到司空核查，禁止重复提交');
    const tab = Number.isInteger(saved[key]) ? await chrome.tabs.get(saved[key]).catch(() => null) : null;
    if (!tab || tab.url !== `${PLAN_URL}/create-plan`) throw new Error('原计划草稿不可用，未提交');
    tabId = tab.id;
    await chrome.tabs.update(tabId, { active: true });
    attached = await debuggerSession.acquire(tabId);
    const reviewKey = `flight-review-${job.eventId}`;
    const review = (await chrome.storage.local.get([reviewKey]))[reviewKey];
    if (!review?.startedAt || review.tabId !== tabId) throw new Error('司空核对面板状态缺失，未自动确认');
    if (review?.canceled) throw new Error('用户已取消本次作业');
    if (review?.startedAt) {
      const remaining = Math.max(0, 30000 - (Date.now() - review.startedAt));
      if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
      const afterWait = (await chrome.storage.local.get([reviewKey]))[reviewKey];
      if (afterWait?.canceled) throw new Error('用户已取消本次作业');
    }
    const panel = await chrome.tabs.sendMessage(tabId, { type: 'flight.review.check', eventId: job.eventId });
    if (!panel?.ok) throw new Error('司空核对面板已消失，未自动确认');
    // Persist BEFORE any potentially executing script. A lost receipt or worker
    // restart must never cause another click for the same event.
    await chrome.storage.local.set({ [claim]: { attemptedAt: Date.now() } });
    const response = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(${fillFlightPlan.toString()})(${JSON.stringify({...PLAN_RECIPE, route: job.route})}, ${JSON.stringify(job.name)}, ${JSON.stringify(PLAN_URL)}, true, (${readFlightSubmissionIssue.toString()}))`,
      awaitPromise: true, returnByValue: true,
    });
    const result = evaluationValue(response);
    if (result.status !== 'submitted' || result.submitted !== true || result.name !== job.name || result.url !== PLAN_URL) throw new Error('起飞提交回执不匹配');
    return result;
  } finally {
    if (tabId && chrome.tabs.sendMessage) await chrome.tabs.sendMessage(tabId, { type: 'flight.review.close', eventId: job.eventId }).catch(() => {});
    await debuggerSession.release(tabId, attached);
    capturing = false;
  }
}
async function openPreparedFlight(job) {
  if (!/^[a-f0-9-]{36}$/.test(job.eventId || '') || job.submit !== false) throw new Error('巡查任务编号无效');
  const key = `flight-${job.eventId}`;
  const saved = (await chrome.storage.local.get(key))[key];
  const tab = Number.isInteger(saved) ? await chrome.tabs.get(saved).catch(() => null) : null;
  if (!tab || ![PLAN_URL, `${PLAN_URL}/create-plan`].includes(tab.url)) throw new Error('原计划草稿页面已关闭或跳转，请在司空中核查；未创建新草稿');
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { opened: true };
}
async function openAirinsRealtime(job) {
  let tab = Number.isInteger(job.tabId) && job.tabId >= 0
    ? await chrome.tabs.get(job.tabId).catch(() => null)
    : null;
  if (!tab || !allowedUrl(tab.url) || new URL(tab.url).origin !== 'https://aai.airins.cn') {
    tab = await chrome.tabs.create({ url: REALTIME_URL, active: true });
  } else if (!tab.url.startsWith(REALTIME_URL)) {
    tab = await chrome.tabs.update(tab.id, { url: REALTIME_URL, active: true });
  } else {
    await chrome.tabs.update(tab.id, { active: true });
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  const deadline = Date.now() + 20000;
  while (tab.status !== 'complete' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    tab = await chrome.tabs.get(tab.id);
  }
  if (tab.status !== 'complete') throw new Error('可飞实时页面加载超时，请检查 Chrome');
  const attached = await debuggerSession.acquire(tab.id);
  try {
    const response = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', {
      expression: `(${selectAirinsPm25.toString()})()`, awaitPromise: true, returnByValue: true,
    });
    const result = response?.result?.value;
    return { opened: true, selected: !!result?.selected, label: result?.label || null, url: tab.url };
  } finally {
    await debuggerSession.release(tab.id, attached);
  }
}
async function watchFlight(job) {
  if (!/^[a-f0-9-]{36}$/.test(job.eventId || '') || typeof job.name !== 'string') throw new Error('巡飞状态参数无效');
  // Recover the concrete platform reason for an earlier lost submit receipt.
  // Only inspect this event's original draft and exact plan name; never retry it.
  const draftKey = `flight-${job.eventId}`;
  const draftId = (await chrome.storage.local.get(draftKey))[draftKey];
  const draft = Number.isInteger(draftId) ? await chrome.tabs.get(draftId).catch(() => null) : null;
  if (draft?.url === `${PLAN_URL}/create-plan`) {
    const attached = await debuggerSession.acquire(draft.id);
    try {
      const response = await chrome.debugger.sendCommand({ tabId: draft.id }, 'Runtime.evaluate', {
        expression: `(${readFlightSubmissionIssue.toString()})(${JSON.stringify(PLAN_URL)}, ${JSON.stringify(job.name)})`,
        returnByValue: true,
      });
      const issue = evaluationValue(response);
      if (typeof issue === 'string' && issue) throw new Error(issue);
    } finally { await debuggerSession.release(draft.id, attached); }
  }
  const key = 'flight-monitor-tab';
  let tab = await chrome.storage.local.get(key).then(value => value[key]);
  tab = Number.isInteger(tab) ? await chrome.tabs.get(tab).catch(() => null) : null;
  if (!tab || tab.url !== PLAN_URL) {
    tab = (await chrome.tabs.query({ url: 'https://fh.dji.com/*' })).find(t => t.url === PLAN_URL);
    if (tab) await chrome.storage.local.set({ [key]: tab.id });
  }
  if (!tab || tab.url !== PLAN_URL) {
    tab = await chrome.tabs.create({ url: PLAN_URL, active: false });
    await chrome.storage.local.set({ [key]: tab.id });
  }
  const deadline = Date.now() + 15000;
  while (tab.status !== 'complete' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    tab = await chrome.tabs.get(tab.id);
  }
  if (tab.url !== PLAN_URL || tab.status !== 'complete') throw new Error('司空计划列表未就绪');
  const attached = await debuggerSession.acquire(tab.id);
  try {
    const response = await evaluateBackgroundRead(chrome.debugger, tab.id, {
      expression: `(${readFlightStatus.toString()})(${JSON.stringify(job.name)}, ${JSON.stringify(PLAN_URL)})`,
      awaitPromise: true, returnByValue: true,
    });
    const result = evaluationValue(response);
    const current = await chrome.tabs.get(tab.id);
    if (current.url !== PLAN_URL || result.url !== PLAN_URL || result.name !== job.name) throw new Error('司空状态回执不匹配');
    return result;
  } finally { await debuggerSession.release(tab.id, attached); }
}
async function syncDjiTasks(job) {
  const project = PLAN_URL.split('#')[0];
  const tabs = await chrome.tabs.query({ url: 'https://fh.dji.com/*' });
  const oldKeys = ['flight-task-sync-tab', 'flight-task-history-tab'];
  const legacyMediaKey = 'flight-report-media-tab';
  const saved = await chrome.storage.local.get([...oldKeys, legacyMediaKey]);
  // Task metadata such as type, plan name, route name, and upload receipt is
  // read from the rendered plan table. A media/team page has the same project
  // URL prefix and valid login context, but no task rows; selecting it silently
  // drops those fields and makes the app show "航线未记录". Only reuse an
  // actual plan page, preferring the active one when several are open.
  const candidates = tabs.filter(tab => tab.status === 'complete' && tab.url === PLAN_URL)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.id - b.id);
  const tab = candidates.find(tab => !oldKeys.some(key => saved[key] === tab.id)) || candidates[0];
  if (!tab) throw new Error('请先登录并打开泰州项目，任务同步会复用该页面');
  const attached = await debuggerSession.acquire(tab.id);
  let result;
  try {
    const response = await evaluateBackgroundRead(chrome.debugger, tab.id, {
      expression: `(${readDjiTasks.toString()})(${JSON.stringify(tab.url)}, ${JSON.stringify({ cursor: job.cursor, includeHistory: job.includeHistory })})`,
      awaitPromise: true, returnByValue: true,
    });
    result = evaluationValue(response);
    if ((await chrome.tabs.get(tab.id)).url !== tab.url || result.url !== PLAN_URL) throw new Error('司空任务同步期间页面已切换');
  } finally { await debuggerSession.release(tab.id, attached); }
  // Retire only obsolete, extension-owned background list tabs, never a user's
  // active page, a changed page, or a flight draft/monitor page.
  const obsolete = [...new Set(['flight-task-sync-tab', 'flight-task-history-tab'].map(key => saved[key]))]
    .filter(id => Number.isInteger(id) && id !== tab.id && tabs.some(t => t.id === id && !t.active && t.url === PLAN_URL));
  const legacyMedia = tabs.find(t => t.id === saved[legacyMediaKey] && !t.active && t.url?.startsWith(project) && t.url.includes('#/media'));
  if (legacyMedia) await chrome.tabs.remove(legacyMedia.id).catch(() => {});
  if (obsolete.length) await chrome.tabs.remove(obsolete).catch(() => {});
  await chrome.storage.local.remove([...oldKeys.filter(key => !tabs.some(t => t.id === saved[key]) || obsolete.includes(saved[key])), legacyMediaKey]);
  return { ...result, mediaTabId: null };
}
async function syncDjiRoutes() {
  const project = PLAN_URL.split('#')[0];
  const tabs = await chrome.tabs.query({ url: 'https://fh.dji.com/*' });
  const candidates = tabs.filter(tab => tab.status === 'complete' && tab.url?.split('#')[0] === project)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.id - b.id);
  if (!candidates.length) throw new Error('请先登录并打开泰州项目，航线同步会复用该页面');
  let lastError;
  for (const tab of candidates) {
    let attached = false;
    try {
      attached = await debuggerSession.acquire(tab.id);
      const response = await evaluateBackgroundRead(chrome.debugger, tab.id, {
        expression: `(${readDjiRoutes.toString()})(${JSON.stringify(tab.url)})`,
        awaitPromise: true, returnByValue: true,
      });
      const result = evaluationValue(response);
      if ((await chrome.tabs.get(tab.id)).url !== tab.url || result.url !== PLAN_URL) throw new Error('司空航线同步期间页面已切换');
      return result;
    } catch (error) {
      lastError = error;
    } finally { await debuggerSession.release(tab.id, attached); }
  }
  throw lastError || new Error('司空航线同步失败，请重新验证司空登录状态');
}
async function bridgeTabs() {
  return (await chrome.tabs.query({ url: SITE_PATTERNS })).filter(tab => allowedUrl(tab.url)).slice(0, 100)
    .map(({ id, title, url, status }) => ({ id, title: (title || '').slice(0, 1000), url, status }));
}
function reportJob(job) { return ['flight-dji-list', 'flight-dji-image'].includes(job?.type); }
async function keepAlive() {
  if (keepingAlive || !keepAliveSupported) return;
  keepingAlive = true;
  try {
    // No CDP operations and no job claims while the existing batch runs.
    await post('heartbeat', { version: chrome.runtime.getManifest().version, tabs: await bridgeTabs(), busy: true });
  } catch {
    // A transient failure must not cancel or replay a potentially submitted job.
  } finally { keepingAlive = false; }
}
async function executeJob(job) {
  if (Number.isFinite(job.expiresAt) && Date.now() >= job.expiresAt) return null;
  if (!["dji-tasks", "dji-routes", "dji-weather", "dji-submit", "dji-open-prepared", "dji-status", "site-health", "jiangsu-health", "airins-health-open", "dji-health-open", "capture", "jiangsu-hourly", "dji-prepare", "flight-missions", "flight-airins", "flight-dji-list", "flight-dji-image", "airins-realtime"].includes(job.type) || !Number.isInteger(job.tabId)) return null;
  let result;
  try {
    result = { data: job.type === "dji-tasks" ? await syncDjiTasks(job) : job.type === "dji-routes" ? await syncDjiRoutes(job) : job.type === "dji-weather" ? await openDjiWeather(chrome, capture) : job.type === "dji-submit" ? await submitFlight(job) : job.type === "dji-open-prepared" ? await openPreparedFlight(job) : job.type === "dji-status" ? await watchFlight(job) : job.type === "dji-prepare" ? await prepareFlight(job) : job.type === "airins-realtime" ? await openAirinsRealtime(job) : job.type === 'airins-health-open' ? await openAirinsForHealth(chrome, capture) : job.type === 'dji-health-open' ? await openDjiForHealth(chrome, capture) : job.type === 'jiangsu-health' ? await prepareJiangsuForHealth(chrome, capture, {}, enterJiangsuBusiness) : await capture(job.tabId, job) };
  } catch (error) {
    result = { error: (error.message || String(error)).split("\n")[0].slice(0, 300) };
  }
  try { await post("complete", { id: job.id, ...result }); } catch { /* Never replay a job. */ }
  return result;
}
async function heartbeat() {
  if (polling) { rerunRequested = true; await keepAlive(); return; }
  polling = true;
  let preparedSite = false;
  try {
    const tabs = await bridgeTabs();
    await debuggerSession.maintain(tabs);
    const response = await post("heartbeat", { version: chrome.runtime.getManifest().version, tabs, singleJob: true, parallelReports: true, parallelReads: true, busy: readScheduler.busy() });
    if (response.parallelReadsSupported) {
      readScheduler.dispatch(response.jobs || []);
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: '桌面客户端已连接' });
      return;
    }
    keepAliveSupported = response.keepAliveSupported === true;
    // Return to native scheduling after every job so newly queued weather can
    // pass background work. Older clients retain the legacy batch protocol.
    if (response.singleJobSupported && response.jobs?.length) rerunRequested = true;
    const jobs = prioritizeHealthJobs(response.jobs || [], tabs);
    const serial = jobs.filter(job => !reportJob(job));
    const parallel = jobs.filter(reportJob);
    for (const job of serial) {
      const result = await executeJob(job);
      if (['airins-health-open', 'dji-health-open', 'jiangsu-health'].includes(job.type) && result?.data) preparedSite = true;
    }
    if (parallel.length) await Promise.all(parallel.map(executeJob));
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "桌面客户端已连接" });
  } catch {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#a66a3f" });
    await chrome.action.setTitle({ title: "桌面客户端未连接，请启动客户端" });
  } finally {
    polling = false;
    if (preparedSite || rerunRequested) {
      rerunRequested = false;
      void heartbeat();
    }
  }
}
function start() { void chrome.alarms.create("desktop-heartbeat", { periodInMinutes: 0.5 }); void heartbeat(); }
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "desktop-heartbeat") void heartbeat(); });
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.status || change.url) void heartbeat(); });
chrome.tabs.onRemoved.addListener(() => void heartbeat());
chrome.debugger.onDetach.addListener((source, reason) => { if (source.tabId !== undefined) debuggerSession.detached(source.tabId, reason); });
chrome.action.onClicked.addListener(() => { debuggerSession.resume(); void heartbeat(); });
// Only the extension's own pages can request status. Content scripts cannot request arbitrary CDP evaluation.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "page.ready") { void heartbeat(); respond({ ok: true }); }
  else if (message?.type === "bridge.status") { respond({ ok: true, capturing: capturing || activeReportCaptures > 0 || readScheduler.active() }); }
  else if (message?.type === 'flight.review.cancel' && sender.tab?.id) {
    if (!/^[a-f0-9-]{36}$/.test(message.eventId || '') || sender.url !== `${PLAN_URL}/create-plan`) {
      respond({ ok: false, error: '司空计划页面不匹配' }); return false;
    }
    const key = `flight-review-${message.eventId}`;
    void chrome.storage.local.get(key).then(async stored => {
      if (!stored[key] || stored[key].tabId !== sender.tab.id) { respond({ ok: false, error: '核对任务已结束' }); return; }
      try {
        await post('cancel-flight', { eventId: message.eventId });
        await chrome.storage.local.set({ [key]: { ...stored[key], canceled: true, canceledAt: Date.now() } });
        respond({ ok: true });
      } catch (error) {
        respond({ ok: false, error: error.message || '取消任务失败' });
      }
    }).catch(() => respond({ ok: false, error: '取消任务失败' }));
    return true;
  }
  else respond({ ok: false, error: "Unsupported message" });
  return false;
});
setInterval(() => void heartbeat(), 5000);
start();
