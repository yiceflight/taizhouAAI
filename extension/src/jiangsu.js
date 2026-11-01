export const JIANGSU_URL = "http://61.155.4.60:18080/#/home/map";

// Vue installs $Ajax globally; no particular route/component is needed. This
// function is serialized into the source page together with each API task.
export function findJiangsuApi() {
  const queue = [document.querySelector('#app')?.__vue__].filter(Boolean);
  const seen = new Set();
  while (queue.length && seen.size < 3000) {
    const vm = queue.shift();
    if (seen.has(vm)) continue;
    seen.add(vm);
    if (typeof vm.$Ajax?.componentDeviceOption === 'function' && typeof vm.$Ajax?.photoTimeSeriesData === 'function' && typeof vm.$Ajax?.getNormalSixParamData === 'function') return vm.$Ajax;
    queue.push(...(vm.$children || []));
    if (vm.$parent) queue.push(vm.$parent);
  }
  return null;
}

// Use the site's launcher handler in this tab: its authenticated context is
// not necessarily available to a newly created tab or a direct business URL.
export function enterJiangsuAnalysis() {
  if (location.origin !== new URL("http://61.155.4.60:18080").origin || location.hash !== '#/login') throw new Error('江苏大气站入口已变化，请重新验证');
  const labels = ['综合分析', '离线分析', '数据管理', '运维中心', '温室气体'];
  const text = document.body?.innerText || '';
  if (!labels.every(label => text.includes(label)) || [...document.querySelectorAll('input[type="password"]')].some(el => el.getClientRects().length)) throw new Error('请先在江苏大气站完成登录');
  const entries = [...document.querySelectorAll('body *')].filter(el => el.textContent.trim() === '综合分析' && el.children.length === 0 && el.getClientRects().length > 0);
  if (entries.length !== 1) throw new Error('无法唯一识别综合分析入口，请手动进入后重新验证');
  entries[0].click();
  return { opened: true };
}

// Verify all existing source tabs before concluding that login is required.
// A stale login tab must not hide the user's authenticated map tab.
export async function prepareJiangsuForHealth(chrome, capture, timing = {}, enterBusiness) {
  const now = timing.now || Date.now;
  const pause = timing.pause || (() => new Promise(resolve => setTimeout(resolve, 250)));
  const origin = new URL(JIANGSU_URL).origin;
  const loginPage = url => /[/#](login|signin)([/?#]|$)/i.test(url);
  const tabs = (await chrome.tabs.query({ url: `${origin}/*` }))
    .filter(tab => new URL(tab.url).origin === origin)
    .sort((a, b) => Number(loginPage(a.url)) - Number(loginPage(b.url)) || a.id - b.id);
  if (!tabs.length) tabs.push(await chrome.tabs.create({ url: JIANGSU_URL, active: false }));
  const entered = new Set();
  const deadline = now() + 20000;
  const pending = new Set(tabs.map(tab => tab.id));
  let failure;
  while (pending.size && now() < deadline) {
    for (const id of [...pending]) {
      const tab = await chrome.tabs.get(id);
      if (new URL(tab.url).origin !== origin) throw new Error('江苏大气站跳转到非授权网站，已停止验证');
      if (tab.status !== 'complete') continue;
      const health = await capture(id, { type: 'site-health' }).catch(() => ({ url: tab.url, state: 'error', message: '此标签页验证失败，请检查页面或网络后重试' }));
      if (new URL(health.url).origin !== origin) throw new Error('江苏大气站验证页面来源不匹配');
      if (health.state === 'page_required' && health.needsBusinessPage === true && loginPage(health.url)) {
        if (!entered.size && enterBusiness) {
          entered.add(id);
          await enterBusiness(id);
          // Recheck this same tab after the website's asynchronous navigation.
          continue;
        }
        if (entered.has(id)) continue;
        pending.delete(id);
        failure ||= { url: health.url, tabId: id, state: 'page_required', message: '请进入综合分析后重新验证业务访问' };
        continue;
      }
      if (health.state === 'ready') return { ...health, tabId: id };
      // An unmounted app may become usable; login/error results are final for
      // this tab, but do not prevent checking other open source pages.
      if (health.state === 'page_required') continue;
      pending.delete(id);
      if (!failure || ['login_required', 'page_required'].includes(failure.state)) failure = { ...health, tabId: id };
    }
    if (pending.size) await pause();
  }
  if (pending.size) {
    const tab = await chrome.tabs.get([...pending][0]);
    return { url: tab.url, tabId: tab.id, state: 'error', message: '江苏大气站页面或 API 客户端加载超时，请检查网络后重新验证' };
  }
  return failure;
}

// Runs only in the authenticated source page. Its own API client retains all credentials.
// These methods/response fields were checked against the site's 2026-09-22 frontend.
export async function queryJiangsuHourly(startTime, endTime, getApi = findJiangsuApi) {
  if (location.origin !== "http://61.155.4.60:18080" || /[/#](login|signin)([/?#]|$)/i.test(location.href)) {
    throw new Error("江苏大气站登录状态已变化，请等待系统重新验证");
  }
  const url = location.href;
  const api = getApi();
  if (!api) throw new Error("江苏大气站 API 客户端尚未就绪或平台结构已变化");
  const check = (response) => {
    if (response?.code !== 0 || !Array.isArray(response.data)) throw new Error("江苏大气站查询失败，请检查登录状态后重试");
    return response.data;
  };
  const catalog = check(await api.componentDeviceOption({ componentSiteType: 1, siteCodes: "321200", includeDeviceType: "WEATHER,SO2,O3,CO,PM10,PM25,NOx", siteType: "CITY" }));
  const factors = catalog.filter((device) => device.deviceTypeCode === "IC").flatMap((device) => device.factorGroupList.flatMap((group) => group.factorList));
  const matches = factors.filter((factor) => ["K+", "钾离子"].includes(factor.factorName?.normalize("NFKC").replace(/\s/g, "")));
  const codes = [...new Set(matches.map((factor) => factor.factorCode))];
  if (codes.length !== 1) throw new Error("未能唯一识别泰州市 K+ 指标，请检查平台组分配置");
  const factor = matches[0];
  const unit = factor.unit?.normalize("NFKC").replace(/μ/g, "u").replace(/\s/g, "");
  if (unit !== "ug/m3") throw new Error("K+ 单位不是 μg/m³，暂停同步以避免错误换算");
  const params = { startTime, endTime, siteCode: "321200", siteType: "CITY", timeType: "HOUR", dataSource: "A_6" };
  const [particle, normal] = await Promise.all([
    api.photoTimeSeriesData({ ...params, queryFactor: factor.factorCode }),
    api.getNormalSixParamData({ ...params, commonSiteType: "30" }),
  ]);
  const series = check(particle).filter((item) => item.factorCode === factor.factorCode);
  if (series.length !== 1) throw new Error("K+ 查询未返回唯一时间序列");
  if (location.href !== url) throw new Error("查询期间页面已跳转，请等待系统重新验证登录状态");
  return { url: location.href, city: "泰州市", cityCode: "321200", unit: "μg/m³", dataSource: "A_6", commonSiteType: "30", startTime, endTime,
    potassium: { times: series[0].dataTimes, values: series[0].values },
    normal: check(normal).map((row) => ({ time: row.dataTime, pm25: row.pm25 })) };
}

export function normalizeHourly(raw) {
  const hour = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:00(?::00)?$/.test(value)) throw new Error("平台返回了非整点时间");
    const full = value.length === 16 ? `${value}:00` : value;
    const date = new Date(`${full.replace(" ", "T")}+08:00`);
    if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ") !== full) throw new Error("平台返回了无效时间");
    if (full < raw.startTime || full > raw.endTime) throw new Error("平台返回时间超出查询范围");
    return full;
  };
  const value = (input) => {
    if (input === null || input === undefined || (typeof input === "string" && ["", "--", "—", "-", "null"].includes(input.trim()))) return null;
    if (!["number", "string"].includes(typeof input) || (typeof input === "string" && !/^\d+(?:\.\d+)?$/.test(input.trim()))) throw new Error("平台返回无法识别的浓度值");
    const result = Number(input);
    if (!Number.isFinite(result) || result < 0) throw new Error("平台返回无效浓度值");
    return result;
  };
  if (!Array.isArray(raw.potassium?.times) || !Array.isArray(raw.potassium?.values) || raw.potassium.times.length !== raw.potassium.values.length) throw new Error("平台时间与指标数量不匹配");
  const rows = new Map();
  const add = (time, key, input) => {
    time = hour(time);
    const row = rows.get(time) || { time, potassium: null, pm25: null };
    if (row[`${key}Seen`]) throw new Error("平台返回重复的小时指标");
    row[key] = value(input); row[`${key}Seen`] = true; rows.set(time, row);
  };
  raw.potassium.times.forEach((time, i) => add(time, "potassium", raw.potassium.values[i]));
  if (!Array.isArray(raw.normal)) throw new Error("平台 PM2.5 时间序列缺失");
  raw.normal.forEach((row) => add(row.time, "pm25", row.pm25));
  const data = [...rows.values()].sort((a, b) => a.time.localeCompare(b.time));
  // Keep every source hour within the query window, including trailing missing
  // values. The latest reported hour must not fall back to an older reading.
  return { url: raw.url, city: raw.city, cityCode: raw.cityCode, unit: raw.unit, dataSource: raw.dataSource, commonSiteType: raw.commonSiteType, startTime: raw.startTime, endTime: raw.endTime, rows: data.map(({time, potassium, pm25}) => ({time, potassium, pm25})) };
}
