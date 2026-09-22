import { airinsReport, djiReport } from './flight-report.js';
import { SITE_PATTERNS, allowedUrl, evaluationValue, pageSnapshot } from "./bridge-core.js";
import { queryJiangsuHourly, normalizeHourly } from "./jiangsu.js";
import { PLAN_URL, PLAN_RECIPE, validatePlanJob, fillFlightPlan } from "./flight-plan.js";
const ENDPOINT = "http://127.0.0.1:14520";
const sessionReady = (async () => {
  const saved = await chrome.storage.local.get("bridgeSession");
  if (saved.bridgeSession) return saved.bridgeSession;
  const session = crypto.randomUUID();
  await chrome.storage.local.set({ bridgeSession: session });
  return session;
})();
let polling = false;
let capturing = false;

async function post(path, body) {
  const response = await fetch(`${ENDPOINT}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Taizhou-Bridge": "1" },
    body: JSON.stringify({ session: await sessionReady, ...body }), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`客户端连接失败 (${response.status})`);
  return response.json();
}
async function capture(tabId, job) {
  if (capturing) throw new Error("另一个采集正在执行，请稍后重试");
  capturing = true;
  let attached = false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!allowedUrl(tab.url)) throw new Error("仅支持三个已授权业务网站");
    if (tab.status !== "complete") throw new Error("页面尚未加载完成");
    if (job?.type?.startsWith('flight-dji')) await chrome.tabs.update(tabId,{active:true});
    await chrome.debugger.attach({ tabId }, "1.3"); attached = true;
    const flight = job?.type?.startsWith('flight-');
    const expression = flight ? `(${(job.type.startsWith('flight-dji') ? djiReport : airinsReport).toString()})(${JSON.stringify(job)})` : null;
    const response = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: expression || (job?.type === "jiangsu-hourly" ? `Promise.race([(${queryJiangsuHourly.toString()})(${JSON.stringify(job.startTime)}, ${JSON.stringify(job.endTime)}), new Promise((_, reject) => setTimeout(() => reject(new Error("江苏大气站查询超时")), 35000))])` : `(${pageSnapshot.toString()})()`), awaitPromise: true, returnByValue: true,
    });
    const data = evaluationValue(response);
    const current = await chrome.tabs.get(tabId);
    if (!allowedUrl(data.url) || current.url !== data.url || new URL(data.url).origin !== new URL(tab.url).origin) throw new Error("采集期间页面发生跳转，请重试");
    if (flight) {
      if (job.type === 'flight-dji-image' && !data.dataUrl) throw new Error('未取得照片原图，请关闭照片预览后重试；若持续失败，请更新司空适配器');
      if (new TextEncoder().encode(JSON.stringify(data)).length > 20000000) throw new Error('巡飞资料超过单次传输限制');
      return data;
    }
    if (job?.type === "jiangsu-hourly") return normalizeHourly(data);
    if (!data.text && data.tables.length === 0) throw new Error("页面没有可采集的正文或表格；请登录并打开具体业务页面");
    return data;
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    capturing = false;
  }
}
async function prepareFlight(job) {
  validatePlanJob(job);
  if (capturing) throw new Error("另一个任务正在执行，请稍后重试");
  capturing = true;
  let tabId;
  let attached = false;
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
    await chrome.debugger.attach({ tabId }, "1.3"); attached = true;
    const response = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `(${fillFlightPlan.toString()})(${JSON.stringify(PLAN_RECIPE)}, ${JSON.stringify(job.name)}, ${JSON.stringify(PLAN_URL)})`,
      awaitPromise: true, returnByValue: true,
    });
    const result = evaluationValue(response);
    const current = await chrome.tabs.get(tabId);
    if (result.status !== "ready" || result.submitted !== false || result.name !== job.name || current.url !== result.url) throw new Error("司空填写回执不匹配，请检查页面");
    return result;
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    capturing = false;
  }
}
async function heartbeat() {
  if (polling) return;
  polling = true;
  try {
    const tabs = (await chrome.tabs.query({ url: SITE_PATTERNS })).filter((tab) => allowedUrl(tab.url)).slice(0, 100)
      .map(({ id, title, url, status }) => ({ id, title: (title || "").slice(0, 1000), url, status }));
    const response = await post("heartbeat", { version: chrome.runtime.getManifest().version, tabs });
    for (const job of response.jobs || []) {
      if (!["capture", "jiangsu-hourly", "dji-prepare", "flight-missions", "flight-airins", "flight-dji-list", "flight-dji-image"].includes(job.type) || !Number.isInteger(job.tabId)) continue;
      let result;
      try { result = { data: job.type === "dji-prepare" ? await prepareFlight(job) : await capture(job.tabId, job) }; }
      catch (error) { result = { error: (error.message || String(error)).split("\n")[0].slice(0, 300) }; }
      await post("complete", { id: job.id, ...result });
    }
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "桌面客户端已连接" });
  } catch {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#a66a3f" });
    await chrome.action.setTitle({ title: "桌面客户端未连接，请启动客户端" });
  } finally { polling = false; }
}
function start() { void chrome.alarms.create("desktop-heartbeat", { periodInMinutes: 0.5 }); void heartbeat(); }
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "desktop-heartbeat") void heartbeat(); });
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.status || change.url) void heartbeat(); });
chrome.tabs.onRemoved.addListener(() => void heartbeat());
chrome.action.onClicked.addListener(() => void heartbeat());
// Only the extension's own pages can request status. Content scripts cannot request arbitrary CDP evaluation.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "page.ready") { void heartbeat(); respond({ ok: true }); }
  else if (message?.type === "bridge.status") { respond({ ok: true, capturing }); }
  else respond({ ok: false, error: "Unsupported message" });
  return false;
});
setInterval(() => void heartbeat(), 5000);
start();
