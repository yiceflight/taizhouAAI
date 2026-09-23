import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { tabKey, type BrowserTab } from '../lib/workspace';
import { beijingTime, flightCharts, type Mission, type CollectedFlight, type FlightSummary } from '../lib/flightReport';

type Props = { tabs: BrowserTab[]; ready: boolean; onPrepare: () => void; openMedia: () => void; openAir: () => void };
export function FlightReportPanel({ tabs, ready, onPrepare, openMedia, openAir }: Props) {
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState(0);
  const [djiKey, setDjiKey] = useState(''), [airKey, setAirKey] = useState('');
  const [missions, setMissions] = useState<Mission[]>([]), [missionId, setMissionId] = useState('');
  const [total, setTotal] = useState(0), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [reports, setReports] = useState<FlightSummary[]>([]);
  const [preview, setPreview] = useState<CollectedFlight | null>(null);
  const lock = useRef(false);
  const builder = useRef<HTMLElement>(null);
  useEffect(() => { if (creating) builder.current?.scrollIntoView({ block: 'start' }); }, [creating, step]);
  const air = tabs.filter(t => { try { const u = new URL(t.url); return u.origin === 'https://aai.airins.cn' && u.pathname.startsWith('/sniff') && t.status === 'complete'; } catch { return false; } });
  const dji = tabs.filter(t => { try { const u = new URL(t.url); return u.origin === 'https://fh.dji.com' && u.hash.startsWith('#/media') && t.status === 'complete'; } catch { return false; } });
  const selectedAir = air.find(t => tabKey(t) === airKey) || (air.length === 1 ? air[0] : undefined);
  const selectedDji = dji.find(t => tabKey(t) === djiKey) || (dji.length === 1 ? dji[0] : undefined);
  const selected = missions.find(m => String(m.missionId) === missionId);
  const missionSource = useRef('');
  const sourceKey = selectedAir ? tabKey(selectedAir) : '';
  useEffect(() => { if (sourceKey !== missionSource.current) { setMissions([]); setMissionId(''); setTotal(0); missionSource.current = sourceKey; } }, [sourceKey]);
  useEffect(() => { if (isTauri()) void invoke<FlightSummary[]>('list_flight_reports').then(setReports).catch(e => setError(String(e))); }, []);
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
      if (!more) setMissionId('');
      setMessage(result.missions.length ? '任务已读取，请选择本次已结束的飞行任务。' : '平台尚无可读取的历史任务。');
    });
  };
  const collect = () => {
    if (!selected || !selectedAir || !selectedDji || !ready) return;
    void run(async () => {
      setMessage('正在核对任务时间、读取采样数据和下载照片，请保持所选页面打开…');
      const data = await invoke<CollectedFlight>('collect_flight_report', { request: { djiSession: selectedDji.session, djiTabId: selectedDji.id, sniffSession: selectedAir.session, sniffTabId: selectedAir.id, mission: selected } });
      setPreview(data); setStep(2); setMessage('资料读取完成，请核对后生成 Word 快报。');
    });
  };
  const save = () => { if (!preview) return; void run(async () => {
    const charts = flightCharts(preview);
    const report = await invoke<FlightSummary>('save_flight_report', { data: preview, charts });
    setReports(items => [report, ...items]); setCreating(false); setPreview(null); setStep(0);
    setMessage('Word 快报已保存到本机，可在下方打开。');
  }); };
  return <div className="report-center">
    <div className="page-heading"><div><span className="eyebrow">本地成果</span><h2>巡飞报告</h2><p>完成飞行与资料上传后，将同一航次的监测数据和照片生成 Word 快报。</p></div>{!creating && <button className="primary-button" onClick={() => { if (!ready) onPrepare(); else { setCreating(true); setStep(0); setPreview(null); setMessage(''); setError(''); } }}>{ready ? '＋ 新建巡飞报告' : '完成准备后新建'}</button>}</div>
    {creating && <section ref={builder} className="report-builder"><div className="section-heading"><h3>新建巡飞报告</h3><button className="text-button" disabled={busy} onClick={() => setCreating(false)}>收起</button></div><ol className="setup-steps compact">{['选择飞行任务', '核对任务资料', '生成 Word 快报'].map((label, i) => <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span>{i < step ? '✓' : i + 1}</span>{label}</li>)}</ol>
      {!ready && step < 2 && <div className="notice warning">网站状态发生变化，请先恢复连接。<button className="text-button" onClick={onPrepare}>前往处理 →</button></div>}
      {step === 0 && <div className="wizard-fields">
        {!air.length ? <div className="notice"><p>尚未找到可飞历史任务页面。</p><button className="secondary-button" onClick={openAir}>打开可飞历史任务 ↗</button></div> : air.length > 1 ? <label>选择用于读取任务的可飞页面<select disabled={busy} value={selectedAir ? tabKey(selectedAir) : ''} onChange={e => setAirKey(e.target.value)}><option value="">请选择页面</option>{air.map(t => <option key={tabKey(t)} value={tabKey(t)}>{t.title} · 页面 {t.id}</option>)}</select></label> : <p className="helper-text">已连接可飞历史任务页面。</p>}
        <button className="secondary-button" disabled={!selectedAir || busy || !ready} onClick={() => load()}>{busy ? '读取中…' : '读取飞行任务'}</button>
        <label>已结束的飞行任务<select value={missionId} disabled={busy || !missions.length} onChange={e => setMissionId(e.target.value)}><option value="">{missions.length ? '请选择本次任务' : '先读取飞行任务'}</option>{missions.map(m => <option key={m.missionId} value={m.missionId} disabled={m.endTime > Date.now() - 60000 || !m.endTime}>{m.missionName} · {beijingTime(m.startTime)}</option>)}</select></label>
        {total > missions.length && <button className="text-button" disabled={busy || !ready} onClick={() => load(true)}>加载更早任务（{missions.length} / {total}）</button>}
        <button className="primary-button" disabled={!selected || busy || !ready} onClick={() => { setStep(1); setMessage(''); }}>下一步：核对资料</button>
      </div>}
      {step === 1 && <div className="wizard-fields"><p><strong>{selected?.missionName || '任务页面已变化，请返回重新选择'}</strong></p><p className="helper-text">{selected && `${beijingTime(selected.startTime)} — ${beijingTime(selected.endTime)}`}</p><div className="notice"><p>在司空媒体库进入本航次的 <strong>Immediate-Media</strong> 照片文件夹。系统会核对照片时间与飞行任务，防止混入其他航次。</p><button className="secondary-button" onClick={openMedia}>打开司空媒体库 ↗</button></div>
        <label>本次航次照片所在页面<select disabled={busy} value={selectedDji ? tabKey(selectedDji) : ''} onChange={e => setDjiKey(e.target.value)}><option value="">{dji.length ? '选择已打开的媒体页面' : '请先打开司空任务照片文件夹'}</option>{dji.map(t => <option key={tabKey(t)} value={tabKey(t)}>{t.title} · 页面 {t.id}</option>)}</select></label>
        <div className="button-row"><button className="secondary-button" disabled={busy} onClick={() => setStep(0)}>上一步</button><button className="primary-button" disabled={!selected || !selectedAir || !selectedDji || busy || !ready} onClick={collect}>{busy ? '正在读取资料…' : '读取并核对资料'}</button></div>
      </div>}
      {step === 2 && preview && <div className="wizard-fields"><div className="notice success"><strong>{preview.mission.missionName}</strong><p>{preview.photos.length} 张照片 · {preview.air.points.length} 个采样点 · 航次时间已核对</p></div>{preview.air.points.every(p => p.pm25 == null || p.pm25 === 0) && <p className="notice warning">PM2.5 有效读数全部为 0，请核查传感器。此提示也会保留在报告记录中。</p>}<details className="flight-preview"><summary>查看照片与来源</summary><p>{preview.media.folder}</p>{preview.photos.map(p => <figure key={p.name}><img src={p.dataUrl} alt={p.name} /><figcaption>{p.name}</figcaption></figure>)}</details><div className="button-row"><button className="secondary-button" disabled={busy} onClick={() => { setStep(1); setPreview(null); }}>重新选择资料</button><button className="primary-button" disabled={busy} onClick={save}>{busy ? '正在保存…' : '生成并保存 Word 快报'}</button></div></div>}
    </section>}
    {message && <p role="status" className="notice success">{message}</p>}{error && <p role="alert" className="notice warning">{error}</p>}
    <section className="history-card"><div className="section-heading"><h3>历史巡飞报告</h3><span className="muted">{reports.length} 份 · 保存在本机</span></div>{!reports.length ? <div className="empty-state"><h3>尚未生成巡飞报告</h3><p>完成准备后，点击“新建巡飞报告”开始。</p></div> : <div className="flight-history">{reports.map(r => <article key={r.id}><div><strong>{r.title}</strong><p>{beijingTime(r.createdAt)} · {r.photoCount} 张照片 · {r.pointCount} 个采样点</p>{r.warning && <span className="badge warning">{r.warning}</span>}</div><button className="secondary-button" onClick={() => void invoke('open_flight_report', { id: r.id }).catch(e => setError(String(e)))}>打开 Word</button></article>)}</div>}</section>
  </div>;
}
