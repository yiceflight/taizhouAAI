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
  // The list endpoint carries the task identity and execution receipt, while
  // the rendered row carries the human-facing type and route columns. Keep
  // both sources together so the client can reproduce the same row the user
  // sees in 司空 instead of inventing a local route or task type.
  const visibleRows = async () => {
    if (typeof document === 'undefined') return new Map();
    const rows = new Map();
    let date = '';
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const readPartialReason = async row => {
      const icon = row.querySelector?.('.status-box .info-icon, .info-icon');
      if (!icon || typeof icon.click !== 'function') return undefined;
      try {
        icon.click();
        // Ant's tooltip is rendered on the next event loop turn. Keep this
        // read-only and bounded; a missing tooltip must not fail task sync.
        await new Promise(resolve => setTimeout(resolve, 50));
        const tooltipNodes = [...document.querySelectorAll('.plan-app-ant-tooltip-inner')];
        const fallbackNodes = tooltipNodes.length ? tooltipNodes : [...document.querySelectorAll('[role="tooltip"]')];
        const tips = fallbackNodes
          .filter(element => typeof element.getClientRects !== 'function' || element.getClientRects().length)
          .map(element => clean(element.textContent))
          .filter(Boolean);
        return tips.at(-1)?.slice(0, 2000) || undefined;
      } catch {
        return undefined;
      } finally {
        try { icon.click(); } catch { /* optional transient tooltip cleanup */ }
      }
    };
    const clock = value => {
      const text = clean(value).replace(/--/g, '');
      return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : '';
    };
    const timestamp = (day, value) => {
      const time = clock(value);
      if (!day || !time) return 0;
      const parsed = Date.parse(`${day}T${time}:00+08:00`);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    for (const row of document.querySelectorAll('tbody tr, tr[role="row"]')) {
      const key = row.getAttribute('data-row-key');
      if (!key) {
        const heading = clean(row.textContent);
        const match = heading.match(/^(\d{4}-\d{2}-\d{2})(?:今天|昨天)?$/);
        if (match) date = match[1];
        continue;
      }
      const cells = [...row.children].filter(cell => cell.tagName === 'TD');
      const groups = [...row.querySelectorAll('.duration-box .time-content')];
      const planned = groups[0] ? [...groups[0].querySelectorAll('.start-time,.end-time')].map(clean) : [];
      const actual = groups[1] ? [...groups[1].querySelectorAll('.start-time,.end-time')].map(clean) : [];
      const mediaCell = row.querySelector?.('.media-td') || cells.find(cell => /上传结束|上传中|无媒体文件|媒体/.test(clean(cell.textContent)));
      const mediaText = clean(mediaCell?.textContent);
      const mediaCounts = mediaText.match(/\((\d+)\s*\/\s*(\d+)\)/);
      const media = /无媒体文件/.test(mediaText)
        ? { noMedia: true, ready: true }
        : mediaCounts
          ? { uploaded: Number(mediaCounts[1]), expected: Number(mediaCounts[2]), ready: /上传结束/.test(mediaText) || (Number(mediaCounts[2]) > 0 && Number(mediaCounts[1]) >= Number(mediaCounts[2])) }
          : undefined;
      rows.set(key, {
        plannedStartTime: timestamp(date, planned[0]),
        plannedEndTime: timestamp(date, planned[1]),
        actualStartTime: timestamp(date, actual[0]),
        actualEndTime: timestamp(date, actual[1]),
        taskType: clean(cells[3]?.textContent),
        planName: clean(cells[4]?.textContent),
        routeName: clean(cells[5]?.textContent),
        media,
      });
    }
    for (const [key, row] of rows) {
      const source = [...document.querySelectorAll('tbody tr, tr[role="row"]')]
        .find(candidate => candidate.getAttribute?.('data-row-key') === key);
      if (!source || !source.textContent?.includes('部分执行')) continue;
      const reason = await readPartialReason(source);
      if (reason) row.partialReason = reason;
    }
    return rows;
  };
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
    if (data.list.length !== Math.max(0, Math.min(50, data.pagination.total - (page - 1) * 50))) throw new Error('司空任务分页记录不完整，请稍后重试');
    if (location.href !== expectedUrl) throw new Error('任务读取期间页面已切换，请重试');
    return data;
  };
  let visible = new Map();
  const normalize = row => {
    const states = { 1: '执行失败', 4: '执行终止', 5: '执行成功', 7: '执行失败', 8: '部分执行' };
    if (row.prj_uuid !== projectId || row.sn !== 'AHRXNBN00A029A' || !states[row.status]
        || typeof row.uuid !== 'string' || !/^[a-f0-9-]{36}$/.test(row.uuid) || typeof row.name !== 'string' || !row.name.trim()) throw new Error('司空任务身份或执行状态不匹配');
    // Keep minute precision compatible with previously persisted DOM receipts.
    const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Math.floor(Date.parse(value) / 60000) * 60000 : 0;
    const rendered = visible.get(row.uuid);
    const startTime = rendered?.actualStartTime || stamp(row.run_at);
    const endTime = rendered?.actualEndTime || stamp(row.completed_at);
    const plannedStartTime = stamp(row.begin_at) || rendered?.plannedStartTime || 0;
    const actualTimeMissing = !startTime || !endTime || endTime <= startTime;
    if (!plannedStartTime || endTime > Date.now() || (!actualTimeMissing && endTime - startTime >= 86400000)) throw new Error('司空任务时间无效');
    const folder = row.folder_info;
    const apiCount = folder?.expected_file_count, apiUploaded = folder?.uploaded_file_count;
    const validCount = value => Number.isSafeInteger(value) && value >= 0;
    if ((apiCount !== undefined && !validCount(apiCount)) || (apiUploaded !== undefined && !validCount(apiUploaded))) throw new Error('司空媒体计数无效');
    const mediaFolderValue = Number(row.folder_id);
    const mediaFolderId = Number.isSafeInteger(mediaFolderValue) && mediaFolderValue > 0 ? mediaFolderValue : null;
    const renderedMedia = rendered?.media;
    const renderedHasCounts = renderedMedia && validCount(renderedMedia.uploaded) && validCount(renderedMedia.expected)
      && (renderedMedia.uploaded > 0 || renderedMedia.expected > 0);
    const apiHasCounts = validCount(apiUploaded) && validCount(apiCount) && (apiUploaded > 0 || apiCount > 0);
    const uploaded = renderedHasCounts ? renderedMedia.uploaded : apiHasCounts ? apiUploaded : undefined;
    const count = renderedHasCounts ? renderedMedia.expected : apiHasCounts ? apiCount : undefined;
    const hasCounts = validCount(count) && validCount(uploaded) && (count > 0 || uploaded > 0);
    // Same terminal/no-media rule as FlightHub, but incomplete actual times
    // must never trigger an automatic flight report.
    // FlightHub can render the upload result before folder_info is present in
    // the list response. Only an explicit no-media receipt may mark a task as
    // empty; unknown counts must not become a misleading 0/0 in the client.
    const apiExplicitEmpty = !renderedMedia && !mediaFolderId && validCount(apiCount) && validCount(apiUploaded) && apiCount === 0 && apiUploaded === 0;
    const noMedia = renderedMedia?.noMedia === true
      || apiExplicitEmpty
      || (!renderedMedia && !mediaFolderId && !hasCounts && row.media_upload_status === 0);
    const uploadedAll = !noMedia && (renderedMedia?.ready === true || (hasCounts && count > 0 && uploaded >= count) || (!hasCounts && row.media_upload_status === 2));
    const routeName = String(rendered?.routeName || row.route_name || row.flight_route_name || row.template_name || '').trim();
    const taskType = String(rendered?.taskType || row.task_type || row.taskType || row.flight_task_type || '').trim();
    const missionName = String(rendered?.planName || row.name).trim();
    return { taskId: row.uuid, mediaFolderId, plannedStartTime, actualTimeMissing,
      routeName: routeName || undefined, taskType: taskType || undefined,
      ...(rendered?.partialReason ? { partialReason: rendered.partialReason } : {}),
      ...(validCount(uploaded) ? { mediaUploadedCount: uploaded } : {}),
      ...(validCount(count) ? { mediaExpectedCount: count } : {}),
      mission: { missionId: 0, missionName, startTime, endTime, geoLocation: '' },
      status: states[row.status], noMedia, mediaReady: !actualTimeMissing && (noMedia || uploadedAll) };
  };
  const first = await request(1);
  visible = await visibleRows();
  const tasks = new Map(first.list.map(row => { const task = normalize(row); return [task.taskId, task]; }));
  const lastPage = Math.max(1, Math.ceil(first.pagination.total / 50));
  // New executions can shift every later page. Restart the historical sweep
  // when its total changes rather than silently skipping shifted records.
  const savedPage = options.cursor?.apiVersion === 1 && options.cursor.total === first.pagination.total && Number.isInteger(options.cursor.page) && options.cursor.page >= 2 ? options.cursor.page : 2;
  let page = Math.min(savedPage, lastPage + 1), historyError = null;
  const includeHistory = options.includeHistory !== false;
  const startPage = page;
  let historyChanged = false;
  if (includeHistory) {
    // At most five history requests plus the fresh first page per lease.
    for (let batch = 0; page <= lastPage && batch < 5; batch++) {
      try {
        const data = await request(page);
        if (data.pagination.total !== first.pagination.total) {
          historyChanged = true; page = 2;
          throw new Error('司空任务总数在同步期间变化，将重新读取历史任务');
        }
        if (!data.list.length && page <= Math.ceil(data.pagination.total / 50)) throw new Error('司空历史分页暂未返回记录，请稍后重试');
        for (const row of data.list) { const task = normalize(row); tasks.set(task.taskId, task); }
        page++;
      } catch (error) { historyError = error.message; break; }
    }
  }
  return { apiVersion: 1, url: `https://fh.dji.com${projectPath}#/plan`, tasks: [...tasks.values()], skipped: 0, total: first.pagination.total,
    cursor: includeHistory ? page <= lastPage ? { apiVersion: 1, page, total: first.pagination.total } : null : options.cursor ?? null,
    historyScan: includeHistory && !historyChanged ? { startPage, nextPage: page, total: first.pagination.total } : null,
    historyComplete: includeHistory && !historyError && page > lastPage, historyError };
}
