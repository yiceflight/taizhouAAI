import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { tabKey, type BrowserTab } from '../lib/workspace';
import { DJI_MEDIA_URL, airinsMissionUrl, beijingTime, flightCharts, localFlightDisplay, localFlightOriginLabel, missionOriginLabel, patrolTasks, type FlightWeather, type Mission, type CollectedFlight, type FlightSummary, type LocalFlightEvent } from '../lib/flightReport';
import { weatherText, type WeatherCheck } from '../lib/weather';

const measured = (value: number | null, unit: string) => value == null ? '缺测' : `${value.toFixed(1)} ${unit}`;
function RecordedWeather({ checks }: { checks: WeatherCheck[] }) {
  const creation = checks.find(check => check.stage === 'creation');
  if (!creation) return <span className="muted">当时天气未记录</span>;
  const { weather, checkedAt } = creation;
  const sample = weather.current;
  return <>
    <strong>{sample ? `${weatherText(sample.weatherCode)} · ${measured(sample.temperature, '°C')}` : '当时天气获取不可用'}</strong>
    {sample && <small>风 {measured(sample.windSpeed, 'm/s')} / 阵风 {measured(sample.windGusts, 'm/s')} · 降水 {measured(sample.precipitation, 'mm')}</small>}
    <small className={weather.allowed ? '' : 'task-warning'}>{weather.label} · {weather.reasons.join(' ')}</small>
    <small className="task-weather-time">任务创建时刻：{beijingTime(checkedAt)}</small>
    <small className="task-weather-time">天气数据时刻：{sample ? beijingTime(sample.observedAt * 1000) : '未获取'}</small>
  </>;
}

type Props = { tabs: BrowserTab[]; ready: boolean; active?: boolean; onPrepare: () => void; openMedia: () => void; openAir: () => void; openLink?: (url: string) => void; flightEvent?: LocalFlightEvent | null; flightRecords?: LocalFlightEvent[]; onReportGeneratingChange?: (value: boolean) => void };
export function FlightReportPanel({ tabs, ready, active = true, onPrepare, openMedia, openAir, openLink, flightEvent, flightRecords, onReportGeneratingChange }: Props) {
  const [selected, setSelected] = useState<Mission | null>(null);
  const [airKey, setAirKey] = useState('');
  const [missions, setMissions] = useState<Mission[]>([]);
  const [total, setTotal] = useState(0), [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [reports, setReports] = useState<FlightSummary[]>([]);
  const [weather, setWeather] = useState<Record<string, FlightWeather>>({});
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState('');
  const weatherRequests = useRef(0);
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
    if (lock.current) return;
    setSelected(null); setPreview(null); setMessage(''); setError('');
  };
  const air = tabs.filter(t => { try { const u = new URL(t.url); return u.origin === 'https://aai.airins.cn' && u.pathname.startsWith('/sniff') && t.status === 'complete'; } catch { return false; } });
  const dji = tabs.filter(t => { try { const u = new URL(t.url); return u.origin === 'https://fh.dji.com' && u.pathname === new URL(DJI_MEDIA_URL).pathname && u.hash.startsWith('#/media') && t.status === 'complete'; } catch { return false; } });
  const selectedAir = air.find(t => tabKey(t) === airKey) || (air.length === 1 ? air[0] : undefined);
  // Media folders are located by flight time; an open tab is only the browser session.
  const selectedDji = dji.find(t => t.session === selectedAir?.session) || dji[0];
  const sourceKey = selectedAir ? tabKey(selectedAir) : '';
  const missionSource = useRef(sourceKey);
  missionSource.current = sourceKey;
  useEffect(() => { setMissions([]); if (!preview) setSelected(null); setTotal(0); setLoaded(false); }, [sourceKey]);
  useEffect(() => { if (isTauri()) void invoke<FlightSummary[]>('list_flight_reports').then(setReports).catch(e => setError(String(e))); }, []);
  useEffect(() => { if (isTauri()) void invoke<Record<string, FlightWeather>>('list_flight_weather').then(items => setWeather(current => ({ ...items, ...current }))).catch(e => setWeatherError(`读取历史天气失败：${e}`)); }, []);
  const enrichWeather = (items: Mission[]) => {
    if (!items.length) return;
    weatherRequests.current += 1;
    setWeatherLoading(true);
    void invoke<{ weather: Record<string, FlightWeather>; error: string | null }>('enrich_flight_weather', { missions: items }).then(result => {
      setWeather(current => ({ ...current, ...result.weather }));
      if (result.error) setWeatherError(`部分历史天气暂未补全：${result.error}`);
    }).catch(e => setWeatherError(`历史天气补全失败：${e}`)).finally(() => {
      weatherRequests.current -= 1;
      setWeatherLoading(weatherRequests.current > 0);
    });
  };
  useEffect(() => {
    setWeatherError('');
    const known = patrolTasks(missions, reports).flatMap(task => task.mission ? [task.mission] : []);
    for (let i = 0; i < known.length; i += 50) enrichWeather(known.slice(i, i + 50));
  }, [missions, reports]);
  const run = async (job: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await job(); } catch (e) { setError(String(e)); setMessage(''); } finally { lock.current = false; setBusy(false); }
  };
  const load = (more = false) => {
    if (!selectedAir || !ready) return;
    const key = tabKey(selectedAir);
    void run(async () => {
      const last = missions[missions.length - 1];
      const result = await invoke<{ missions: Mission[]; total: number }>('list_flight_missions', { session: selectedAir.session, tabId: selectedAir.id, cursorId: more ? last?.missionId : null, cursorTime: more ? last?.startTime : null });
      if (missionSource.current !== key) return;
      setMissions(items => more ? [...items, ...result.missions.filter(m => !items.some(i => i.missionId === m.missionId))] : result.missions);
      setTotal(more && !result.missions.length ? missions.length : result.total);
      setLoaded(true);
    });
  };
  const autoLoaded = useRef('');
  useEffect(() => {
    if (!sourceKey) autoLoaded.current = '';
    if (active && ready && sourceKey && !busy && autoLoaded.current !== sourceKey) {
      autoLoaded.current = sourceKey;
      load();
    }
  }, [active, ready, sourceKey, busy]);
  const collect = () => {
    if (!selected || !selectedAir || !selectedDji || !ready) return;
    const key = sourceKey;
    void run(async () => {
      setMessage('正在按飞行时间匹配司空航次、读取采样数据和下载照片，请保持平台页面打开…');
      const data = await invoke<CollectedFlight>('collect_flight_report', { request: { djiSession: selectedDji.session, djiTabId: selectedDji.id, sniffSession: selectedAir.session, sniffTabId: selectedAir.id, mission: selected } });
      if (missionSource.current !== key) { setMessage('任务页面已变化，请重新选择任务。'); return; }
      setPreview(data); setMessage('资料读取完成，请核对后生成 Word 快报。');
    });
  };
  const save = () => { if (!preview) return; void run(async () => {
    onReportGeneratingChange?.(true);
    try {
      const charts = flightCharts(preview);
      const report = await invoke<FlightSummary>('save_flight_report', { data: preview, charts });
      setReports(items => [report, ...items.filter(item => item.id !== report.id && item.mission?.missionId !== preview.mission.missionId)]);
      setSelected(null); setPreview(null);
      setMessage('报告已保存，可在对应任务中打开 Word。');
    } finally { onReportGeneratingChange?.(false); }
  }); };
  const open = (report: FlightSummary) => void invoke('open_flight_report', { id: report.id }).catch(e => setError(String(e)));
  const platformUrl = (value: string | undefined, fallback: string, origin: string) => {
    try {
      const url = new URL(value || fallback);
      return url.origin === origin && url.protocol === 'https:' ? url.href : fallback;
    } catch {
      return fallback;
    }
  };
  const link = (url: string, label: string) => <a className="task-link" href={url} target="_blank" rel="noreferrer" onClick={event => { if (!openLink) return; event.preventDefault(); openLink(url); }}>{label} ↗</a>;
  const tasks = patrolTasks(missions, reports, flightEvent, flightRecords);
  return <div className="report-center">
    <div className="page-heading"><div><span className="eyebrow">无人机巡飞</span><h2>巡查任务</h2><p>每个任务对应一份报告，飞行结束后核对资料并生成 Word 快报。</p></div><button className="secondary-button" disabled={busy || (ready && !selectedAir)} onClick={() => ready ? load() : onPrepare()}>{busy ? '正在读取…' : ready ? '刷新任务' : '完成工作准备'}</button></div>
    {!ready ? <p className="notice">可查看本机已保存的任务与报告；完成工作准备后可读取更多任务、生成报告。</p> : !air.length ? <div className="notice"><p>打开可飞历史任务页面后读取巡查任务。</p><button className="secondary-button" onClick={openAir}>打开可飞历史任务 ↗</button></div> : air.length > 1 && <label className="task-source">任务来源<select disabled={busy} value={selectedAir ? tabKey(selectedAir) : ''} onChange={e => setAirKey(e.target.value)}><option value="">请选择可飞页面</option>{air.map(t => <option key={tabKey(t)} value={tabKey(t)}>{t.title} · 页面 {t.id}</option>)}</select></label>}
    {!selected && <>{message && <p role="status" className="notice success">{message}</p>}{error && <p role="alert" className="notice warning">{error}</p>}</>}
    <section className="history-card"><div className="section-heading"><h3>任务列表</h3><span className="muted">{tasks.length} 个任务 · {tasks.filter(t => t.report).length} 份报告</span></div>
      {weatherError && <p className="task-weather-error" role="status">{weatherError}</p>}
      {!tasks.length ? <div className="empty-state"><h3>{busy ? '正在读取巡查任务' : loaded ? '暂无巡查任务' : '暂无已保存的任务'}</h3><p>{loaded ? '飞行任务同步到可飞后，刷新列表即可查看。' : '连接可飞平台后读取任务，已保存的报告会显示在对应任务中。'}</p></div> : <div className="report-table-wrap"><table className="report-table task-table"><thead><tr><th>巡查任务 / 来源</th><th>飞行时间（北京时间）</th><th>天气状态</th><th>任务 / 报告状态</th><th>操作</th></tr></thead><tbody>{tasks.map(({ key, mission, report, localEvent }) => {
        const localTime = localEvent ? Date.parse(`${localEvent.observedAt.replace(' ', 'T')}+08:00`) : NaN;
        const localState = localEvent ? localFlightDisplay(localEvent) : null;
        const origin = mission ? missionOriginLabel(mission) : localEvent ? localFlightOriginLabel(localEvent) : '历史报告';
        const appTask = !!localEvent || origin.startsWith('本应用');
        const ended = !!mission?.endTime && mission.endTime <= Date.now() - 60000;
        const sample = mission && weather[mission.missionId]?.startTime === mission.startTime ? weather[mission.missionId] : null;
        const djiTaskUrl = report?.mediaUrl;
        return <tr className={`report-row${appTask ? ' task-row-app' : ''}`} key={key}>
          <td><strong>{mission?.missionName ?? localEvent?.name ?? report!.title}</strong><small>{mission ? `任务编号 ${mission.missionId}${mission.geoLocation ? ` · ${mission.geoLocation}` : ''}` : localEvent ? `本地任务编号 ${localEvent.id.slice(0, 8)}` : '历史报告'}</small><span className="task-origin">{origin}</span><span className="task-links">{mission && link(airinsMissionUrl(mission), '可飞任务')}{mission ? link(platformUrl(djiTaskUrl, DJI_MEDIA_URL, 'https://fh.dji.com'), djiTaskUrl ? '司空任务' : '司空平台') : localEvent && <span className="muted">{localEvent.resolvedAt ? '已结束本地处理' : localState?.submitted ? '等待平台同步' : '未提交起飞请求'}</span>}</span></td>
          <td>{mission ? <>{beijingTime(mission.startTime)}<small>至 {mission.endTime ? beijingTime(mission.endTime) : '尚未结束'}</small></> : localEvent ? <>尚无飞行记录{Number.isFinite(localTime) && <small>{origin === '本应用 · 自动巡查' ? '触发数据时间' : '任务发起时间'} {beijingTime(localTime)}</small>}</> : '—'}</td>
          <td className="task-weather">{localEvent?.weatherChecks?.length ? <RecordedWeather checks={localEvent.weatherChecks} /> : sample ? <><strong>{weatherText(sample.weatherCode)} · {sample.temperature.toFixed(1)} °C</strong><small>风 {sample.windSpeed.toFixed(1)} / 阵风 {sample.windGusts.toFixed(1)} m/s · 降水 {sample.precipitation} mm</small><small title={`补录时间 ${beijingTime(sample.fetchedAt * 1000)}`}>数据时刻 {beijingTime(sample.observedAt * 1000)}</small></> : <span className="muted">{localEvent ? '当时天气未记录' : mission && !ended ? '任务结束后补全' : weatherLoading ? '正在补全…' : '天气待补全'}</span>}</td>
          <td><span className={`badge ${report ? 'success' : 'warning'}`}>{report ? '已生成报告' : localEvent ? localState?.label : ended ? '待生成报告' : '等待任务结束'}</span>{report && <small>{report.photoCount} 张照片 · {report.pointCount} 个采样点</small>}{report?.warning && <small className="task-warning">{report.warning}</small>}{localEvent?.error && (localEvent.status === 'restricted' ? <small className="task-warning">{localEvent.error}</small> : <details className="task-receipt"><summary>查看原始回执</summary><p>{localEvent.error}</p></details>)}{localEvent?.status === 'failed' && !localEvent.resolvedAt && <small>请在监测总览的巡查任务模块人工核验后重新发起。</small>}{localEvent?.resolvedAt && <small>结束处理时间 {beijingTime(localEvent.resolvedAt)}</small>}{localEvent?.weatherOverrideConfirmedAt && <small>已人工确认 · 本次覆盖天气拦截</small>}{localEvent?.statusCheckError && <small className="task-warning">司空核查：{localEvent.statusCheckError}</small>}</td>
          <td>{report ? <button className="secondary-button" onClick={() => open(report)}>打开 Word</button> : mission ? <button className="primary-button" disabled={!ended || !ready || busy || !selectedAir} onClick={() => { setSelected(mission); setPreview(null); setMessage(''); setError(''); }}>生成报告</button> : <span className="muted">{localState?.action ?? '—'}</span>}</td>
        </tr>;
      })}</tbody></table></div>}
      {total > missions.length && <button className="text-button load-earlier-button" disabled={busy || !ready} onClick={() => load(true)}>加载更早任务（{missions.length} / {total}）</button>}
    </section>
    {selected && <dialog ref={builder} className="settings-dialog report-dialog" aria-labelledby="report-dialog-title" onCancel={event => { event.preventDefault(); closeBuilder(); }}>
      <div className="settings-header"><div><h3 id="report-dialog-title">生成巡飞报告</h3><p>{selected.missionName} · 任务编号 {selected.missionId}</p></div><button className="text-button" disabled={busy} onClick={closeBuilder} aria-label="关闭生成报告弹窗">关闭</button></div>
      <div className="report-dialog-body report-builder" aria-busy={busy}>
        <p className="report-flight-time">飞行时间（北京时间）<br /><strong>{beijingTime(selected.startTime)} 至 {beijingTime(selected.endTime)}</strong></p>
        <ol className="setup-steps compact">{['按时间匹配资料', '生成 Word 快报'].map((label, i) => <li key={label} className={i === (preview ? 1 : 0) ? 'current' : ''}><span>{i + 1}</span>{label}</li>)}</ol>
        {message && <p role="status" className="notice success">{message}</p>}{error && <p role="alert" className="notice warning">{error}</p>}
        {!ready && !preview && <div className="notice warning">网站状态发生变化，请先恢复连接。<button className="text-button" disabled={busy} onClick={() => { closeBuilder(); onPrepare(); }}>前往处理 →</button></div>}
        {!preview ? <div className="wizard-fields"><div className="notice"><p>根据本次飞行时间自动查找司空航次和照片，无需手动选择任务文件夹。航次开始时间允许前后 5 分钟差异，照片时间会再次核对。</p>{!selectedDji && <button className="secondary-button" onClick={openMedia}>打开司空媒体库 ↗</button>}</div>
          <button className="primary-button" disabled={!selectedAir || !selectedDji || busy || !ready} onClick={collect}>{busy ? '正在匹配并读取资料…' : '自动匹配并读取资料'}</button>
        </div> : <div className="wizard-fields"><div className="notice success"><strong>{preview.mission.missionName}</strong><p>{preview.photos.length} 张照片 · {preview.air.points.length} 个采样点 · 航次时间已核对</p></div>{preview.air.points.every(p => p.pm25 == null || p.pm25 === 0) && <p className="notice warning">PM2.5 有效读数全部为 0，请核查传感器。此提示也会保留在报告记录中。</p>}<details className="flight-preview"><summary>查看照片与来源</summary><p>{preview.media.folder}</p>{preview.photos.map(p => <figure key={p.name}><img src={p.dataUrl} alt={p.name} /><figcaption>{p.name}</figcaption></figure>)}</details><div className="button-row"><button className="secondary-button" disabled={busy} onClick={() => { setPreview(null); setMessage(''); setError(''); }}>重新匹配资料</button><button className="primary-button" disabled={busy} onClick={save}>{busy ? '正在保存…' : '生成并保存 Word 快报'}</button></div></div>}
      </div>
    </dialog>}
  </div>;
}
