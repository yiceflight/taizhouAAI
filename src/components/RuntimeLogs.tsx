import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

export type LogEntry = { id: number; at: number; session: string; level: string; category: string; event: string; message: string; details: unknown };
type LogPage = { entries: LogEntry[]; hasMore: boolean; session: string };
export type LogFilter = { level?: string; category?: string; search?: string; since?: number; until?: number; beforeId?: number };
const categories: Record<string, string> = { app: '客户端', window: '窗口', bridge: '浏览器连接与任务', readiness: '网站与运行状态', monitoring: '监测同步', weather: '机场天气', flight: '巡查任务', report: '报告生成', action: '操作记录' };
const levels: Record<string, string> = { info: '信息', warning: '警告', error: '错误' };
const browserJobLabels: Record<string, string> = {
  capture: '读取网页内容', 'site-health': '检查可飞网站连接', 'jiangsu-health': '检查江苏监测网站连接',
  'dji-health-open': '检查司空 FlightHub 连接', 'airins-health-open': '检查可飞平台连接',
  'airins-realtime': '读取可飞实时监测数据', 'jiangsu-hourly': '同步江苏小时监测数据',
  'dji-weather': '获取司空机场天气', 'dji-routes': '同步司空航线', 'dji-tasks': '同步司空任务',
  'dji-status': '查询司空任务状态', 'dji-prepare': '准备司空巡查任务',
  'dji-open-prepared': '打开已准备的司空巡查任务', 'dji-submit': '提交司空巡查任务',
  'flight-missions': '查询巡飞任务', 'flight-airins': '获取可飞任务数据',
  'flight-dji-list': '查询司空媒体目录', 'flight-dji-image': '下载司空媒体',
};
const detailLabels: Record<string, string> = {
  previous: '此前状态', current: '当前状态', visible: '窗口可见', minimized: '窗口最小化', focused: '窗口聚焦',
  connected: '连接状态', clients: '连接数量', versions: '插件版本', ready: '就绪状态', state: '状态', message: '说明',
  reason: '原因', error: '错误原因', note: '补充说明', started: '监测启动', monitoringReady: '监测就绪', flightReady: '巡查就绪',
  reportReady: '报告就绪', monitoringEnabled: '监测开关', executionMode: '起飞执行方式', syncing: '同步状态', rows: '数据条数',
  from: '起始时间', through: '结束时间', elapsedMs: '耗时', count: '数量', attemptId: '尝试编号', requestId: '请求编号',
  status: '任务状态', id: '任务编号', name: '任务名称', observedAt: '观测时间', lastAttempt: '最近尝试', lastSuccess: '最近成功',
  latestObservation: '最新观测', syncError: '同步错误', gapMs: '间隔时长', previousAt: '上次观测', currentAt: '本次观测', enabled: '开关',
  version: '版本', platform: '系统', channel: '环境', pid: '进程号', window: '窗口状态', evaluateFlightAfterSync: '同步后评估巡查',
  statusCheckError: '状态核查错误', launchAt: '起飞时间', verdict: '平台结论', airworthy: '适飞状态', force: '强制刷新',
  fetchedAt: '获取时间', url: '页面地址', tabId: '页面编号', type: '浏览器动作', jobs: '任务数量', keepAliveSupported: '后台保活',
  singleJobSupported: '单任务支持', autoSubmit: '自动提交', eventId: '事件编号', submit: '提交状态', expiresAt: '过期时间',
};
type DetailLine = { label: string; value: string };
type DetailRecord = Record<string, unknown>;

function detailLabel(key: string) {
  return detailLabels[key] ?? '补充信息';
}

function browserJobLabel(value: unknown) {
  if (typeof value !== 'string' || !value) return '浏览器任务';
  return browserJobLabels[value] ?? `浏览器任务（${value}）`;
}

function booleanText(key: string, value: boolean) {
  if (key === 'visible') return value ? '可见' : '隐藏';
  if (key === 'minimized') return value ? '已最小化' : '未最小化';
  if (key === 'focused') return value ? '已聚焦' : '未聚焦';
  if (key === 'connected') return value ? '已连接' : '未连接';
  if (key === 'ready' || key.endsWith('Ready')) return value ? '已就绪' : '未就绪';
  if (key === 'enabled') return value ? '已开启' : '已关闭';
  if (key === 'syncing') return value ? '同步中' : '未同步';
  return value ? '是' : '否';
}

function compactText(value: string) {
  return value.length > 180 ? `${value.slice(0, 177)}…` : value;
}

function displayValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '无';
  if (key === 'type') return browserJobLabel(value);
  if (typeof value === 'boolean') return booleanText(key, value);
  if (typeof value === 'number') {
    if (key.endsWith('At') || key === 'previousAt' || key === 'currentAt') return Number.isFinite(value) ? logTime(value) : String(value);
    if (key.endsWith('Ms')) return `${Math.round(value)} 毫秒`;
    return String(value);
  }
  if (typeof value === 'string') return compactText(value);
  if (Array.isArray(value)) return value.length ? compactText(value.map(item => displayValue(key, item)).join('、')) : '无';
  if (typeof value === 'object') {
    return compactText(Object.entries(value as DetailRecord).map(([nestedKey, nestedValue]) => `${detailLabel(nestedKey)}：${displayValue(nestedKey, nestedValue)}`).join('；'));
  }
  return String(value);
}

function windowStateText(value: unknown) {
  if (!value || typeof value !== 'object') return displayValue('state', value);
  const state = value as DetailRecord;
  return [
    state.visible === true ? '窗口可见' : state.visible === false ? '窗口隐藏' : undefined,
    state.focused === true ? '已聚焦' : state.focused === false ? '未聚焦' : undefined,
    state.minimized === true ? '已最小化' : state.minimized === false ? '未最小化' : undefined,
  ].filter(Boolean).join(' · ') || '状态未知';
}

export function detailLines(entry: LogEntry): DetailLine[] {
  if (!entry.details || typeof entry.details !== 'object' || Array.isArray(entry.details)) return [];
  const details = entry.details as DetailRecord;
  if (entry.event === 'window.state') {
    return ['current', 'previous'].filter(key => details[key] !== undefined).map(key => ({ label: key === 'current' ? '当前窗口' : '此前窗口', value: windowStateText(details[key]) }));
  }
  return Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .slice(0, 6)
    .map(([key, value], index) => ({ label: detailLabels[key] ?? (index === 0 ? '补充信息' : '其他信息'), value: displayValue(key, value) }));
}
export function displayMessage(entry: LogEntry) {
  if (!entry.event.startsWith('job.')) return entry.message;
  const details = entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details)
    ? entry.details as DetailRecord
    : {};
  const label = browserJobLabel(details.type);
  if (entry.event === 'job.started') return `正在请求浏览器插件执行“${label}”`;
  if (entry.event === 'job.delivered') return `已将“${label}”交给浏览器插件，等待插件回执`;
  if (entry.event === 'job.finished' && (entry.level === 'error' || typeof details.error === 'string' && details.error.length > 0)) {
    return `浏览器插件执行“${label}”失败`;
  }
  if (entry.event === 'job.finished') return `浏览器插件已返回“${label}”回执，业务结果请查看后续记录`;
  return entry.message;
}
export function logTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
}
export function timeFilter(value: string): number | undefined { return value ? new Date(`${value}:00+08:00`).getTime() : undefined; }
export function LogRows({ entries, listRef }: { entries: LogEntry[]; listRef?: RefObject<HTMLOListElement | null> }) {
  return <ol ref={listRef} className="runtime-log-list">{entries.map(entry => {
    const lines = detailLines(entry);
    return <li key={entry.id} data-log-id={entry.id} className={`runtime-log-entry log-${entry.level}`}>
      <div className="runtime-log-entry-main"><div className="runtime-log-meta"><time dateTime={new Date(entry.at).toISOString()}>{logTime(entry.at)}</time><span className={`log-level log-level-${entry.level}`}><i aria-hidden="true" />{levels[entry.level] ?? entry.level}</span><span className="log-category">{categories[entry.category] ?? entry.category}</span></div>
      <div className="runtime-log-message">{displayMessage(entry)}</div>{lines.length > 0 && <div className="runtime-log-details" aria-label="日志说明">{lines.map((line, index) => <div className="runtime-log-detail" key={`${line.label}-${index}`}><span>{line.label}</span><strong>{line.value}</strong></div>)}</div>}</div>
    </li>;
  })}</ol>;
}
type ScrollAnchor = { id: number; top: number; container: HTMLElement };

function visibleLogAnchor(list: HTMLOListElement | null): ScrollAnchor | undefined {
  if (!list) return undefined;
  const container = list.closest<HTMLElement>('.workspace-content') ?? list.parentElement;
  if (!container || typeof container.getBoundingClientRect !== 'function') return undefined;
  const containerRect = container.getBoundingClientRect();
  const nodes = Array.from(list.querySelectorAll<HTMLElement>('[data-log-id]'));
  const node = nodes.find(candidate => {
    if (typeof candidate.getBoundingClientRect !== 'function') return false;
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > containerRect.top + 8 && rect.top < containerRect.bottom;
  });
  if (!node || typeof node.getBoundingClientRect !== 'function') return undefined;
  const id = Number(node.dataset.logId);
  const top = node.getBoundingClientRect().top;
  return Number.isFinite(id) && Number.isFinite(top) ? { id, top, container } : undefined;
}

export function RuntimeLogs({ active }: { active: boolean }) {
  const [level, setLevel] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState<number>();
  const [history, setHistory] = useState<(number | undefined)[]>([]);
  const [page, setPage] = useState<LogPage | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [revision, setRevision] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const listRef = useRef<HTMLOListElement>(null);
  const pendingAnchor = useRef<ScrollAnchor | undefined>(undefined);
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const since = timeFilter(from), until = timeFilter(to);
  const invalidRange = (since !== undefined && !Number.isFinite(since)) || (until !== undefined && !Number.isFinite(until)) || (since !== undefined && until !== undefined && since > until);
  const filter: LogFilter = { level: level || undefined, category: category || undefined, search: query || undefined, since, until: until === undefined ? undefined : until + 59_999 };
  // Reset pagination atomically with a user filter change; the debounced query does not retain an old cursor.
  const reset = () => { pendingAnchor.current = undefined; setCursor(undefined); setHistory([]); setPage(null); };
  useEffect(() => {
    if (!active || invalidRange) return;
    let alive = true, pending = false;
    const read = async () => {
      if (pending) return;
      if (!isTauri()) { setError('请在桌面客户端中查看本机运行日志。'); return; }
      pending = true; setLoading(true);
      try {
        const next = await invoke<LogPage>('get_runtime_logs', { filter: { level: level || undefined, category: category || undefined, search: query || undefined, since, until: until === undefined ? undefined : until + 59_999, beforeId: cursor } });
        if (alive) {
          pendingAnchor.current = visibleLogAnchor(listRef.current);
          setPage(next); setError(''); setUpdatedAt(Date.now());
        }
      } catch (e) { if (alive) setError(`日志读取失败：${String(e)}`); }
      finally { pending = false; if (alive) setLoading(false); }
    };
    void read();
    const timer = cursor === undefined ? setInterval(() => void read(), 5000) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [active, level, category, query, since, until, cursor, revision, invalidRange]);
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = undefined;
    if (!anchor || !anchor.container.isConnected) return;
    const node = anchor.container.querySelector<HTMLElement>(`[data-log-id="${anchor.id}"]`);
    if (!node || typeof node.getBoundingClientRect !== 'function') return;
    const nextTop = node.getBoundingClientRect().top;
    if (!Number.isFinite(nextTop)) return;
    const delta = nextTop - anchor.top;
    if (Math.abs(delta) > 0.5) anchor.container.scrollTop += delta;
  }, [page]);
  const exportLogs = async () => {
    setExporting(true); setMessage('');
    try { const path = await invoke<string>('export_runtime_logs', { filter }); setMessage(`已导出符合筛选条件的全部留存日志：${path}`); }
    catch (e) { setMessage(`导出失败：${String(e)}`); }
    finally { setExporting(false); }
  };
  const hasFilters = !!(level || category || search || from || to);
  const clearFilters = () => { reset(); setLevel(''); setCategory(''); setSearch(''); setFrom(''); setTo(''); };
  return <div className="runtime-logs">
    <div className="page-heading runtime-log-heading"><div><span className="eyebrow">本机记录 · 北京时间</span><h2>运行日志</h2><p>按时间查看后台运行、连接变化与任务结果，记录内容会直接翻译成中文说明。</p></div><div className="button-row"><button className="secondary-button" disabled={loading || invalidRange} onClick={() => setRevision(v => v + 1)}>刷新</button><button className="primary-button" disabled={exporting || invalidRange || !page || !!error || query !== search.trim()} onClick={() => void exportLogs()}>{exporting ? '正在导出…' : '导出筛选结果'}</button></div></div>
    <div className="runtime-log-explainer"><div className="runtime-log-explainer-heading"><span className="runtime-log-info-icon" aria-hidden="true">i</span><div><strong>后台记录持续运行</strong><span>最小化窗口后，应用仍会记录状态变化。</span></div></div><p>每分钟记录后台存活，连接与窗口状态变化单独记录。新增记录会保留你当前查看的位置；手动筛选或翻页会更新查看位置。存活不代表业务执行成功，请结合任务结果判断；记录空档只说明缺少证据。</p><div className="runtime-log-retention"><span>保留 <b>30 天</b></span><span>最多 <b>20,000 条</b></span><span>重启后可查询</span><span>安装功能后开始记录</span></div></div>
    <div className="runtime-log-filter-card"><div className="runtime-log-filter-heading"><div><strong>筛选记录</strong><span>按级别、类别、时间或关键词缩小范围</span></div>{hasFilters && <button className="text-button" type="button" onClick={clearFilters}>清除筛选</button>}</div><form className="runtime-log-filters" onSubmit={e => e.preventDefault()}>
      <label>级别<select value={level} onChange={e => { reset(); setLevel(e.target.value); }}><option value="">全部级别</option>{Object.entries(levels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>类别<select value={category} onChange={e => { reset(); setCategory(e.target.value); }}><option value="">全部类别</option>{Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>开始时间<input type="datetime-local" value={from} onChange={e => { reset(); setFrom(e.target.value); }}/></label>
      <label>结束时间<input type="datetime-local" value={to} onChange={e => { reset(); setTo(e.target.value); }}/></label>
      <label className="log-search">搜索<input type="search" placeholder="关键词、任务 ID 或请求 ID" value={search} onChange={e => { reset(); setSearch(e.target.value); }}/></label>
    </form></div>
    {invalidRange && <p className="notice warning" role="alert">请检查时间范围，开始时间不能晚于结束时间。</p>}
    {error && <p className="notice warning" role="alert">{error} {page && '下方为上次读取的记录。'}</p>}
    {message && <p className="notice log-export-message" role="status">{message}<button className="text-button" onClick={() => void invoke('open_runtime_log_exports').catch(e => setMessage(`无法打开导出目录：${String(e)}`))}>打开导出文件夹 ↗</button></p>}
    <div className="runtime-log-status"><span className="runtime-log-live"><i aria-hidden="true" />{cursor === undefined ? '最新记录 · 每 5 秒刷新' : '历史记录 · 已暂停自动刷新'}{updatedAt ? ` · 最近读取 ${logTime(updatedAt)}` : ''}</span><span className="runtime-log-count">{loading ? '正在读取…' : `本页 ${page?.entries.length ?? 0} 条`}</span></div>
    {page && page.entries.length > 0 ? <LogRows entries={page.entries} listRef={listRef}/> : <div className="empty-state"><h3>{loading ? '正在读取运行日志' : '暂无符合条件的日志'}</h3><p>可调整时间、级别或关键词后重试。</p></div>}
    <div className="runtime-log-pagination"><button className="secondary-button" disabled={!history.length || loading} onClick={() => { setCursor(history[history.length - 1]); setHistory(h => h.slice(0, -1)); setPage(null); }}>上一页</button><button className="text-button" disabled={cursor === undefined} onClick={reset}>返回最新</button><button className="secondary-button" disabled={!page?.hasMore || loading} onClick={() => { setHistory(h => [...h, cursor]); setCursor(page?.entries[page.entries.length - 1]?.id); setPage(null); }}>更早记录</button></div>
  </div>;
}
