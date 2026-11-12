import { findJiangsuApi } from './jiangsu.js';
import { PLAN_URL } from './flight-plan.js';

// A SPA can replace its execution context during a read. Retry only this
// transport failure, on the same loaded URL, rather than waiting for the next
// 30-second readiness cycle. Never retry auth results or arbitrary failures.
async function captureStableHealth(chrome, capture, tabId, timing = {}) {
  const original = await chrome.tabs.get(tabId);
  const now = timing.now || Date.now;
  const pause = timing.pause || (() => new Promise(resolve => setTimeout(resolve, 200)));
  try {
    return await capture(tabId, { type: 'site-health' });
  } catch (error) {
    if (!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/.test(error?.message || '')) throw error;
    const deadline = now() + 2000;
    while (now() < deadline) {
      await pause();
      const current = await chrome.tabs.get(tabId);
      if (current.url !== original.url || (current.pendingUrl && current.pendingUrl !== original.url)) throw error;
      if (current.status === 'complete') return capture(tabId, { type: 'site-health' });
    }
    throw error;
  }
}

// Actual tab activation is serialized across concurrent site checks. Do not
// focus the browser window, and do not undo a tab switch made by the user.
let activationTail = Promise.resolve();
export async function captureHealth(chrome, capture, tabId, timing = {}) {
  const report = timing.progress || (async () => {});
  const pause = timing.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = timing.now || Date.now;
  const original = await chrome.tabs.get(tabId);
  const origin = new URL(original.url).origin;
  if (!['http://61.155.4.60:18080', 'https://fh.dji.com', 'https://aai.airins.cn'].includes(origin)) throw Error('非授权网站');
  // The readiness check keeps returning to this page. Opt it out of Chrome's
  // automatic discarding so it is not asleep, and white, at the next pass.
  if (original.autoDiscardable === true) await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  const samePage = async () => {
    if (Number.isFinite(timing.deadline) && now() >= timing.deadline) throw Error('本轮验证已超时，请重新验证');
    const tab = await chrome.tabs.get(tabId);
    if (tab.url !== original.url || (tab.pendingUrl && tab.pendingUrl !== original.url)) throw Error('验证期间页面已切换，请重新验证');
    return tab;
  };
  const read = async () => {
    await report('reading');
    try {
      return await captureStableHealth(chrome, capture, tabId, timing);
    } catch (error) {
      // A wedged/white renderer never returns the normal blank-page result;
      // CDP only reports a read timeout. Recover it in this same health pass
      // so the UI can distinguish a broken page from an expired login instead
      // of waiting for the next 30–45 second poll cycle.
      if (!/后台页面读取超时/.test(error?.message || '')) throw error;
      try {
        if (await reload()) return await captureStableHealth(chrome, capture, tabId, timing);
      } catch (recoveryError) {
        if (/页面已切换|验证期间页面已切换/.test(recoveryError?.message || '')) throw recoveryError;
      }
      return {
        url: original.url,
        state: 'error',
        reason: 'renderer_timeout',
        message: '页面读取超时，已检查页面并尝试刷新；请确认是否白屏或需要重新登录',
      };
    }
  };
  // Persist the cooldown across service-worker suspension. Only recover the
  // business page, never a login page or a page the user navigated to.
  let reloaded = false;
  const reloadAllowed = async () => {
    if (original.url.startsWith(`${PLAN_URL}/create-plan`)) return false;
    if (timing.canReload && !await timing.canReload()) return false;
    if (origin === 'https://fh.dji.com') {
      const saved = await chrome.storage.local.get(null);
      if (Object.entries(saved).some(([key, value]) => /^flight-[a-f0-9-]{36}$/.test(key) && value === tabId)) return false;
    }
    return true;
  };
  const reload = async () => {
    if (/[/#](login|signin)([/?#]|$)/i.test(original.url) || reloaded) return false;
    if (!await reloadAllowed()) return false;
    await samePage();
    const key = `siteHealthReload:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    if (stored[key] != null && now() - stored[key] < 120000) return false;
    await chrome.storage.session.set({[key]: now()});
    await report('loading');
    await samePage();
    if (!await reloadAllowed()) return false;
    reloaded = true;
    await chrome.tabs.reload(tabId);
    const deadline = now() + 20000;
    while (now() < deadline) {
      await pause(250);
      const current = await samePage();
      if (current.status === 'complete' && !current.discarded && !current.frozen) {
        await pause(750);
        await samePage();
        return true;
      }
    }
    throw Error('网站页面自动刷新后仍未加载完成，请检查网络或登录状态');
  };
  const recoverBlank = async result => {
    if (result.state !== 'error' || result.reason !== 'blank_page') return result;
    // Give a transient SPA render a chance before interrupting it with reload.
    await pause(1500);
    await samePage();
    const confirmed = await read();
    if (confirmed.state !== 'error' || confirmed.reason !== 'blank_page') return confirmed;
    if (await reload()) return read();
    return confirmed;
  };
  const activate = async () => {
    await report('focus_wait');
    const previous = activationTail;
    let release;
    activationTail = new Promise(resolve => { release = resolve; });
    await previous;
    let active, activated = false;
    // An activated page can stay white with status "complete". On a slow PC
    // its script may be skipped once the tab goes back to the background.
    // Reload it in place while it is visible before handing focus back.
    const recoverVisible = async (result, settle) => {
      if (!activated) return result;
      if (!(result.state === 'error' && (result.reason === 'blank_page' || result.reason === 'renderer_timeout'))) return result;
      if (!await reload()) return result;
      // A reloaded SPA can report a finished document before its router draws.
      // Let it render while the tab is visible rather than handing focus back
      // to a white page that only recovers after a manual refresh.
      if (settle) await pause(3000);
      return recoverBlank(await read());
    };
    try {
      const tab = await samePage();
      [active] = await chrome.tabs.query({active:true,windowId:tab.windowId});
      await report(tab.discarded || tab.frozen ? 'waking' : 'activating');
      await chrome.tabs.update(tabId, {active:true});
      activated = true;
      const deadline = now() + 20000;
      while (true) {
        await pause(250);
        const current = await samePage();
        if (current.status === 'complete' && !current.discarded && !current.frozen) break;
        if (now() >= deadline) {
          if (await reload()) return await recoverVisible(await read(), true);
          throw Error('页面唤醒超时，请打开网站检查白屏或登录状态');
        }
      }
      // Allow the visible SPA a render turn before reading its login/API state.
      await pause(1500);
      await samePage();
      return recoverVisible(await read(), true);
    } finally {
      try {
        if (activated && active && active.id !== tabId) {
          const current = await chrome.tabs.get(tabId).catch(() => null);
          if (current?.active && await chrome.tabs.get(active.id).catch(() => null)) await chrome.tabs.update(active.id, {active:true});
        }
      } catch { /* The user may close or move either tab during recovery. */ }
      finally { release(); }
    }
  };
  if (original.discarded || original.frozen) return activate();
  let result;
  try { result = await read(); }
  catch (error) {
    if (original.active && original.status === 'complete') throw error;
    await samePage();
    return activate();
  }
  if (!original.active && result.state === 'error' && (origin === 'https://aai.airins.cn' || result.reason === 'blank_page')) return activate();
  return recoverBlank(result);
}

// Fixed read-only checks in the site's own context. Platform credentials are
// sent only to their fixed platform endpoint, never returned to the bridge.
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
  await timing.progress?.('loading');
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
    if (current.status === 'complete' || current.discarded || current.frozen) {
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
  if ([...document.querySelectorAll('input[type="password"]')].some(visible)) return result('login_required', '请在 Chrome 中完成登录');
  if (/[/#](login|signin)([/?#]|$)/i.test(url)) {
    // Jiangsu keeps #/login for its module launcher after sign-in. The launcher
    // is only a cue to open a business page; its appearance never proves API access.
    const text = document.body?.innerText || '';
    if (origin === 'http://61.155.4.60:18080' && ['综合分析', '离线分析', '数据管理', '运维中心', '温室气体'].every(label => text.includes(label))) {
      return { ...result('page_required', '已进入平台入口，正在验证业务访问'), needsBusinessPage: true };
    }
    return result('login_required', '请在 Chrome 中完成登录');
  }
  if (document.body && !document.body.innerText?.trim() && !document.body.querySelector?.('canvas, iframe')) return { ...result('error', '网站页面仍为空白，正在尝试自动恢复'), reason: 'blank_page' };
  const classify = response => {
    const code = response?.code;
    if ([401, 44001, 200401, '401', '44001', '200401'].includes(code)) return 'login_required';
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
    // FlightHub's module IDs change on releases. Use its fixed identity API
    // directly, with the same user-token-first convention as its web client.
    // Never accept a page-supplied destination or follow a credentialed redirect.
    const apiOrigin = 'https://es-flight-api-cn.djigate.com';
    if (globalThis.CURRENT_BE_ENV_CONFIG?.server_url && globalThis.CURRENT_BE_ENV_CONFIG.server_url !== apiOrigin) {
      return result('error', '请使用司空中国区服务后重新验证');
    }
    const userToken = localStorage.getItem('x-user-token');
    const authToken = userToken ? null : localStorage.getItem('x-auth-token');
    if (!userToken && !authToken) return result('login_required', '未取得司空登录状态，请在 Chrome 中完成登录');
    // Retry one transient transport/service failure within the original 12s
    // budget. Auth failures remain immediate; never report cached success.
    const signal = AbortSignal.timeout(12000);
    const request = () => fetch(`${apiOrigin}/manage/api/v1/users/current`, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: userToken ? { 'X-User-Token': userToken } : { 'X-Auth-Token': authToken },
      signal,
    });
    let response, retried = false;
    try { response = await request(); }
    catch (error) {
      if (signal.aborted || location.href !== url) throw error;
      retried = true;
      response = await request();
    }
    if ([502, 503, 504].includes(response.status) && !retried && !signal.aborted && location.href === url) {
      response = await request();
    }
    const changedPage = () => location.href !== url
      ? result(/[/#](login|signin)([/?#]|$)/i.test(location.href) ? 'login_required' : 'page_required', '验证期间页面已切换，请重新验证') : null;
    if (changedPage()) return changedPage();
    if (response.status === 401) return result('login_required', '登录已过期，请重新登录司空');
    if (response.status === 403) return result('forbidden', '当前账号无权访问司空');
    if (!response.ok) return result('error', '司空服务暂时不可用，请稍后重试');
    const body = await response.json();
    if (changedPage()) return changedPage();
    if (body?.code !== 0 || typeof body.data?.user_id !== 'string' || !body.data.user_id.trim()) {
      return result(classify(body), '司空身份验证失败，请检查登录状态或访问权限');
    }
    return result('ready', '登录有效，泰州项目已打开');
  } catch (error) {
    if (location.href !== url && /login|signin/i.test(location.href)) return result('login_required', '登录已过期，请重新登录');
    const status = error?.response?.status;
    if (status === 401) return result('login_required', '登录已过期，请重新登录');
    if (status === 403) return result('forbidden', '当前账号无访问权限');
    return result('error', error?.name === 'TimeoutError' || error?.name === 'AbortError' ? '网站接口响应超时，请检查网络或平台服务后重试' : '网站接口读取失败，请检查网络、登录状态或平台服务后重试');
  }
}
