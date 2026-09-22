export const JIANGSU_URL = "http://61.155.4.60:18080/#/particle-analysis/feature-analysis/time-series";

// Runs only in the authenticated source page. Its own API client retains all credentials.
// These methods/response fields were checked against the site's 2026-09-22 frontend.
export async function queryJiangsuHourly(startTime, endTime) {
  if (location.origin !== "http://61.155.4.60:18080" || location.hash.split("?")[0] !== "#/particle-analysis/feature-analysis/time-series") {
    throw new Error("请先登录江苏大气站并打开颗粒物分析的时间序列页面");
  }
  const root = document.querySelector(".time-series");
  const queue = [root?.__vue__, document.querySelector("#app")?.__vue__].filter(Boolean);
  const visited = new Set();
  let vm;
  while (queue.length && visited.size < 3000) {
    const candidate = queue.shift();
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (candidate.$options?.name === "PM-time-series") { vm = candidate; break; }
    queue.push(...(candidate.$children || []));
    if (candidate.$parent) queue.push(candidate.$parent);
  }
  if (!vm?.$Ajax?.photoTimeSeriesData || !vm.$Ajax.getNormalSixParamData) throw new Error("时间序列页面尚未就绪或平台结构已变化");
  const check = (response) => {
    if (response?.code !== 0 || !Array.isArray(response.data)) throw new Error("江苏大气站查询失败，请检查登录状态后重试");
    return response.data;
  };
  const catalog = check(await vm.$Ajax.componentDeviceOption({ componentSiteType: 1, siteCodes: "321200", includeDeviceType: "WEATHER,SO2,O3,CO,PM10,PM25,NOx", siteType: "CITY" }));
  const factors = catalog.filter((device) => device.deviceTypeCode === "IC").flatMap((device) => device.factorGroupList.flatMap((group) => group.factorList));
  const matches = factors.filter((factor) => ["K+", "钾离子"].includes(factor.factorName?.normalize("NFKC").replace(/\s/g, "")));
  const codes = [...new Set(matches.map((factor) => factor.factorCode))];
  if (codes.length !== 1) throw new Error("未能唯一识别泰州市 K+ 指标，请检查平台组分配置");
  const factor = matches[0];
  const unit = factor.unit?.normalize("NFKC").replace(/μ/g, "u").replace(/\s/g, "");
  if (unit !== "ug/m3") throw new Error("K+ 单位不是 μg/m³，暂停同步以避免错误换算");
  const params = { startTime, endTime, siteCode: "321200", siteType: "CITY", timeType: "HOUR", dataSource: "A_6" };
  const [particle, normal] = await Promise.all([
    vm.$Ajax.photoTimeSeriesData({ ...params, queryFactor: factor.factorCode }),
    vm.$Ajax.getNormalSixParamData({ ...params, commonSiteType: "30" }),
  ]);
  const series = check(particle).filter((item) => item.factorCode === factor.factorCode);
  if (series.length !== 1) throw new Error("K+ 查询未返回唯一时间序列");
  if (location.hash.split("?")[0] !== "#/particle-analysis/feature-analysis/time-series") throw new Error("查询期间页面已跳转，请重新登录并打开时间序列页");
  return { url: location.href, city: "泰州市", cityCode: "321200", unit: "μg/m³", dataSource: "A_6", commonSiteType: "30", startTime, endTime, potassium: { times: series[0].dataTimes, values: series[0].values }, normal: check(normal).map((row) => ({ time: row.dataTime, pm25: row.pm25 })) };
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
  if (!Array.isArray(raw.potassium?.times) || !Array.isArray(raw.potassium?.values) || raw.potassium.times.length !== raw.potassium.values.length || !Array.isArray(raw.normal)) throw new Error("平台时间与指标数量不匹配");
  const rows = new Map();
  const add = (time, key, input) => {
    time = hour(time);
    const row = rows.get(time) || { time, potassium: null, pm25: null };
    if (row[`${key}Seen`]) throw new Error("平台返回重复的小时指标");
    row[key] = value(input); row[`${key}Seen`] = true; rows.set(time, row);
  };
  raw.potassium.times.forEach((time, i) => add(time, "potassium", raw.potassium.values[i]));
  raw.normal.forEach((row) => add(row.time, "pm25", row.pm25));
  const data = [...rows.values()].sort((a, b) => a.time.localeCompare(b.time));
  // Future/empty trailing slots are not observations. Missing values inside a reported interval remain null.
  const latest = data.filter((row) => row.potassium !== null || row.pm25 !== null).at(-1)?.time;
  return { url: raw.url, city: raw.city, cityCode: raw.cityCode, unit: raw.unit, dataSource: raw.dataSource, commonSiteType: raw.commonSiteType, startTime: raw.startTime, endTime: raw.endTime, rows: data.filter((row) => latest && row.time <= latest).map(({time, potassium, pm25}) => ({time, potassium, pm25})) };
}
