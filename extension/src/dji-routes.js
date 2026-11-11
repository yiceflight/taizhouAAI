// Read-only FlightHub route library API, executed in an existing project page.
// Credentials stay in that page and are sent only to the fixed DJI API origin.
export async function readDjiRoutes(expectedUrl) {
  const projectId = 'c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
  const orgId = 'b9fb201d-b230-433d-a1d5-e47736ca06f0';
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
  const deadline = Date.now() + 22000;
  const request = async params => {
    if (Date.now() >= deadline) throw new Error('航线目录同步超时，请重试');
    const query = new URLSearchParams(params);
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
    const data = result.data?.data ?? result.data;
    // FlightHub serializes an empty directory as list:null, total:0.
    // Require the explicit zero total; missing/nonempty lists remain errors.
    if (data?.list === null && data.pagination?.total === 0) return { ...data, list: [] };
    if (!Array.isArray(data?.list)) throw new Error('司空航线响应格式已变化');
    return data;
  };
  // FlightHub's folder tree uses the same endpoint with file_type=1.
  const folderData = await request({ file_type: '1' });
  const folders = new Map(folderData.list.map(row => [row.id, row]));
  if (folders.size !== folderData.list.length || (folderData.pagination?.total > folders.size)) throw new Error('航线文件夹列表不完整');
  const pathFor = id => {
    const path = [], seen = new Set();
    while (id) {
      const folder = folders.get(id);
      if (!folder || seen.has(id)) throw new Error('航线文件夹层级无效');
      seen.add(id);
      const name = folder.sub_file_type === 4 ? '默认文件夹' : folder.name;
      if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim()) throw new Error('航线文件夹身份无效');
      path.unshift({ id, name: name.trim() });
      id = folder.parent_id;
    }
    return path;
  };
  const routes = [];
  const seenRoutes = new Set();
  for (const folderId of folders.keys()) {
    const folderPath = pathFor(folderId);
    let count = 0;
    for (let page = 1; ; page += 1) {
      const data = await request({ parent_id: folderId, size: '20', key: '', order_by: 'update_time desc', file_type: '5', page: String(page) });
      for (const row of data.list) {
        const routeId = row?.id ?? row?.uuid ?? row?.wayline_id;
        const name = row?.name ?? row?.file_name ?? row?.filename;
        if (typeof routeId !== 'string' || !/^[a-f0-9-]{36}$/.test(routeId) || typeof name !== 'string' || !name.trim()) throw new Error('司空航线身份无效');
        if (seenRoutes.has(routeId) || (row.parent_id && row.parent_id !== folderId)) throw new Error('航线分页或文件夹归属发生变化，请重新同步');
        seenRoutes.add(routeId);
        const rawUpdateTime = row.update_time ?? row.updated_at ?? row.updateTime;
        const updateTime = Number.isFinite(Number(rawUpdateTime)) ? Number(rawUpdateTime) : 0;
        routes.push({ routeId, name: name.trim(), updateTime, folderPath });
      }
      count += data.list.length;
      const total = data.pagination?.total;
      if (total !== undefined ? count >= total : data.list.length < 20) break;
      if (!data.list.length || page >= 500) throw new Error('航线分页不完整');
    }
  }
  const sorted = routes.sort((a, b) => b.name.replace(/\s+/g, '').length - a.name.replace(/\s+/g, '').length || b.updateTime - a.updateTime || a.name.localeCompare(b.name, 'zh-CN'));
  if (location.href !== expectedUrl) throw new Error('航线读取期间页面已切换，请重试');
  return { apiVersion: 2, url: `https://fh.dji.com${projectPath}#/plan`, routes: sorted };
}
