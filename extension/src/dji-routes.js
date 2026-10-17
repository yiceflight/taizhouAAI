// Read-only FlightHub route library API, executed in an existing project page.
// Credentials stay in that page and are sent only to the fixed DJI API origin.
export async function readDjiRoutes(expectedUrl) {
  const projectId = 'c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
  const orgId = 'b9fb201d-b230-433d-a1d5-e47736ca06f0';
  // The web wayline library is scoped to the project's root folder. This is
  // the parent id used by the FlightHub web client for the fixed TaiZhou
  // project; the old OpenAPI route endpoint does not expose this library.
  const parentId = '3f4c4581-41e6-4a1c-b426-3770687470d1';
  const projectPath = `/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/${projectId}`;
  const origin = 'https://es-flight-api-cn.djigate.com';
  if (location.href !== expectedUrl || location.origin !== 'https://fh.dji.com' || location.pathname.replace(/\/$/, '') !== projectPath) throw new Error('司空航线项目不匹配');
  if (globalThis.CURRENT_BE_ENV_CONFIG?.server_url && globalThis.CURRENT_BE_ENV_CONFIG.server_url !== origin) throw new Error('请使用司空中国区服务');
  // FlightHub has used both localStorage and sessionStorage for the same
  // browser session across releases. Keep the values in the page and try the
  // current storage first, then the alternate store before falling back to the
  // page cookie. This also lets a newly refreshed token recover when an old
  // localStorage value is still present.
  const readStorage = (storage, key) => {
    try {
      const pageStorage = storage === 'localStorage'
        ? (typeof localStorage !== 'undefined' ? localStorage : globalThis[storage])
        : (typeof sessionStorage !== 'undefined' ? sessionStorage : globalThis[storage]);
      return pageStorage?.getItem(key) || null;
    } catch { return null; }
  };
  const credentials = [
    ['localStorage', 'x-auth-token'],
    ['localStorage', 'x-user-token'],
    ['sessionStorage', 'x-auth-token'],
    ['sessionStorage', 'x-user-token'],
  ].map(([storage, key]) => {
    const value = readStorage(storage, key);
    return value ? { key, value } : null;
  }).filter(Boolean);
  const attempts = [];
  const seen = new Set();
  const addAttempt = (headers, credentialsMode = 'omit') => {
    const key = `${credentialsMode}:${Object.entries(headers).sort().map(([name, value]) => `${name}:${value}`).join('|')}`;
    if (!seen.has(key)) { seen.add(key); attempts.push({ headers, credentials: credentialsMode }); }
  };
  // This web-waylines endpoint is the same request used by FlightHub's route
  // library. In the current China deployment the x-auth-token value is sent
  // as X-Auth-Token; retain X-User-Token as a fallback for older sessions.
  for (const credential of credentials) addAttempt({ [credential.key === 'x-auth-token' ? 'X-Auth-Token' : 'X-User-Token']: credential.value });
  const user = credentials.find(item => item.key === 'x-user-token')?.value;
  const auth = credentials.find(item => item.key === 'x-auth-token')?.value;
  if (user && auth) addAttempt({ 'X-User-Token': user, 'X-Auth-Token': auth });
  // Some FlightHub deployments validate the page session cookie in addition
  // to the token header. Keep the official header-only attempts first, then
  // retry the same credentials with the page cookie attached.
  for (const credential of credentials) addAttempt({ [credential.key === 'x-auth-token' ? 'X-Auth-Token' : 'X-User-Token']: credential.value }, 'include');
  if (user && auth) addAttempt({ 'X-User-Token': user, 'X-Auth-Token': auth }, 'include');
  if (!credentials.length) addAttempt({}, 'include');
  const query = new URLSearchParams({ parent_id: parentId, size: '20', key: '', order_by: 'update_time desc', file_type: '5', page: '1' });
  let result;
  let lastAuthMessage = '';
  for (let index = 0; index < attempts.length; index += 1) {
    let response;
    try {
      response = await fetch(`${origin}/wayline/api/v1/workspaces/${projectId}/web-waylines?${query}`, {
        method: 'GET', credentials: attempts[index].credentials, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {
          ...attempts[index].headers,
          'x-org-id': orgId,
          'x-language-code': 'zh',
          'X-Request-Id': crypto.randomUUID(),
        },
      });
    } catch { throw new Error('司空航线接口暂时无法连接，请稍后重试'); }
    const authFailure = response.status === 401;
    if (authFailure) {
      lastAuthMessage = `HTTP ${response.status}`;
      if (index + 1 < attempts.length) continue;
      throw new Error(`司空登录已过期，请重新登录后同步航线（${lastAuthMessage}）`);
    }
    if (!response.ok) throw new Error(`司空航线接口 HTTP ${response.status}，请检查登录和项目权限`);
    result = await response.json().catch(() => { throw new Error('司空航线响应格式无效'); });
    if ([200401, 401, 44001].includes(result.code)) {
      lastAuthMessage = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 160) : `业务码 ${result.code}`;
      if (index + 1 < attempts.length) continue;
      throw new Error(`司空登录已过期，请重新登录后同步航线（${lastAuthMessage}）`);
    }
    if (result.code !== 0) throw new Error('司空航线接口拒绝访问，请检查项目权限');
    break;
  }
  const list = result.data?.list ?? result.data?.data?.list;
  if (!Array.isArray(list)) throw new Error('司空航线响应格式已变化');
  const routes = list.map(row => {
    const routeId = row?.id ?? row?.uuid ?? row?.wayline_id;
    const name = row?.name ?? row?.file_name ?? row?.filename;
    if (!row || typeof routeId !== 'string' || !/^[a-f0-9-]{36}$/.test(routeId) || typeof name !== 'string' || !name.trim()) throw new Error('司空航线身份无效');
    const rawUpdateTime = row.update_time ?? row.updated_at ?? row.updateTime;
    const updateTime = Number.isSafeInteger(rawUpdateTime) ? rawUpdateTime : Number.isFinite(Number(rawUpdateTime)) ? Number(rawUpdateTime) : 0;
    return { routeId, name: name.trim(), updateTime };
  });
  const unique = new Map();
  for (const route of routes) {
    const previous = unique.get(route.name);
    if (!previous || route.updateTime > previous.updateTime) unique.set(route.name, route);
  }
  const sorted = [...unique.values()].sort((a, b) => b.name.replace(/\s+/g, '').length - a.name.replace(/\s+/g, '').length || b.updateTime - a.updateTime || a.name.localeCompare(b.name, 'zh-CN'));
  if (location.href !== expectedUrl) throw new Error('航线读取期间页面已切换，请重试');
  return { apiVersion: 1, url: `https://fh.dji.com${projectPath}#/plan`, routes: sorted };
}
