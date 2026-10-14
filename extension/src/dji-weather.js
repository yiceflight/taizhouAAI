import { PLAN_URL } from './flight-plan.js';

export const WEATHER_URL = PLAN_URL.replace('#/plan', '#/team');
// Use a dedicated background tab so a refresh neither navigates the user's
// project nor reuses an old component's cached forecast. No device commands.
export async function openDjiWeather(chrome, capture) {
  const { weatherTabId } = await chrome.storage.local.get('weatherTabId');
  let tab = weatherTabId && await chrome.tabs.get(weatherTabId).catch(() => null);
  if (tab?.url === WEATHER_URL) {
    // reload() resolves when navigation is requested, not when the new document
    // is ready. tabs.get() can still report the old document as complete then.
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(updated);
        error ? reject(error) : resolve();
      };
      const updated = (id, change) => {
        if (id === tab.id && change.status === 'complete') finish();
      };
      const timer = setTimeout(() => finish(new Error('司空气象页面加载超时')), 25000);
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.reload(tab.id).catch(finish);
    });
  }
  else {
    tab = await chrome.tabs.create({ url: WEATHER_URL, active: false });
    await chrome.storage.local.set({ weatherTabId: tab.id });
  }
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === 'complete') {
      if (current.url !== WEATHER_URL) throw new Error('请在 Chrome 登录司空并打开泰州项目后刷新天气');
      return capture(tab.id, { type: 'dji-weather' });
    }
    const target = current.pendingUrl || current.url;
    if (target && target !== 'about:blank' && target !== WEATHER_URL) throw new Error('司空气象页面发生跳转，请检查登录状态');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('司空气象页面加载超时');
}

// Serialized into the authorized FlightHub page. Tokens stay in that page.
// DOM is used only to locate Vue roots: never read rendered text or parse HTML.
export async function collectDjiWeather() {
  const projectId = 'c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
  const dockSn = 'AHRXNBN00A029A';
  const path = `/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/${projectId}`;
  const url = location.href;
  const origin = 'https://es-flight-api-cn.djigate.com';
  if (location.origin !== 'https://fh.dji.com' || location.pathname.replace(/\/$/, '') !== path || location.hash !== '#/team') throw new Error('司空气象项目不匹配');
  if (globalThis.CURRENT_BE_ENV_CONFIG?.server_url && globalThis.CURRENT_BE_ENV_CONFIG.server_url !== origin) throw new Error('请使用司空中国区服务');
  const token = localStorage.getItem('x-user-token');
  const auth = token ? null : localStorage.getItem('x-auth-token');
  if (!token && !auth) throw new Error('请在 Chrome 登录司空后刷新天气');
  const request = async (endpoint, body) => {
    let response;
    try {
      response = await fetch(origin + endpoint, {
        method: body ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { ...(token ? { 'X-User-Token': token } : { 'X-Auth-Token': auth }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000),
      });
    } catch { throw new Error('司空气象接口连接失败，请检查网络和登录状态'); }
    if (!response.ok) throw new Error(`司空气象接口 HTTP ${response.status}，请检查登录和项目权限`);
    const raw = await response.json().catch(() => { throw new Error('司空气象响应格式无效'); });
    if (raw.code !== 0) throw new Error('司空气象接口未返回有效数据，请检查登录和项目权限');
    if (location.href !== url) throw new Error('气象读取期间页面已切换');
    return raw.data;
  };
  const topology = await request(`/manage/api/v1/projects/${projectId}/topologies`);
  const docks = (topology?.list || []).flatMap(item => item.parents || []).filter(item => item.device_sn === dockSn);
  if (docks.length !== 1 || docks[0].device_model?.key !== '3-3-0' || docks[0].device_online_status !== true) throw new Error('泰州环境监测机场离线或设备身份不匹配');
  const components = selector => {
    const q = [...document.querySelectorAll(selector)].map(e => e.__vue__).filter(Boolean), seen = new Set();
    while (q.length && seen.size < 5000) {
      const v = q.shift();
      if (!v || seen.has(v) || v._isDestroyed) continue;
      seen.add(v); q.push(...(v.$children || []));
    }
    return [...seen];
  };
  const weather = () => components('#real-time-app-container,#__qiankun_microapp_wrapper_for_real_time_app__ *')
    .filter(v => v.$options?.name === 'WeatherFullDisplay' && v.currentDeviceDetail?.device_sn === dockSn);
  let opened = false, component;
  let waitingFor = '机场设备卡片尚未加载';
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (location.href !== url) throw new Error('气象读取期间页面已切换');
    const matches = weather();
    if (matches.length > 1) throw new Error('司空气象组件不唯一，暂不能判断');
    if (opened && !matches.length) waitingFor = '机场详情已打开，气象组件尚未加载';
    if (matches.length === 1) waitingFor = '司空适飞结论尚未就绪';
    if (matches.length === 1 && matches[0].airworthy > 0) {
      const candidate = matches[0], osd = candidate.currentDeviceThingProperties;
      const config = [...(candidate.fullWeatherConfig || []), ...(candidate.fullWeatherOnlineConfig || [])]
        .filter(c => c.key !== 'IonosphericOnline' || candidate.ionosphereHintVisible);
      const missing = typeof candidate.getWeatherData === 'function' ? config.filter(c => {
        const item = candidate.getWeatherData(c);
        return typeof item?.value !== 'string' || ['--', 'N/A', 'NA', ''].includes(item.value.trim());
      }) : config;
      const complete = config.length > 0 && typeof candidate.getWeatherData === 'function' && !missing.length;
      waitingFor = !complete ? `气象条目未就绪${missing.length ? `（${missing.map(c => c.key).join('、')}）` : ''}`
        : candidate.currentDeviceDetail?.device_online_status !== true ? '机场实时在线状态未就绪'
        : !Number.isFinite(osd?.osd_timestamp) ? '尚未收到机场实时遥测'
        : '机场实时遥测时间过期或异常';
      if (complete && candidate.currentDeviceDetail?.device_online_status === true && Number.isFinite(osd?.osd_timestamp)
          && Date.now() - osd.osd_timestamp <= 120000 && Date.now() - osd.osd_timestamp >= -60000) { component = candidate; break; }
    }
    if (!opened && !matches.length) {
      const cards = components('#project-app-container,#__qiankun_microapp_wrapper_for_project_app__ *')
        .filter(v => v.$options?.name === 'TsaDeviceItem' && v.device?.parents?.some(p => p.device_sn === dockSn) && typeof v.onOpenLiveDetail === 'function');
      if (cards.length === 1) { cards[0].onOpenLiveDetail(); opened = true; }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!component) throw new Error(`司空气象未就绪：${waitingFor}；请稍后刷新天气`);
  const p = component.currentDeviceThingProperties;
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  if (!finite(p?.latitude) || !finite(p?.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) throw new Error('机场坐标缺失');
  const coordinates = { latitude: p.latitude, longitude: p.longitude };
  const forecast = await request('/manage/api/v1/common/weather-report/v2', coordinates);
  const now = Date.now();
  const hourly = (forecast?.hourly || []).filter(h => Number.isFinite(Date.parse(h.time)) && Date.parse(h.time) <= now && now - Date.parse(h.time) <= 3600000).sort((a,b) => Date.parse(b.time) - Date.parse(a.time))[0];
  if (!hourly) throw new Error('司空预报缺少当前时段数据');
  // These properties are FlightHub's decoded WebSocket OSD API values, not DOM.
  const current = component.currentDeviceThingProperties;
  if (component.currentDeviceDetail?.device_sn !== dockSn || current.latitude !== coordinates.latitude || current.longitude !== coordinates.longitude) throw new Error('气象读取期间机场或坐标发生变化，请刷新');
  if (component._isDestroyed || component.currentDeviceDetail?.device_online_status !== true || !finite(current?.osd_timestamp) || now - current.osd_timestamp > 120000 || now - current.osd_timestamp < -60000) throw new Error('机场实测气象已过期或设备离线');
  if (![current.wind_speed, current.rainfall, current.environment_temperature].every(finite)) throw new Error('机场实测气象不完整');
  if (![1,2,3].includes(component.airworthy) || typeof component.getTipByAirworthy !== 'string' || !component.getTipByAirworthy.trim()) throw new Error('司空适飞结论不可用');
  const configs = [...component.fullWeatherConfig, ...component.fullWeatherOnlineConfig];
  const items = configs.filter(c => c.key !== 'IonosphericOnline' || component.ionosphereHintVisible).map(c => {
    const value = component.getWeatherData(c);
    if (typeof value?.value !== 'string' || ![1,2,3].includes(value.level) || ['--','N/A','NA',''].includes(value.value.trim())) throw new Error('司空气象组件数据不完整');
    return { key: c.key, label: component.$t(c.label), value: value.value, level: value.level };
  });
  if (location.href !== url) throw new Error('气象读取期间页面已切换');
  return { url, projectId, dockSn, adapterVersion: 1,
    observedAt: Math.floor(current.osd_timestamp / 1000), fetchedAt: Math.floor(now / 1000),
    latitude: current.latitude, longitude: current.longitude,
    temperature: current.environment_temperature, windSpeed: current.wind_speed, rainfall: current.rainfall,
    airworthy: component.airworthy, label: component.getTipByAirworthy, items,
    forecast: { observedAt: Math.floor(Date.parse(hourly.time) / 1000), condition: hourly.text, temperature: hourly.temp, humidity: hourly.humidity, precipitation: hourly.precip },
  };
}
