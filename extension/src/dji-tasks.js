// Fixed, read-only FlightHub list API, executed in an existing project page.
// Credentials stay in that page and are sent only to the fixed DJI API origin.
export async function readDjiTasks(expectedUrl, options = {}) {
  const projectId = 'c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
  const projectPath = `/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/${projectId}`;
  const origin = 'https://es-flight-api-cn.djigate.com';
  if (location.href !== expectedUrl || location.origin !== 'https://fh.dji.com' || location.pathname.replace(/\/$/, '') !== projectPath) throw new Error('司空任务项目不匹配');
  if (globalThis.CURRENT_BE_ENV_CONFIG?.server_url && globalThis.CURRENT_BE_ENV_CONFIG.server_url !== origin) throw new Error('请使用司空中国区服务');
  const token = localStorage.getItem('x-user-token');
  const auth = token ? null : localStorage.getItem('x-auth-token');
  if (!token && !auth) throw new Error('请在 Chrome 登录司空后同步任务');
  const request = async page => {
    const query = new URLSearchParams({ source: '0', media_upload_type: '0', 'sn[]': 'AHRXNBN00A029A', page: String(page), page_size: '50', flight_task_status: '2', list_type: '0' });
    let response;
    try {
      response = await fetch(`${origin}/task/api/v2/workspaces/${projectId}/flight-tasks?${query}`, {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: token ? { 'X-User-Token': token } : { 'X-Auth-Token': auth },
      });
    } catch { throw new Error('司空任务接口暂时无法连接，请稍后重试'); }
    if (!response.ok) throw new Error(`司空任务接口 HTTP ${response.status}，请检查登录和项目权限`);
    const result = await response.json().catch(() => { throw new Error('司空任务响应格式无效'); });
    if ([200401, 401, 44001].includes(result.code)) throw new Error('司空登录已过期，请重新登录后同步任务');
    if (result.code !== 0) throw new Error('司空任务接口拒绝访问，请检查项目权限');
    const data = result.data;
    if (!Array.isArray(data?.list) || data.list.length > 50 || data.pagination?.page !== page || data.pagination?.page_size !== 50
        || !Number.isSafeInteger(data.pagination?.total) || data.pagination.total < 0) throw new Error('司空任务分页响应格式已变化');
    if (location.href !== expectedUrl) throw new Error('任务读取期间页面已切换，请重试');
    return data;
  };
  const normalize = row => {
    const states = { 1: '执行失败', 4: '执行终止', 5: '执行成功', 7: '执行失败', 8: '部分执行' };
    if (row.prj_uuid !== projectId || row.sn !== 'AHRXNBN00A029A' || !states[row.status]
        || typeof row.uuid !== 'string' || !/^[a-f0-9-]{36}$/.test(row.uuid) || typeof row.name !== 'string' || !row.name.trim()) throw new Error('司空任务身份或执行状态不匹配');
    // Keep minute precision compatible with previously persisted DOM receipts.
    const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Math.floor(Date.parse(value) / 60000) * 60000 : 0;
    const startTime = stamp(row.run_at), endTime = stamp(row.completed_at), plannedStartTime = stamp(row.begin_at);
    const actualTimeMissing = !startTime || !endTime || endTime <= startTime;
    if (!plannedStartTime || endTime > Date.now() || (!actualTimeMissing && endTime - startTime >= 86400000)) throw new Error('司空任务时间无效');
    const folder = row.folder_info;
    const count = folder?.expected_file_count ?? 0, uploaded = folder?.uploaded_file_count ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(uploaded) || uploaded < 0) throw new Error('司空媒体计数无效');
    const mediaFolderId = Number.isSafeInteger(row.folder_id) && row.folder_id > 0 ? row.folder_id : null;
    // Same terminal/no-media rule as FlightHub, but incomplete actual times
    // must never trigger an automatic flight report.
    const noMedia = !mediaFolderId || count === 0;
    const uploadedAll = !noMedia && (uploaded >= count || row.media_upload_status === 2);
    return { taskId: row.uuid, mediaFolderId, plannedStartTime, actualTimeMissing,
      mission: { missionId: 0, missionName: row.name.trim(), startTime, endTime, geoLocation: '' },
      status: states[row.status], noMedia, mediaReady: !actualTimeMissing && (noMedia || uploadedAll) };
  };
  const first = await request(1);
  const tasks = new Map(first.list.map(row => { const task = normalize(row); return [task.taskId, task]; }));
  const lastPage = Math.max(1, Math.ceil(first.pagination.total / 50));
  // New executions can shift every later page. Restart the historical sweep
  // when its total changes rather than silently skipping shifted records.
  const savedPage = options.cursor?.apiVersion === 1 && options.cursor.total === first.pagination.total && Number.isInteger(options.cursor.page) && options.cursor.page >= 2 ? options.cursor.page : 2;
  let page = Math.min(savedPage, lastPage + 1), historyError = null;
  const includeHistory = options.includeHistory !== false;
  if (includeHistory) {
    // At most five history requests plus the fresh first page per lease.
    for (let batch = 0; page <= lastPage && batch < 5; batch++) {
      try {
        const data = await request(page);
        if (!data.list.length && page <= Math.ceil(data.pagination.total / 50)) throw new Error('司空历史分页暂未返回记录，请稍后重试');
        for (const row of data.list) { const task = normalize(row); tasks.set(task.taskId, task); }
        page++;
      } catch (error) { historyError = error.message; break; }
    }
  }
  return { apiVersion: 1, url: `https://fh.dji.com${projectPath}#/plan`, tasks: [...tasks.values()], skipped: 0, total: first.pagination.total,
    cursor: includeHistory ? page <= lastPage ? { apiVersion: 1, page, total: first.pagination.total } : null : options.cursor ?? null,
    historyComplete: includeHistory && !historyError && page > lastPage, historyError };
}
