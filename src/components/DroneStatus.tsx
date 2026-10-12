import { ManualLaunchButton } from './ManualLaunchButton';
import { useEffect, useId, useRef, useState } from 'react';
import { flightDisplay, flightSummary, isCurrentFlightEvent, type FlightEvent, type MonitorView } from '../lib/workspace';

type Props = {
  data: MonitorView | null;
  ready: boolean;
  started: boolean;
  busy: boolean;
  action: (command: string, args?: Record<string, unknown>) => Promise<boolean>;
  onFlight: () => void;
  onAir?: () => void;
  reportGenerating?: boolean;
  compact?: boolean;
};
type TaskDialog = { event: FlightEvent };

export function DroneStatus({ data, ready, started, busy, action, onFlight, compact = false }: Props) {
  const [now, setNow] = useState(Date.now);
  const [moreOpen, setMoreOpen] = useState(false);
  const [taskDialog, setTaskDialog] = useState<TaskDialog | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState('');
  const [resolutionConfirmed, setResolutionConfirmed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshLock = useRef(false);
  const more = useRef<HTMLDivElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const dismissLock = useRef(false);
  const id = useId();
  const event = flightDisplay(data).event;
  useEffect(() => {
    if (event?.status !== 'countdown') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [event?.id, event?.status, event?.launchAt]);
  useEffect(() => { setMoreOpen(false); }, [event?.id, event?.status]);
  useEffect(() => {
    if (!moreOpen) return;
    const outside = (e: PointerEvent) => { if (!more.current?.contains(e.target as Node)) setMoreOpen(false); };
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { setMoreOpen(false); moreTrigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [moreOpen]);
  useEffect(() => {
    if (!taskDialog) return;
    dialog.current?.showModal();
    return () => { dialogTrigger.current?.focus(); };
  }, [taskDialog]);

  const status = flightSummary(data, started && ready, event?.status === 'countdown' ? now : Date.now());
  const showStatus = event ? isCurrentFlightEvent(event) : status.tone === 'danger' || !!status.needsManualLaunch;
  const preview = !!event && (event.preview || event.source === 'preview');
  const checkable = event && !preview && ['ready', 'submitted', 'uncertain', 'flying', 'paused', 'flight_error'].includes(event.status);
  const resolvable = event && ['ready', 'flight_error'].includes(event.status);
  const cancelable = event && ['countdown', 'preparing'].includes(event.status);
  const active = event && !['dismissed', 'canceled', 'completed', 'restricted', 'not_flown'].includes(event.status);
  const changed = !!taskDialog && (taskDialog.event.id !== event?.id || event?.status !== taskDialog.event.status);
  const openDialog = () => {
    if (!event || !resolvable) return;
    dialogTrigger.current = moreTrigger.current;
    setMoreOpen(false); setDismissError(''); setResolutionConfirmed(false); setTaskDialog({ event: { ...event } });
  };
  const closeDialog = () => { if (!dismissLock.current) setTaskDialog(null); };
  const dismiss = async () => {
    if (!taskDialog || changed || busy || dismissLock.current || (!preview && !resolutionConfirmed)) return;
    dismissLock.current = true; setDismissing(true); setDismissError('');
    try {
      const ok = await action('resolve_flight', { eventId: taskDialog.event.id, expectedStatus: taskDialog.event.status, confirmed: true });
      if (ok) setTaskDialog(null);
      else setDismissError('未能处理本次提醒，请核对任务状态后重试。');
    } catch { setDismissError('未能处理本次提醒，请核对任务状态后重试。'); }
    finally { dismissLock.current = false; setDismissing(false); }
  };
  const openDji = () => { setMoreOpen(false); void action('open_prepared_flight'); };
  const viewTask = () => { setMoreOpen(false); onFlight(); };
  const refreshStatus = async () => {
    if (!event || busy || refreshLock.current) return;
    refreshLock.current = true; setRefreshing(true);
    try { await action('refresh_flight_status', { eventId: event.id }); }
    finally { refreshLock.current = false; setRefreshing(false); }
  };
  const djiLabel = event?.status === 'ready' ? event.preview ? '查看演练计划 ↗' : '到司空确认起飞 ↗' : '到司空核查任务 ↗';

  if (compact && !showStatus) return null;
  if (!showStatus && !resolvable) return <div className="drone-actions"><ManualLaunchButton data={data} ready={ready} started={started} busy={busy} action={action} className="drone-action drone-launch" /></div>;

  if (compact) return <div className={`drone-status drone-status-${status.tone} drone-status-compact`} aria-label="无人机状态">
    <div className="drone-status-copy"><strong>{status.title}</strong></div>
    <div className="drone-actions">{cancelable && <button className="drone-action drone-cancel" onClick={() => void action('cancel_flight', { eventId: event.id })}>取消任务</button>}<button className="drone-action drone-details" onClick={viewTask}>查看详情 ↓</button></div>
  </div>;

  return <div className={showStatus ? `drone-status drone-status-${status.tone}` : 'drone-actions'} aria-label={showStatus ? '无人机状态' : '任务核查操作'}>
    {showStatus && <>
    {/* Material Design Icons mdi:drone, Apache-2.0. */}
    <svg className="drone-status-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22 11h-1l-1-2h-6.25L16 12.5h-2L10.75 9H4c-.55 0-2-.45-2-1s1.5-2.5 3.5-2.5S7.67 6.5 9 7h12a1 1 0 0 1 1 1zM10.75 6.5L14 3h2l-2.25 3.5zM18 11V9.5h1.75L19 11zM3 19a1 1 0 0 1-1-1a1 1 0 0 1 1-1a4 4 0 0 1 4 4a1 1 0 0 1-1 1a1 1 0 0 1-1-1a2 2 0 0 0-2-2m8 2a1 1 0 0 1-1 1a6 6 0 0 0-6-6a1 1 0 0 1-1-1a1 1 0 0 1 1-1a8 8 0 0 1 8 8"/></svg>
    <div className="drone-status-copy"><strong>{status.title}</strong><small>{status.detail}</small></div>
    </>}
    <div className="drone-actions">
      {checkable && <button className="drone-action drone-finish" disabled={busy || refreshing} aria-busy={refreshing} onClick={() => void refreshStatus()}>{refreshing ? '正在刷新…' : '刷新状态'}</button>}
      {cancelable ? <button className="drone-action drone-cancel" onClick={() => void action('cancel_flight', { eventId: event.id })}>取消任务</button>
        : active ? event.status !== 'submitting' && <button className="drone-action drone-launch" disabled={busy} onClick={openDji}>{djiLabel}</button>
        : <ManualLaunchButton data={data} ready={ready} started={started} busy={busy} action={action} className="drone-action drone-launch" />}
      {resolvable && <div ref={more} className="drone-more" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMoreOpen(false); }}>
        <button ref={moreTrigger} className="drone-action drone-details" aria-expanded={moreOpen} aria-controls={`${id}-more`} onClick={() => setMoreOpen(!moreOpen)}>更多 ⋯</button>
        <div id={`${id}-more`} className="drone-more-popover" hidden={!moreOpen}>
          <button disabled={busy} aria-haspopup="dialog" onClick={openDialog}>{preview ? '结束演练' : '核查后结束任务'}</button>
        </div>
      </div>}
    </div>
    {taskDialog && <dialog ref={dialog} className="settings-dialog drone-task-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={e => { e.preventDefault(); closeDialog(); }}>
      <header className="settings-header"><div><h2 id={`${id}-title`}>{preview ? '结束本次填写演练？' : '核查后结束本地任务？'}</h2><p id={`${id}-description`}>{preview ? '演练仅填写计划，不发送起飞请求。' : '请先到司空确认原计划已结束或已取消。'}</p></div></header>
      <div className="drone-task-body">
        <dl><div><dt>任务</dt><dd>{taskDialog.event.name}</dd></div><div><dt>{taskDialog.event.source === 'auto' ? '触发数据时间' : '任务创建时间'}</dt><dd>{taskDialog.event.observedAt || '暂无记录'}（北京时间）</dd></div><div><dt>任务回执</dt><dd>{taskDialog.event.error || '未获取到具体原因，请到巡查任务中核查。'}</dd></div></dl>
        <p>结束后保留原任务状态、回执和天气记录，解除本地占用。此操作不会取消平台计划，也不会发起新的起飞请求。</p>{!preview && <label className="manual-launch-override"><input type="checkbox" checked={resolutionConfirmed} disabled={changed || dismissing} onChange={e => setResolutionConfirmed(e.target.checked)} />我已在司空核实：原计划已结束或已取消，不存在待执行或正在执行的任务。</label>}
        {(changed || dismissError) && <p className="notice warning" role="alert">{changed ? '任务状态已变化，请关闭后查看当前任务。' : dismissError}</p>}
      </div>
      <footer className="settings-footer"><button className="secondary-button" autoFocus disabled={dismissing} onClick={closeDialog}>继续保留提醒</button><button className="primary-button" disabled={changed || busy || dismissing || (!preview && !resolutionConfirmed)} onClick={() => void dismiss()}>{dismissing ? '正在处理…' : preview ? '确认结束演练' : '确认已核查并结束'}</button></footer>
    </dialog>}
  </div>;
}
