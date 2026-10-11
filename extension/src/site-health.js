import { findJiangsuApi } from './jiangsu.js';
import { PLAN_URL } from './flight-plan.js';

// Fixed read-only checks in the site's own context. Credentials never leave the page.
export function prioritizeHealthJobs(jobs, tabs) {
  const positions = jobs.flatMap((job, index) => ['site-health', 'jiangsu-health', 'airins-health-open', 'dji-health-open'].includes(job.type) ? [index] : []);
  const checks = positions.map(index => jobs[index]).sort((a, b) =>
    Number(b.type === 'airins-health-open' || tabs.some(tab => tab.id === b.tabId && tab.url.startsWith('https://aai.airins.cn/sniff'))) -
    Number(a.type === 'airins-health-open' || tabs.some(tab => tab.id === a.tabId && tab.url.startsWith('https://aai.airins.cn/sniff'))));
  const ordered = [...jobs];
  positions.forEach((index, order) => { ordered[index] = checks[order]; });
  return ordered;
}

async function openForHealth(chrome, capture, url, name, timing) {
  const now = timing.now || Date.now;
  const pause = timing.pause || (() => new Promise(resolve => setTimeout(resolve, 200)));
  const origin = new URL(url).origin;
  const tabs = (await chrome.tabs.query({ url: `${origin}/*` }))
    .filter(tab => new URL(tab.url).origin === origin);
  // The user may have opened a tab since the client's last heartbeat. Reuse it,
  // including loading/login pages, without replacing or activating their page.
  const tab = tabs.find(tab => new URL(tab.url).pathname === new URL(url).pathname)
    || tabs[0] || await chrome.tabs.create({ url, active: false });
  const deadline = now() + 20000;
  while (now() < deadline) {
    const current = await chrome.tabs.get(tab.id);
    if (new URL(current.url).origin !== origin) throw new Error(`${name}跳转到非授权网站，已停止验证`);
    if (current.status === 'complete') {
      const health = await capture(tab.id, { type: 'site-health' });
      if (new URL(health.url).origin !== origin) throw new Error(`${name}验证页面来源不匹配`);
      return { ...health, tabId: tab.id };
    }
    await pause();
  }
  throw new Error(`${name}页面加载超时，请检查 Chrome 或网络`);
}

export async function openAirinsForHealth(chrome, capture, timing = {}) {
  return openForHealth(chrome, capture, 'https://aai.airins.cn/sniff/HistoryCloud', '可飞', timing);
}

export async function openDjiForHealth(chrome, capture, timing = {}) {
  return openForHealth(chrome, capture, PLAN_URL, '司空', timing);
}

export async function checkSiteHealth(getJiangsuApi = findJiangsuApi) {
  const url = location.href;
  const result = (state, message) => ({ url: location.href, state, message });
  const origin = location.origin;
  if (!['http://61.155.4.60:18080', 'https://fh.dji.com', 'https://aai.airins.cn'].includes(origin)) throw new Error('非授权网站');
  const visible = el => el.getClientRects().length > 0;
  if (/[/#](login|signin)([/?#]|$)/i.test(url) || [...document.querySelectorAll('input[type="password"]')].some(visible)) return result('login_required', '请在 Chrome 中完成登录');
  const classify = response => {
    const code = response?.code;
    if ([401, 44001, '401', '44001'].includes(code)) return 'login_required';
    if ([403, '403'].includes(code)) return 'forbidden';
    return 'error';
  };
  try {
    if (origin === 'http://61.155.4.60:18080') {
      const api = getJiangsuApi();
      if (!api) return result('page_required', '正在等待江苏大气站 API 客户端加载');
      const response = await api.componentDeviceOption({ componentSiteType: 1, siteCodes: '321200', includeDeviceType: 'WEATHER,SO2,O3,CO,PM10,PM25,NOx', siteType: 'CITY' });
      if (response?.code !== 0 || !Array.isArray(response.data)) return result(classify(response), '指标目录读取失败，请检查登录或平台访问权限');
      return result('ready', '登录有效，泰州市指标目录可读取');
    }
    if (origin === 'https://aai.airins.cn') {
      if (!location.pathname.startsWith('/sniff')) return result('page_required', '请打开可飞历史任务页面');
      const response = await fetch('https://api-aai.airins.cn/api/met/sniff/mission_based/historical_data/mission/list', { credentials: 'include', signal: AbortSignal.timeout(12000) });
      if (response.status === 401) return result('login_required', '登录已过期，请重新登录可飞');
      if (response.status === 403) return result('forbidden', '当前账号无权读取可飞任务');
      if (!response.ok) return result('error', '可飞服务暂时不可用，请稍后重试');
      const body = await response.json();
      if (body.isSuccess !== true || !Array.isArray(body.data?.list)) return result(classify(body), '未取得任务列表，请检查登录状态或平台服务');
      return result('ready', '登录有效，历史任务可读取');
    }
    const project = '/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
    if (location.pathname.replace(/\/$/, '') !== project) return result('page_required', '请打开泰州环境监测项目');
    // Reuse the platform's existing HTTP client; do not inspect its headers/store.
    // Module and endpoint were verified in the platform's published frontend.
    const chunks = globalThis.webpackChunkmain_app;
    if (!Array.isArray(chunks)) return result('error', '司空页面结构已变化，暂不能验证登录');
    let request;
    chunks.push([[`taizhou-health-${Date.now()}`], {}, require => { request = require('4994').ZP; }]);
    if (typeof request?.get !== 'function') return result('error', '司空验证适配器不可用');
    const response = await request.get('/manage/api/v1/users/current', { timeout: 12000 });
    const body = response?.data;
    if (body?.code !== 0 || !body.data || typeof body.data !== 'object') return result(classify(body), '司空身份验证失败，请检查登录状态或访问权限');
    if (location.href !== url) return result('login_required', '验证期间页面跳转，请完成登录');
    return result('ready', '登录有效，泰州项目已打开');
  } catch (error) {
    if (location.href !== url && /login|signin/i.test(location.href)) return result('login_required', '登录已过期，请重新登录');
    const status = error?.response?.status;
    if (status === 401) return result('login_required', '登录已过期，请重新登录');
    if (status === 403) return result('forbidden', '当前账号无访问权限');
    return result('error', '验证未完成，请检查网络后重新检测；不能据此认定已登录');
  }
}
