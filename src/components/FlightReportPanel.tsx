import { useEffect, useRef, useState } from 'react';
import { associateAirinsMission, readAirinsHistory, type MissionPage } from '../lib/airinsHistory';
import { ReportEmailDialog } from './ReportEmailDialog';
import { usePatrolUnread } from '../lib/usePatrolUnread';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { tabKey, type BrowserTab } from '../lib/workspace';
import { DJI_MEDIA_URL, DJI_PLAN_URL, airinsMissionUrl, beijingTime, djiMediaFolderUrl, flightCharts, isTodayPatrolTask, localFlightDisplay, localFlightTimeDisplay, localFlightMission, flightMinuteTime, localFlightOriginLabel, missionOriginLabel, patrolTasks, visibleReportTasks, type DjiTask, type Mission, type PatrolTask, type CollectedFlight, type FlightSummary, type LocalFlightEvent } from '../lib/flightReport';
import { currentWeatherText, rainfallText, type WeatherCheck } from '../lib/weather';
import type { EmailSettings } from '../lib/email';
import { recordFrontendError, reportFailureDetail } from '../lib/diagnostics';

const flightInputTime = (value?: number) => value ? new Date(value + 8 * 3600000).toISOString().slice(0, 19) : '';
type ActualWindow = { start: number | null; end: number | null };
const validWindow = (start?: number, end?: number): ActualWindow | null => start && end && Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
function actualWindow(task: PatrolTask): ActualWindow | null {
  if (task.djiTask) {
    const start = Number.isFinite(task.djiTask.mission.startTime) && task.djiTask.mission.startTime > 0 ? task.djiTask.mission.startTime : null;
    const end = Number.isFinite(task.djiTask.mission.endTime) && task.djiTask.mission.endTime > 0 ? task.djiTask.mission.endTime : null;
    if (start || end) return { start, end };
  }
  if (task.localEvent?.flightTime) return validWindow(task.localEvent.flightTime.startTime, task.localEvent.flightTime.endTime);
  // Airins historical records are already completed executions.
  if (task.mission?.missionId) return validWindow(task.mission.startTime, task.mission.endTime);
  return null;
}
const taskDate = (value: number | null) => value == null ? '实际时间待确认' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)).replace(/\//g, '-');
const taskClock = (value: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const measured = (value: number | null, unit: string) => value == null ? '缺测' : `${value.toFixed(1)} ${unit}`;
function taskTypeLabel(value?: string): string {
  const label = String(value ?? '').trim();
  // Confirmed against the same executions in FlightHub's task list.
  // Format cached API codes here as well as newly synchronized receipts.
  if (label === '4') return '自动任务';
  if (label && Number.isFinite(Number(label))) return '类型待确认';
  return label || '司空任务';
}
function RecordedWeather({ checks }: { checks: WeatherCheck[] }) {
  const creation = checks.find(check => check.stage === 'creation');
  if (!creation) return <span>当时天气未记录</span>;
  const { weather, checkedAt } = creation;
  const sample = weather.current;
  return <><strong>{sample ? `${currentWeatherText(sample)} · ${sample.airworthy != null ? '机场实测 ' : ''}${measured(sample.temperature, '°C')}` : '当时天气获取不可用'}</strong>{sample && <small>{sample.airworthy != null ? `机场风 ${measured(sample.windSpeed, 'm/s')} · 机场降雨 ${rainfallText(sample)} · 司空预报 ${sample.forecast?.condition ?? '缺测'}` : `风 ${measured(sample.windSpeed, 'm/s')} / 阵风 ${measured(sample.windGusts, 'm/s')} · 降水 ${measured(sample.precipitation, 'mm')}`}</small>}<small>{weather.label} · {weather.reasons.join(' ')}</small><small>任务创建时刻：{beijingTime(checkedAt)}</small><small>天气数据时刻：{sample ? beijingTime(sample.observedAt * 1000) : '未获取'}</small></>;
}
function executionStatus(task: PatrolTask): { label: string; tone: 'success' | 'warning' | 'danger' | 'active' } {
  if (task.djiTask) {
    if (task.djiTask.status === '执行成功') return { label: '执行成功', tone: 'success' };
    if (task.djiTask.status === '部分执行') return { label: '部分执行', tone: 'warning' };
    return { label: task.djiTask.status || '执行失败', tone: 'danger' };
  }
  if (task.localEvent) {
    const state = localFlightDisplay(task.localEvent).label;
    if (task.localEvent.status === 'completed') return { label: '执行成功', tone: 'success' };
    if (['flying', 'submitting', 'submitted'].includes(task.localEvent.status)) return { label: state, tone: 'active' };
    if (['failed', 'flight_error', 'restricted', 'canceled', 'not_flown'].includes(task.localEvent.status)) return { label: state, tone: 'danger' };
    return { label: state, tone: 'warning' };
  }
  return task.report || task.mission ? { label: '执行成功', tone: 'success' } : { label: '执行状态待核查', tone: 'warning' };
}
function taskRemarks(task: PatrolTask, appTask: boolean, status: { label: string }): string[] {
  const { localEvent, djiTask, report } = task;
  if (!appTask) return [djiTask && djiTask.status !== '执行成功' ? `执行结果：${djiTask.status}` : report?.warning || '—'];
  const reason = localEvent?.source === 'auto' ? 'K⁺/PM2.5 超标自动巡查' : localEvent?.source === 'preview' ? '填写演练' : '手动发起';
  const result = localEvent?.status === 'completed' || djiTask?.status === '执行成功' ? '成功' : localEvent?.error || localEvent?.statusCheckError || status.label;
  return [`起飞原因：${reason}`, `起飞结果：${result}`];
}

function reportGenerationFailure(task: PatrolTask, error: unknown): string {
  const detail = String(error).replace(/^Error:\s*/, '');
  if (/airinsHistoryRouteMatches\s+is not defined/.test(detail)) return localizedAutoStatus(detail);
  if (/^ReferenceError:/.test(detail) || /^TypeError:/.test(detail)) return localizedAutoStatus(detail);
  if (detail.startsWith('司空媒体无照片：')) return `媒体上传已结束，无照片；${detail.replace('司空媒体无照片：', '')}。请重新加载新版浏览器插件后重试，支持生成异常数量为 0 的报告。`;
  if (task.djiTask?.mediaReady && /司空媒体解析失败|照片尚未上传|尚无 Immediate-Media/.test(detail)) return `媒体上传已结束，照片解析未完成：${/照片尚未上传|尚无 Immediate-Media/.test(detail) ? '未识别到照片目录或照片列表' : detail.replace(/^司空媒体解析失败[：:]?/, '')}。请核查媒体库后手动重试。`;
  if (task.djiTask?.status === '部分执行' && task.djiTask.mediaReady && /列表切换未完成|媒体库加载后重试/.test(detail)) {
    return '自动生成暂未完成，下轮重试：媒体已上传，司空媒体库页面切换未完成；请保持媒体库页面打开后重试';
  }
  return `自动生成暂未完成，下轮重试：${detail}`;
}

function localizedAutoStatus(value: string): string {
  if (/airinsHistoryRouteMatches\s+is not defined/.test(value)) {
    return '自动生成暂未完成，下轮重试：浏览器插件脚本未完整加载，请在 Chrome 扩展管理页重新加载 v0.7.66 或以上插件';
  }
  if (/ReferenceError:/.test(value) || /TypeError:/.test(value)) {
    return '自动生成暂未完成，下轮重试：浏览器插件脚本执行失败，请重新加载 v0.7.66 或以上插件';
  }
  return value;
}

async function sendSavedReportEmail(reportId: string): Promise<string> {
  const settings = await invoke<EmailSettings>('get_email_settings');
  if (!settings.recipients.length) throw new Error('报告已生成，但尚未配置报告接收邮箱');
  if (!settings.configured) throw new Error('报告已生成，但尚未配置 SMTP 密码');
  return invoke<string>('send_flight_report_email', {
    reportId,
    recipients: settings.recipients,
    expectedRecipients: settings.recipients,
    expectedUsername: settings.username,
  });
}

type Props = { onSettings?: () => void; onUnreadChange?: (unread: boolean) => void; onReportIssue?: () => void; tabs: BrowserTab[]; ready: boolean; mediaReady?: boolean; active?: boolean; onPrepare: () => void; openMedia: () => void; openAir: () => void; openLink?: (url: string) => void; flightEvent?: LocalFlightEvent | null; flightRecords?: LocalFlightEvent[]; tasksClearedAt?: number | null; dataResetKey?: number; };
export function FlightReportPanel({ onSettings, onUnreadChange, onReportIssue, tabs, ready, mediaReady = ready, active = true, onPrepare, openMedia, openAir, openLink, flightEvent, flightRecords, tasksClearedAt, dataResetKey = 0 }: Props) {
  const dataResetRef = useRef(dataResetKey);
  const [emailReport, setEmailReport] = useState<FlightSummary | null>(null);
  const [selected, setSelected] = useState<Mission | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [selectedDjiTask, setSelectedDjiTask] = useState<DjiTask | null>(null);
  const [withoutAirData, setWithoutAirData] = useState(false);
  const [regenerating, setRegenerating] = useState<FlightSummary | null>(null);
  const [localEventId, setLocalEventId] = useState<string | null>(null);
  const [flightName, setFlightName] = useState(''), [flightStart, setFlightStart] = useState(''), [flightEnd, setFlightEnd] = useState('');
  const [editingFlight, setEditingFlight] = useState(false);
  const [taskPage, setTaskPage] = useState(1);
  const [pageInput, setPageInput] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [missionLoading, setMissionLoading] = useState(false);
  const missionLoadLock = useRef(false);
  const airHistory = useRef<{ key: string; start: number; at: number; data: MissionPage } | null>(null);
  useEffect(() => { setTaskPage(1); setPageInput(''); setIncludeHistory(false); }, [tasksClearedAt]);
  const [djiTasks, setDjiTasks] = useState<DjiTask[]>([]);
  const [autoStatus, setAutoStatus] = useState<Record<string, string>>({});
  const historyPending = useRef(false);
  const attempts = useRef(new Map<string, number>());
  const mediaBlocked = useRef(new Map<string, string>());
  const mediaFingerprint = (task: PatrolTask) => JSON.stringify([task.djiTask?.taskId,task.djiTask?.mediaFolderId,task.djiTask?.mediaReady,task.djiTask?.mediaUploadedCount,task.djiTask?.mediaExpectedCount]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [total, setTotal] = useState(0), [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncLock = useRef(false), automaticLock = useRef(false);
  const [syncMessage, setSyncMessage] = useState(''), [syncError, setSyncError] = useState('');
  const [autoGenerating, setAutoGenerating] = useState('');
  const automaticJob = useRef<Promise<void> | null>(null);
  const [waiting, setWaiting] = useState(false);
  const manualWaiting = useRef(false), builderRequest = useRef(0);
  const manualRequest = useRef<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [reports, setReports] = useState<FlightSummary[]>([]);
  const reportRevision = useRef(0);
  const [preview, setPreview] = useState<CollectedFlight | null>(null);
  const lock = useRef(false);
  const builder = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!selected) return;
    const opener = document.activeElement as HTMLElement | null;
    builder.current?.showModal();
    return () => { opener?.focus(); };
  }, [selected]);
  const closeBuilder = () => {
    if (lock.current && !manualWaiting.current) return;
    builderRequest.current++; selectedRef.current = null;
    lock.current = false; manualRequest.current = null; manualWaiting.current = false; setBusy(false); setWaiting(false);
    setSelected(null); setPreview(null); setMessage(''); setError('');
  };
  const air = tabs.filter(t => { try { const u = new URL(t.url); return u.origin === 'https://aai.airins.cn' && u.pathname.startsWith('/sniff') && t.status === 'complete'; } catch { return false; } });
  const dji = tabs.filter(t => { try { const u = new URL(t.url); return u.origin === 'https://fh.dji.com' && u.pathname === new URL(DJI_MEDIA_URL).pathname && t.status === 'complete'; } catch { return false; } });
  // All 可飞 tabs share the same Chrome login and platform data. Pick the
  // first ready tab automatically instead of asking the user to choose a
  // browser tab id that has no business meaning.
  const selectedAir = air[0];
  // The extension creates a report-owned media tab. Any ready page in this
  // exact DJI project supplies the session; a media page need not be open.
  const selectedDji = dji.find(t => t.session === selectedAir?.session) || dji[0];
  const sourceKey = selectedAir ? tabKey(selectedAir) : '';
  const missionSource = useRef(sourceKey);
  missionSource.current = sourceKey;
  useEffect(() => { setMissions([]); if (!preview && !withoutAirData) setSelected(null); setTotal(0); setLoaded(false); }, [sourceKey]);
  useEffect(() => { const revision = dataResetRef.current; if (isTauri()) void invoke<FlightSummary[]>('list_flight_reports').then(items => { if (revision === dataResetRef.current) setReports(items); }).catch(e => { if (revision === dataResetRef.current) setError(String(e)); }); }, []);
  useEffect(() => { const revision = dataResetRef.current; if (isTauri()) void invoke<DjiTask[]>('list_dji_report_tasks').then(items => { if (revision === dataResetRef.current) setDjiTasks(items ?? []); }).catch(e => { if (revision === dataResetRef.current) setError(String(e)); }); }, []);
  const run = async (job: (current: () => boolean) => Promise<void>) => {
    if (lock.current) return;
    const request = builderRequest.current;
    const current = () => request === builderRequest.current;
    manualRequest.current = request;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    manualWaiting.current = !!automaticJob.current; setWaiting(manualWaiting.current);
    try {
      // Finish only the active automatic report, then give the manual dialog
      // priority. List synchronization never owns this report lock.
      await automaticJob.current;
      if (!current()) return;
      manualWaiting.current = false; setWaiting(false);
      await job(current);
    } catch (e) {
      if (current()) { setError(String(e)); setMessage(''); }
    } finally {
      if (manualRequest.current === request) { manualRequest.current = null; lock.current = false; manualWaiting.current = false; setBusy(false); setWaiting(false); }
    }
  };
  const load = (more = false) => {
    if (!selectedAir || !ready || missionLoadLock.current) return;
    const key = tabKey(selectedAir);
    const revision = dataResetRef.current;
    missionLoadLock.current = true; setMissionLoading(true); setError('');
    // Airins pagination is read-only and independent of the DJI media/report
    // queue. A long automatic report must not disable browsing older tasks.
    void (async () => {
      try {
        const last = missions[missions.length - 1];
        const result = await invoke<{ missions: Mission[]; total: number }>('list_flight_missions', { session: selectedAir.session, tabId: selectedAir.id, cursorId: more ? last?.missionId : null, cursorTime: more ? last?.startTime : null });
        if (missionSource.current !== key || revision !== dataResetRef.current) return;
        setMissions(items => more ? [...items, ...result.missions.filter(m => !items.some(i => i.missionId === m.missionId))] : [...result.missions, ...items.filter(m => !result.missions.some(i => i.missionId === m.missionId))]);
        setTotal(more && !result.missions.length ? missions.length : result.total);
        if (more) setIncludeHistory(true);
        setLoaded(true);
      } catch (e) { if (revision === dataResetRef.current) setError(String(e)); }
      finally { if (revision === dataResetRef.current) { missionLoadLock.current = false; setMissionLoading(false); } }
    })();
  };
  const autoLoaded = useRef('');
  const completedEvents = [...new Set([...(flightRecords ?? []), ...(flightEvent ? [flightEvent] : [])].filter(event => event.status === 'completed').map(event => event.id))].sort().join(',');
  useEffect(() => {
    if (!active || !ready || !sourceKey) autoLoaded.current = '';
    const refreshKey = `${sourceKey}:${completedEvents}`;
    if (active && ready && sourceKey && !missionLoading && autoLoaded.current !== refreshKey) {
      autoLoaded.current = refreshKey;
      load();
    }
  }, [active, ready, sourceKey, missionLoading, completedEvents]);
  const syncTasks = async () => {
    const platform = selectedDji;
    if (!isTauri() || !mediaReady || !platform || syncLock.current) return null;
    const revision = dataResetRef.current;
    const samplingSource = sourceKey;
    syncLock.current = true; setSyncing(true); setSyncError('');
    try {
      const result = await invoke<{ tasks: DjiTask[]; skipped: number; mediaTabId?: number | null; historyPending?: boolean; historyError?: string | null }>('sync_dji_report_tasks', { session: platform.session });
      if (revision !== dataResetRef.current) return null;
      setDjiTasks(result.tasks); setLoaded(true); historyPending.current = !!result.historyPending;
      setSyncMessage([
        result.skipped ? `${result.skipped} 条司空记录缺少实际飞行时间，暂不能自动生成报告。` : '',
        result.historyError ? `最新任务已同步，历史补读稍后重试：${result.historyError}` : result.historyPending ? '最新任务已同步，正在分批补读历史任务。' : '',
      ].filter(Boolean).join(' '));
      // Finish the bounded history sweep before photo collection, which may
      // take minutes per report and otherwise delays every subsequent page.
      if (result.historyPending && !result.historyError) return null;
      let sampling = missions;
      if (ready && selectedAir) {
        try {
          const current = () => revision === dataResetRef.current && missionSource.current === samplingSource;
          const fetchPage = (cursor: Mission | null) => invoke<MissionPage>('list_flight_missions', { session: selectedAir.session, tabId: selectedAir.id, cursorId: cursor?.missionId ?? null, cursorTime: cursor?.startTime ?? null });
          const latest = await fetchPage(null);
          if (!current()) return null;
          const starts = result.tasks.filter(t => !t.actualTimeMissing && t.mission.startTime > 0).map(t => t.mission.startTime);
          const start = starts.length ? Math.min(...starts) : Date.now();
          const cached = airHistory.current;
          const history = cached && cached.key === samplingSource && cached.start <= start && Date.now() - cached.at < 300000
            ? cached.data : await readAirinsHistory(start, fetchPage, current, latest);
          if (!current()) return null;
          if (history !== cached?.data) airHistory.current = { key: samplingSource, start, at: Date.now(), data: history };
          sampling = [...new Map([...missions, ...history.missions, ...latest.missions].map(m => [m.missionId, m])).values()].sort((a, b) => b.startTime - a.startTime);
          setMissions(items => [...new Map([...items, ...sampling].map(m => [m.missionId, m])).values()].sort((a, b) => b.startTime - a.startTime)); setTotal(latest.total);
        } catch (e) { setSyncError(`可飞任务同步失败：${e}`); return null; }
      }
      const savedRevision = reportRevision.current;
      const currentReports = await invoke<FlightSummary[]>('list_flight_reports');
      if (revision !== dataResetRef.current || savedRevision !== reportRevision.current) return null;
      setReports(currentReports);
      return { platform, sampling, currentReports, tasks: result.tasks };
    } catch (e) {
      if (revision === dataResetRef.current) setSyncError(String(e));
      return null;
    } finally { syncLock.current = false; setSyncing(false); }
  };
  const syncAndGenerate = async () => {
    if (automaticLock.current || lock.current || selectedRef.current) return;
    automaticLock.current = true;
    const revision = dataResetRef.current;
    try {
      const result = await syncTasks();
      if (!result || revision !== dataResetRef.current) return;
      const { platform, sampling, currentReports } = result;
      const pending = visibleReportTasks(patrolTasks(sampling, currentReports, flightEvent, flightRecords, tasksClearedAt ?? 0, result.tasks), result.tasks)
        .filter(task => isTodayPatrolTask(task) && (!task.report || (task.report.withoutAirData && ready && selectedAir && task.mission?.missionId)) && task.mission && task.mission.endTime <= Date.now() - 60000
          && mediaBlocked.current.get(task.key) !== mediaFingerprint(task)
          && task.djiTask?.mediaReady && !task.djiTask.actualTimeMissing)
        .sort((a, b) => (attempts.current.get(a.key) ?? 0) - (attempts.current.get(b.key) ?? 0)).slice(0, 3);
      // Keep report jobs serial, and recheck manual intent after every await.
      for (const task of pending) {
        if (selectedRef.current || lock.current || revision !== dataResetRef.current) break;
        attempts.current.set(task.key, Date.now());
        setAutoStatus(state => ({ ...state, [task.key]: task.report ? '正在自动补齐可飞数据…' : '正在自动采集并生成报告…' }));
        setAutoGenerating(task.mission!.missionName);
        const job = (async () => {
          try {
            const actual = task.djiTask?.mission ?? (task.localEvent ? localFlightMission(task.localEvent) : null);
            const mission = actual ? { ...task.mission!, startTime: actual.startTime, endTime: actual.endTime } : task.mission!;
            if (mission.missionId && (!ready || !selectedAir)) throw new Error('等待可飞连接恢复后收录已关联采样');
            const skipAir = !mission.missionId;
            const data = await invoke<CollectedFlight>('collect_flight_report', { request: {
              djiSession: platform.session, djiTabId: platform.id,
              mediaKey: task.djiTask?.taskId ?? task.key,
              localEventId: task.localEvent?.id ?? null, withoutAirData: skipAir, noMedia: !!task.djiTask?.noMedia,
              ...(!skipAir ? { sniffSession: selectedAir!.session, sniffTabId: selectedAir!.id } : {}), mission,
            } });
            if (revision !== dataResetRef.current) return;
            const report = await invoke<FlightSummary>('save_flight_report', { data, charts: flightCharts(data), regenerate: !!task.report });
            if (revision !== dataResetRef.current) return;
            reportRevision.current++;
            setReports(items => [report, ...items.filter(item => item.id !== report.id)]);
            mediaBlocked.current.delete(task.key);
            if (!task.report) {
              try {
                const to = await sendSavedReportEmail(report.id);
                if (revision === dataResetRef.current) setAutoStatus(state => ({ ...state, [task.key]: `报告已生成，邮件已提交至 ${to}` }));
              } catch (e) {
                if (revision === dataResetRef.current) setAutoStatus(state => ({ ...state, [task.key]: `报告已生成，但邮件发送失败：${String(e).replace(/^Error:\s*/, '')}` }));
              }
            }
          } catch (e) {
            if (revision === dataResetRef.current) {
            recordFrontendError('report.auto_failed', e, reportFailureDetail(task, e));
              if (task.djiTask?.mediaReady && /司空媒体无照片：|司空媒体解析失败|照片尚未上传|尚无 Immediate-Media/.test(String(e))) mediaBlocked.current.set(task.key, mediaFingerprint(task));
              setAutoStatus(state => ({ ...state, [task.key]: reportGenerationFailure(task, e) }));
            }
          } finally { setAutoGenerating(''); }
        })();
        automaticJob.current = job;
        try { await job; } finally { automaticJob.current = null; }
      }
    } finally { automaticLock.current = false; }
  };
  const automatic = useRef(syncAndGenerate);
  automatic.current = syncAndGenerate;
  useEffect(() => {
    if (dataResetRef.current === dataResetKey) return;
    dataResetRef.current = dataResetKey;
    builderRequest.current++; selectedRef.current = null;
    if (manualWaiting.current) { lock.current = false; manualRequest.current = null; manualWaiting.current = false; setBusy(false); setWaiting(false); }
    setSelected(null); setPreview(null); setRegenerating(null); setLocalEventId(null);
    airHistory.current = null;
    setMissions([]); setDjiTasks([]); setReports([]); setTotal(0); setLoaded(false);
    setTaskPage(1); setPageInput(''); setIncludeHistory(false); setAutoStatus({});
    setMessage(''); setError(''); setSyncMessage(''); setSyncError('');
    missionLoadLock.current = false; setMissionLoading(false); historyPending.current = false; attempts.current.clear(); mediaBlocked.current.clear(); autoLoaded.current = '';
  }, [dataResetKey]);
  useEffect(() => {
    // Keep running while other app pages are visible. Serialize with the manual
    // dialog and retry failures without blocking the next scheduled flight.
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      try { await automatic.current(); } finally { if (!stopped) timer = setTimeout(tick, historyPending.current ? 5000 : 60000); }
    };
    timer = setTimeout(tick, 5000);
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const startReport = (task: PatrolTask) => {
    if (lock.current) return;
    let { mission } = task;
    const { localEvent: event, report, djiTask } = task;
    const actual = djiTask && !djiTask.actualTimeMissing && validWindow(djiTask.mission.startTime, djiTask.mission.endTime)
      ? djiTask.mission : event ? localFlightMission(event) : null;
    if (actual) mission = mission ? { ...mission, startTime: actual.startTime, endTime: actual.endTime } : actual;
    builderRequest.current++;
    setSelectedDjiTask(djiTask ?? null);
    setEditingFlight(false);
    setRegenerating(report ?? null);
    setWithoutAirData(!ready || !selectedAir); setLocalEventId(event?.id ?? report?.localEventId ?? null);
    setFlightName(mission?.missionName ?? event?.name ?? '巡飞任务'); setFlightStart(flightInputTime(mission?.startTime)); setFlightEnd(flightInputTime(mission?.endTime));
    selectedRef.current = mission ?? { missionId: 0, missionName: event?.name ?? '巡飞任务', startTime: 0, endTime: 0, geoLocation: '' };
    setSelected(selectedRef.current);
    setPreview(null); setMessage(''); setError('');
  };
  const collect = () => {
    let skipAir = withoutAirData;
    if (!selected || !selectedDji || (skipAir ? !mediaReady : !selectedAir || !ready)) return;
    let mission = selected;
    if (!selected.missionId) {
      const startTime = flightStart === flightInputTime(selected.startTime) ? selected.startTime : Date.parse(`${flightStart}+08:00`);
      const endTime = flightEnd === flightInputTime(selected.endTime) ? selected.endTime : Date.parse(`${flightEnd}+08:00`);
      if (!flightName.trim() || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || endTime > Date.now() - 60000 || endTime - startTime > 86400000) {
        setEditingFlight(true);
        setError('请填写任务名称和实际飞行起止时间；飞行须已结束至少 1 分钟，且时长不超过 24 小时。'); return;
      }
      mission = { ...selected, missionName: flightName.trim(), startTime, endTime };
    }
    const key = sourceKey;
    void run(async current => {
      if (!skipAir && !mission.missionId) {
        setMessage('正在查找本次航次的可飞历史采样…');
        const revision = dataResetRef.current;
        const valid = () => current() && revision === dataResetRef.current && missionSource.current === key;
        const history = await readAirinsHistory(mission.startTime, cursor => invoke<MissionPage>('list_flight_missions', {
          session: selectedAir!.session, tabId: selectedAir!.id, cursorId: cursor?.missionId ?? null, cursorTime: cursor?.startTime ?? null,
        }), valid);
        if (!valid()) return;
        const matched = associateAirinsMission(mission, history.missions, djiTasks.map(t => t.mission));
        setMissions(items => [...new Map([...items, ...history.missions].map(m => [m.missionId, m])).values()].sort((a, b) => b.startTime - a.startTime));
        setTotal(history.total);
        if (matched) {
          mission = matched;
          selectedRef.current = matched; setSelected(matched);
        } else {
          skipAir = true;
        }
      }
      setMessage(skipAir ? '正在核对司空航次与照片清单，优先复用本地照片…' : '正在核对航次与照片清单，优先复用本地照片和可飞数据，请保持平台页面打开…');
      const matchedDjiTask = selectedDjiTask?.mission.startTime === mission.startTime && selectedDjiTask?.mission.endTime === mission.endTime ? selectedDjiTask : null;
      const task = matchedDjiTask ? allTasks.find(item => item.djiTask?.taskId === matchedDjiTask.taskId && item.djiTask?.mission.startTime === mission.startTime && item.djiTask?.mission.endTime === mission.endTime) : undefined;
      let data: CollectedFlight;
      try {
        data = await invoke<CollectedFlight>('collect_flight_report', { request: { djiSession: selectedDji.session, djiTabId: selectedDji.id, mediaKey: matchedDjiTask?.taskId ?? `mission-${mission.startTime}-${mission.endTime}`, ...(matchedDjiTask?.noMedia && matchedDjiTask.mediaReady ? { noMedia: true } : {}), localEventId, ...(skipAir ? { withoutAirData: true } : { sniffSession: selectedAir!.session, sniffTabId: selectedAir!.id }), mission } });
      } catch (e) {
        recordFrontendError('report.manual_failed', e, reportFailureDetail(task ?? { key: `mission-${mission.startTime}-${mission.endTime}`, mission, djiTask: matchedDjiTask ?? undefined }, e));
        if (current() && task && task.djiTask?.mediaReady && /司空媒体无照片：|司空媒体解析失败|照片尚未上传|尚无 Immediate-Media/.test(String(e))) {
          mediaBlocked.current.set(task.key, mediaFingerprint(task));
          const message = reportGenerationFailure(task, e);
          setAutoStatus(state => ({ ...state, [task.key]: message }));
          if (String(e).replace(/^Error:\s*/, '').startsWith('司空媒体无照片：')) {
            setError('');
            setMessage(message);
            return;
          }
          setMessage('');
          setError(message);
          return;
        }
        throw e;
      }
      if (!current()) return;
      if (task) { mediaBlocked.current.delete(task.key); setAutoStatus(state => ({ ...state, [task.key]: '' })); }
      if (!skipAir && missionSource.current !== key) { setMessage('任务页面已变化，请重新选择任务。'); return; }
      setPreview(data); setMessage(skipAir && !withoutAirData ? '已查询对应时段的可飞历史任务，未找到匹配采样；五参数表将留空，请核对后生成报告。' : '资料读取完成，请核对后生成 Word 快报。');
    });
  };
  const save = () => { if (!preview) return; void run(async current => {
    const charts = flightCharts(preview);
    const report = await invoke<FlightSummary>('save_flight_report', { data: preview, charts, regenerate: !!regenerating });
    if (!current()) return;
    reportRevision.current++;
    setReports(items => [report, ...items.filter(item => item.id !== report.id && item.id !== regenerating?.id && (!preview.mission.missionId || item.mission?.missionId !== preview.mission.missionId) && (!preview.localEventId || item.localEventId !== preview.localEventId))]);
    selectedRef.current = null; setSelected(null); setPreview(null);
    setMessage('报告已保存，可在对应任务中打开 Word。');
  }); };
  const open = (report: FlightSummary, directory = false) => {
    setError('');
    void invoke(directory ? 'open_flight_report_directory' : 'open_flight_report', { id: report.id }).catch(e => setError(String(e)));
  };
  const platformUrl = (value: string | undefined, fallback: string, origin: string) => {
    try {
      const url = new URL(value || fallback);
      return url.origin === origin && url.protocol === 'https:' ? url.href : fallback;
    } catch {
      return fallback;
    }
  };
  const link = (url: string, label: string) => <a className="task-link" href={url} target="_blank" rel="noreferrer" onClick={event => { if (!openLink) return; event.preventDefault(); openLink(url); }}>{label} ↗</a>;
  const currentTasks = visibleReportTasks(patrolTasks(missions, reports, flightEvent, flightRecords, tasksClearedAt ?? 0, djiTasks), djiTasks);
  const allTasks = visibleReportTasks(patrolTasks(missions, reports, flightEvent, flightRecords, 0, djiTasks), djiTasks);
  usePatrolUnread(currentTasks, active, tasksClearedAt ?? 0, onUnreadChange);
  const tasks = includeHistory ? allTasks : currentTasks;
  const pageCount = Math.max(1, Math.ceil(tasks.length / 50));
  const currentPage = Math.min(taskPage, pageCount);
  const visibleTasks = tasks.slice((currentPage - 1) * 50, currentPage * 50);
  const hasRemoteMore = total > missions.length;
  useEffect(() => { setTaskPage(page => Math.min(page, pageCount)); }, [pageCount]);
  const pageNumbers = [...new Set([1, currentPage - 1, currentPage, currentPage + 1, pageCount])]
    .filter(page => page >= 1 && page <= pageCount).sort((a, b) => a - b);
  const jumpPage = () => {
    const page = Number(pageInput);
    if (Number.isInteger(page) && page >= 1 && page <= pageCount) { setTaskPage(page); setPageInput(''); }
  };
  const displayStart = preview?.mission.startTime ?? (selected?.missionId ? selected.startTime : Date.parse(`${flightStart}+08:00`));
  const displayEnd = preview?.mission.endTime ?? (selected?.missionId ? selected.endTime : Date.parse(`${flightEnd}+08:00`));
  const selectedEvent = [flightEvent, ...(flightRecords ?? [])].find(event => event?.id === localEventId);
  const usingDjiTime = (!!selectedDjiTask && displayStart === selectedDjiTask.mission.startTime && displayEnd === selectedDjiTask.mission.endTime)
    || (!!selectedEvent?.flightTime && displayStart === selectedEvent.flightTime.startTime && displayEnd === selectedEvent.flightTime.endTime);
  const formatFlightTime = usingDjiTime ? flightMinuteTime : beijingTime;
  const hasFlightTime = Number.isFinite(displayStart) && Number.isFinite(displayEnd) && displayStart > 0 && displayEnd > displayStart;
  const visibleTaskGroups = (() => {
    const groups = new Map<string, PatrolTask[]>();
    visibleTasks.forEach(task => {
      const window = actualWindow(task);
      const date = taskDate(window?.start ?? task.djiTask?.plannedStartTime ?? null);
      const group = groups.get(date) ?? [];
      group.push(task);
      groups.set(date, group);
    });
    return [...groups.entries()].map(([date, groupTasks]) => ({ date, tasks: groupTasks }));
  })();
  const renderTaskRow = (task: PatrolTask) => {
    const { key, mission, report, localEvent, djiTask } = task;
    const blockedMedia = mediaBlocked.current.get(key) === mediaFingerprint(task);
    const currentAutoStatus = mediaBlocked.current.has(key) && !blockedMedia ? '' : autoStatus[key];
    const displayedAutoStatus = currentAutoStatus ? localizedAutoStatus(currentAutoStatus) : '';
    const noPhotos = blockedMedia && currentAutoStatus?.includes('媒体上传已结束，无照片');
    const window = actualWindow(task);
    const localState = localEvent ? localFlightDisplay(localEvent) : null;
    const origin = localEvent ? localFlightOriginLabel(localEvent) : djiTask ? '司空平台任务' : mission?.missionId ? missionOriginLabel(mission) : report?.withoutAirData ? '司空平台任务' : '历史报告';
    const appTask = !!localEvent || origin.startsWith('本应用');
    const status = executionStatus(task);
    const ended = !!mission?.endTime && mission.endTime <= Date.now() - 60000;
    const djiTaskUrl = report?.mediaUrl;
    const djiMediaUrl = djiTask
      ? djiTask.mediaFolderId == null ? platformUrl(djiTaskUrl, DJI_MEDIA_URL, 'https://fh.dji.com') : djiMediaFolderUrl(djiTask.mediaFolderId)
      : DJI_MEDIA_URL;
    const remarks = taskRemarks(task, appTask, status);
    const planName = mission?.missionName ?? localEvent?.name ?? report?.title ?? '未命名任务';
    const routeName = djiTask?.routeName || localEvent?.route || '航线未记录';
    const legacyTime = localEvent ? localFlightTimeDisplay(localEvent) : null;
    const legacyObservedAt = localEvent ? Date.parse(`${localEvent.observedAt.replace(' ', 'T')}+08:00`) : NaN;
    return <tr className={`report-row${appTask ? ' task-row-app' : ''}`} key={key}>
      <td className="task-actual-time">{window?.start && window.end ? <strong>{taskClock(window.start)} 至 {taskClock(window.end)}</strong> : window?.start ? <><strong>{taskClock(window.start)}</strong><small>结束时间待确认</small></> : <><span className="muted">实际时间待确认</span>{localEvent && ['completed', 'flying', 'paused', 'flight_error'].includes(localEvent.status) && <small>实际飞行时间待补全</small>}</>}</td>
      <td><span className={`task-status task-status-${status.tone}`}><i aria-hidden="true" />{status.label}</span>{djiTask?.status === '部分执行' && djiTask.partialReason && <small className="task-status-reason">{djiTask.partialReason}</small>}{djiTask?.actualTimeMissing && <small className="task-warning">司空未返回完整实际时间</small>}{displayedAutoStatus && !report && <small className={noPhotos ? undefined : 'task-warning'}>{displayedAutoStatus}{onReportIssue && /自动生成暂未完成|媒体上传已结束|未能生成/.test(displayedAutoStatus) && <button type="button" className="task-action-link" onClick={onReportIssue}>上报此问题</button>}</small>}</td>
      <td><span className="task-type">{localEvent?.source === 'auto' ? '自动任务' : localEvent ? '手飞任务' : taskTypeLabel(djiTask?.taskType)}</span><small>{origin}</small></td>
      <td className="task-plan"><strong>{planName}</strong><small>航线：{routeName}</small><span className="task-links">{!!mission?.missionId && link(airinsMissionUrl(mission), '可飞任务')}{djiTask ? link(djiMediaUrl, '司空媒体库') : mission?.missionId || report?.mediaUrl ? link(platformUrl(djiTaskUrl, DJI_MEDIA_URL, 'https://fh.dji.com'), djiTaskUrl ? '司空任务' : '司空平台') : localEvent && localState?.submitted && link(DJI_PLAN_URL, '司空计划')}</span></td>
      <td className="task-media">{djiTask?.noMedia ? <span className="muted">无媒体文件</span> : djiTask ? <>{noPhotos && <small>无照片</small>}<span className={`task-media-state ${djiTask.mediaReady ? 'success' : 'pending'}`}>{djiTask.mediaUploadedCount != null && djiTask.mediaExpectedCount != null ? `媒体文件（${djiTask.mediaUploadedCount}/${djiTask.mediaExpectedCount}）` : djiTask.mediaReady ? '媒体已上传（数量待核对）' : '媒体上传状态待核对'}</span></> : report ? <><span className="task-media-state success">媒体文件（{report.photoCount}/{report.photoCount}）</span><small>{report.photoCount} 张照片</small></> : <span className="muted">未上传</span>}</td>
      <td className="task-remarks">{remarks.map((remark, index) => <small key={index} className={remark.includes('失败') || remark.includes('异常') ? 'task-warning' : undefined}>{remark}</small>)}{report && <small>已生成报告 · {report.photoCount} 张照片</small>}{displayedAutoStatus && <small className={displayedAutoStatus.includes('失败') || displayedAutoStatus.includes('异常') ? 'task-warning' : undefined}>{displayedAutoStatus}</small>}{legacyTime?.detail && <small>{legacyTime.detail}</small>}{localEvent && legacyTime?.label === '尚无飞行记录' && <small>{legacyTime.label}</small>}{Number.isFinite(legacyObservedAt) && <small>{origin === '本应用 · 自动巡查' ? '触发数据时间' : '任务发起时间'} {beijingTime(legacyObservedAt)}</small>}{localState?.action && <small>{localState.action}</small>}{localEvent?.error && <details className="task-receipt"><summary>查看原始回执</summary><p>{localEvent.error}</p></details>}{localEvent?.status === 'failed' && !localEvent.resolvedAt && <small>请在监测总览的巡查任务模块人工核验后重新发起。</small>}{localEvent?.resolvedAt && <small>结束处理时间 {beijingTime(localEvent.resolvedAt)}</small>}<span className="task-weather task-legacy-details">{localEvent?.weatherChecks?.length ? <RecordedWeather checks={localEvent.weatherChecks} /> : appTask ? '当时天气未记录' : '司空平台任务无需记录天气'}</span></td>
      <td className="task-actions">{report ? <div className="task-action-list"><button className="secondary-button word-report-button" onClick={() => open(report)} title={report.issueCount != null ? `高温疑似问题 ${report.issueCount} 组 · 仅计含最高温度标签的照片组，同组辅助照片与最低温度标签不另计问题` : '问题数量待核对'}>打开 Word{(report.issueCount ?? 0) > 0 && <span className="report-issue-badge" aria-label={`${report.issueCount} 个问题`}>{report.issueCount}</span>}</button><div className="task-action-links"><button className="task-action-link" onClick={() => setEmailReport(report)}>重新发送邮件</button><button className="task-action-link" title="打开此报告所在文件夹并选中 Word 文件" onClick={() => open(report, true)}>打开文件夹</button><button className="task-action-link" disabled={busy || !mission || !ended} title={!mission ? '历史报告缺少任务资料，请先连接平台刷新任务' : undefined} onClick={() => startReport(task)}>重新生成报告</button></div></div> : djiTask && !djiTask.mediaReady ? <span className="muted">等待媒体上传结束</span> : mission && !ended ? <span className="muted">等待任务结束</span> : mission || localEvent?.status === 'completed' ? <button className="primary-button" disabled={busy} onClick={() => startReport(task)}>{blockedMedia ? '重新读取媒体' : '生成报告'}</button> : <span className="muted">{localState?.action ?? '—'}</span>}</td>
    </tr>;
  };
  return <div className="report-center">
    <div className="page-heading"><div><span className="eyebrow">无人机巡飞</span><h2>巡查任务</h2><p>同步本应用及司空平台任务；仅北京时间今天的任务会在媒体上传完成后自动生成 Word 快报，历史任务请手动生成。</p></div><button className="secondary-button" disabled={syncing || missionLoading} onClick={() => mediaReady && selectedDji ? void syncTasks() : ready ? load() : onPrepare()}>{syncing || missionLoading ? '正在读取…' : mediaReady || ready ? '刷新任务' : '重新检查环境'}</button></div>
    {!ready ? <p className="notice">可查看本机已保存的任务与报告；重新检查环境后可读取更多任务；无可飞数据时可单独连接司空生成报告。</p> : !air.length ? <div className="notice"><p>打开可飞历史任务页面后读取巡查任务。</p><button className="secondary-button" onClick={openAir}>打开可飞历史任务 ↗</button></div> : null}
    {!selected && <>{syncMessage && <p role="status" className="notice">{syncMessage}</p>}{syncError && <p role="alert" className="notice warning">{syncError}</p>}{autoGenerating && <p role="status" className="notice">正在后台生成“{autoGenerating}”的报告，可继续查看任务或打开已有报告。</p>}{message && <p role="status" className="notice">{message}</p>}{error && <p role="alert" className="notice warning">{error}</p>}</>}
    <section className="history-card"><div className="section-heading"><h3>任务列表</h3><span className="muted">{tasks.length} 个任务 · {tasks.filter(t => t.report).length} 份报告</span></div>
      {!tasks.length ? <div className="empty-state"><h3>{syncing || missionLoading ? '正在读取巡查任务' : loaded ? '暂无巡查任务' : '暂无已保存的任务'}</h3><p>{loaded ? '今天的任务会在飞行结束且媒体上传完成后自动生成报告，历史任务请在对应行手动生成。' : '连接司空平台后自动同步任务，已保存的报告会显示在对应任务中。'}</p></div> : <div className="report-table-wrap"><div className="task-groups">{visibleTaskGroups.map(group => <section className="task-date-group" key={group.date}><div className="task-date-row">{group.date}{group.date === taskDate(Date.now()) && <span>今天</span>}</div><div className="task-group-scroll"><table className="report-table task-table"><thead><tr><th>实际执行时间</th><th>执行状态</th><th>类型</th><th>计划名称 / 航线名称</th><th>媒体文件</th><th>备注</th><th>操作</th></tr></thead><tbody>{group.tasks.map(renderTaskRow)}</tbody></table></div></section>)}</div></div>}
      <div className="task-pagination" aria-label="任务分页">
        <span className="muted">共 {tasks.length} 条 · 50 条/页 · 第 {currentPage} / {pageCount} 页</span>
        <button className="secondary-button" aria-label="上一页任务" disabled={currentPage === 1} onClick={() => setTaskPage(currentPage - 1)}>上一页</button>
        {pageNumbers.map((page, index) => <span className="task-page-number" key={page}>{index > 0 && page - pageNumbers[index - 1] > 1 && <span className="muted">…</span>}<button className="secondary-button" aria-label={`第 ${page} 页任务`} aria-current={page === currentPage ? 'page' : undefined} onClick={() => setTaskPage(page)}>{page}</button></span>)}
        <button className="secondary-button" aria-label="下一页任务" disabled={currentPage === pageCount} onClick={() => setTaskPage(currentPage + 1)}>下一页</button>
        <form onSubmit={event => { event.preventDefault(); jumpPage(); }}><label>跳至 <input aria-label="任务页码" type="number" min="1" max={pageCount} step="1" value={pageInput} onChange={event => setPageInput(event.target.value)} /> 页</label><button className="text-button" type="submit" disabled={!pageInput || !Number.isInteger(Number(pageInput)) || Number(pageInput) < 1 || Number(pageInput) > pageCount}>跳转</button></form>
      </div>
      {allTasks.length > currentTasks.length && <button className="text-button" onClick={() => { setIncludeHistory(value => !value); setTaskPage(1); }}>{includeHistory ? '仅显示当前任务' : `显示历史任务（共 ${allTasks.length} 条）`}</button>}
      {hasRemoteMore && <button className="text-button load-earlier-button" disabled={missionLoading || !ready || !selectedAir} onClick={() => load(true)}>{missionLoading ? '正在同步历史任务…' : '同步更多可飞历史任务'}</button>}

    </section>
    {emailReport && <ReportEmailDialog onSettings={onSettings ? () => { setEmailReport(null); onSettings(); } : undefined} reportId={emailReport.id} onClose={() => setEmailReport(null)} onSent={to => { setEmailReport(null); setError(''); setMessage(`阿里云已接收发往 ${to} 的报告邮件，最终投递状态请查看发送详情。`); }} />}
    {selected && <dialog ref={builder} className="settings-dialog report-dialog" aria-labelledby="report-dialog-title" onCancel={event => { event.preventDefault(); closeBuilder(); }}>
      <div className="settings-header"><div><h3 id="report-dialog-title">{regenerating ? '重新生成巡飞报告' : '生成巡飞报告'}</h3><p>{preview?.mission.missionName ?? flightName}{selected.missionId ? ` · 任务编号 ${selected.missionId}` : ''}</p></div><button className="text-button" disabled={busy && !waiting} onClick={closeBuilder} aria-label="关闭生成报告弹窗">关闭</button></div>
      <div className="report-dialog-body report-builder" aria-busy={busy}>
        <ol className="setup-steps compact">{['按时间匹配资料', '生成 Word 快报'].map((label, i) => <li key={label} className={i === (preview ? 1 : 0) ? 'current' : ''}><span>{i + 1}</span>{label}</li>)}</ol>
        <section className="report-materials" aria-label="报告资料">
          <div className="report-material-row">
            <span className="report-material-label">飞行时间<small>北京时间</small></span>
            <div className="report-material-value"><strong>{hasFlightTime ? `${formatFlightTime(displayStart)} 至 ${formatFlightTime(displayEnd)}` : '实际飞行时间待补全'}</strong><small>{hasFlightTime ? usingDjiTime ? `司空实际时间 · 执行时长 ${(displayEnd - displayStart) / 60000} 分钟（分钟精度）` : preview ? '航次时间已核对' : '将按此时间匹配司空航次' : '请补充实际起止时间，再匹配司空航次'}</small></div>
            {!selected.missionId && !preview && <button className="text-button" disabled={busy} aria-expanded={editingFlight} aria-controls="report-flight-fields" onClick={() => setEditingFlight(value => !value)}>{editingFlight ? '收起' : hasFlightTime ? '修改时间' : '补充时间'}</button>}
          </div>
          {!selected.missionId && !preview && editingFlight && <div id="report-flight-fields" className="report-flight-fields">
            <label className="report-flight-name">任务名称<input value={flightName} disabled={busy} onInput={e => setFlightName(e.currentTarget.value)} /></label>
            <label>飞行开始时间（北京时间）<input type="datetime-local" step="1" value={flightStart} disabled={busy} onInput={e => setFlightStart(e.currentTarget.value)} /></label>
            <label>飞行结束时间（北京时间）<input type="datetime-local" step="1" value={flightEnd} disabled={busy} onInput={e => setFlightEnd(e.currentTarget.value)} /></label>
          </div>}
          <div className="report-material-row">
            <span className="report-material-label">司空照片</span>
            <div className="report-material-value"><strong>{preview ? `已读取 ${preview.photos.length} 张照片` : '按飞行时间自动匹配'}</strong><small>{preview ? '照片与来源可在下方查看' : '匹配航次后读取原始照片，允许前后 5 分钟差异'}</small></div>
            {!selectedDji && !preview && <button className="text-button" disabled={busy} onClick={openMedia}>打开媒体库 ↗</button>}
          </div>
          <div className="report-material-row">
            <span className="report-material-label">可飞采样</span>
            <div className="report-material-value"><strong>{(preview?.withoutAirData ?? withoutAirData) ? '暂无可飞数据 · 报告对应内容留空' : preview ? `已读取 ${preview.air.points.length} 个采样点` : selected.missionId ? '读取本次任务采样' : '按飞行时间查找可飞历史采样'}</strong><small>{(preview?.withoutAirData ?? withoutAirData) ? '五参数表对应内容留空，司空照片按模板收录' : '表4按实际执飞时段统计最高值和平均值，完整采样保留归档'}</small>
              {!preview && <label className="checkbox-label"><input type="checkbox" checked={withoutAirData} disabled={busy} onChange={e => { setWithoutAirData(e.currentTarget.checked); setMessage(''); setError(''); }} />可飞数据暂不可用，相关内容留空</label>}
            </div>
          </div>
        </section>
        {message && <p role="status" className="notice">{message}</p>}{error && <p role="alert" className="notice warning">{error}</p>}
        {autoGenerating && !busy && <p role="status" className="notice">后台正在生成“{autoGenerating}”的报告。点击读取资料后，将在当前报告完成后优先处理本次请求。</p>}
        {waiting && <p role="status" className="notice">已排队，当前报告完成后将自动读取本次资料；关闭弹窗可取消等待。</p>}
        {!selectedDji && !preview && <p className="notice warning">未找到当前项目的司空页面，请点击“打开媒体库”。已有司空计划页也可用于读取资料。</p>}
        {!withoutAirData && !selectedAir && !preview && <div className="notice warning">未找到可飞任务页面。<button className="text-button" disabled={busy} onClick={openAir}>打开可飞历史任务 ↗</button></div>}
        {!(withoutAirData ? mediaReady : ready) && !preview && <div className="notice warning">{withoutAirData ? '请登录司空媒体库，登录后会自动验证连接。' : '网站状态发生变化，请先恢复连接。'}<button className="text-button" disabled={busy} onClick={() => { closeBuilder(); onPrepare(); }}>重新检查环境</button></div>}
        {preview && <>{!preview.withoutAirData && preview.air.points.some(p => p.time >= preview.mission.startTime && p.time <= preview.mission.endTime && p.pm25 != null) && preview.air.points.filter(p => p.time >= preview.mission.startTime && p.time <= preview.mission.endTime).every(p => p.pm25 == null || p.pm25 === 0) && <p className="notice warning">PM2.5 有效读数全部为 0，请核查传感器。此提示也会保留在报告记录中。</p>}<details className="flight-preview"><summary>查看照片与来源</summary><p>{preview.media.folder}</p>{preview.photos.map(p => <figure key={p.name}><img src={p.presentation?.dataUrl ?? p.dataUrl} alt={p.name} /><figcaption>{p.name}</figcaption></figure>)}</details></>}
      </div>
      <div className="report-dialog-footer">{preview ? <><button className="secondary-button" disabled={busy} onClick={() => { setPreview(null); setMessage(''); setError(''); }}>重新匹配资料</button><button className="primary-button" disabled={busy} onClick={save}>{busy ? '正在保存…' : '生成并保存 Word 快报'}</button></> : <button className="primary-button" disabled={!selectedDji || busy || (withoutAirData ? !mediaReady : !selectedAir || !ready)} onClick={collect}>{waiting ? '等待当前报告完成…' : busy ? '正在匹配并读取资料…' : '自动匹配并读取资料'}</button>}</div>
    </dialog>}
  </div>;
}
