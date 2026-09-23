// Fixed read-only checks in the site's own context. Credentials never leave the page.
export async function checkSiteHealth() {
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
      if (location.hash.split('?')[0] !== '#/particle-analysis/feature-analysis/time-series') return result('page_required', '请打开颗粒物分析的时间序列页面');
      const queue = [document.querySelector('.time-series')?.__vue__, document.querySelector('#app')?.__vue__].filter(Boolean), seen = new Set();
      let vm;
      while (queue.length && seen.size < 3000) {
        const node = queue.shift(); if (seen.has(node)) continue; seen.add(node);
        if (node.$options?.name === 'PM-time-series') { vm = node; break; }
        queue.push(...(node.$children || [])); if (node.$parent) queue.push(node.$parent);
      }
      if (!vm?.$Ajax?.componentDeviceOption || !vm.$Ajax.photoTimeSeriesData) return result('page_required', '时间序列页面尚未就绪，请等待加载或重新打开');
      const response = await vm.$Ajax.componentDeviceOption({ componentSiteType: 1, siteCodes: '321200', includeDeviceType: 'WEATHER,SO2,O3,CO,PM10,PM25,NOx', siteType: 'CITY' });
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
