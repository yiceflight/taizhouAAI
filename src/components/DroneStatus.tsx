import { ManualLaunchButton } from './ManualLaunchButton';
import { useEffect, useId, useRef, useState } from 'react';
import { flightDisplay, flightSummary, type FlightEvent, type MonitorView } from '../lib/workspace';

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
type TaskDialog = { kind: 'failure' | 'dismiss' | 'resolve'; event: FlightEvent };

export function DroneStatus({ data, ready, started, busy, action, onFlight, reportGenerating = false, compact = false }: Props) {
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

  const status = flightSummary(data, started && ready, event?.status === 'countdown' ? now : Date.now(), reportGenerating);
  const failed = event?.status === 'failed';
  const completed = event?.status === 'completed';
  const preview = !!event && (event.preview || event.source === 'preview');
  const checkable = event && !preview && ['ready', 'submitted', 'uncertain', 'flying', 'paused', 'flight_error'].includes(event.status);
  const resolvable = event && ['ready', 'flight_error'].includes(event.status);
  const cancelable = event && ['countdown', 'preparing'].includes(event.status);
  const active = event && !['dismissed', 'canceled', 'completed', 'restricted', 'not_flown'].includes(event.status);
  const nextStep = failed ? '请人工核验无人机电量、设备状态与平台任务，确认后再决定是否重新发起。' : '';
  const changed = !!taskDialog && (taskDialog.event.id !== event?.id || event?.status !== taskDialog.event.status);
  const openDialog = (kind: TaskDialog['kind'], trigger: HTMLButtonElement) => {
    if (!event || (kind === 'resolve' ? !resolvable : !failed)) return;
    dialogTrigger.current = kind !== 'failure' ? moreTrigger.current : trigger;
    setMoreOpen(false); setDismissError(''); setResolutionConfirmed(false); setTaskDialog({ kind, event: { ...event } });
  };
  const closeDialog = () => { if (!dismissLock.current) setTaskDialog(null); };
  const dismiss = async () => {
    if (!taskDialog || taskDialog.kind === 'failure' || changed || busy || dismissLock.current || (taskDialog.kind === 'resolve' && !preview && !resolutionConfirmed)) return;
    dismissLock.current = true; setDismissing(true); setDismissError('');
    try {
      const ok = taskDialog.kind === 'resolve'
        ? await action('resolve_flight', { eventId: taskDialog.event.id, expectedStatus: taskDialog.event.status, confirmed: true })
        : await action('dismiss_flight', { eventId: taskDialog.event.id });
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

  if (compact) return <div className={`drone-status drone-status-${status.tone} drone-status-compact`} aria-label="无人机状态">
    <div className="drone-status-copy"><strong>{status.title}</strong></div>
    <div className="drone-actions">{cancelable && <button className="drone-action drone-cancel" onClick={() => void action('cancel_flight', { eventId: event.id })}>取消任务</button>}<button className="drone-action drone-details" onClick={viewTask}>查看详情 ↓</button></div>
  </div>;

  return <div className={`drone-status drone-status-${status.tone}`} aria-label="无人机状态">
    {/* Material Design Icons mdi:drone, Apache-2.0. */}
    <svg className="drone-status-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22 11h-1l-1-2h-6.25L16 12.5h-2L10.75 9H4c-.55 0-2-.45-2-1s1.5-2.5 3.5-2.5S7.67 6.5 9 7h12a1 1 0 0 1 1 1zM10.75 6.5L14 3h2l-2.25 3.5zM18 11V9.5h1.75L19 11zM3 19a1 1 0 0 1-1-1a1 1 0 0 1 1-1a4 4 0 0 1 4 4a1 1 0 0 1-1 1a1 1 0 0 1-1-1a2 2 0 0 0-2-2m8 2a1 1 0 0 1-1 1a6 6 0 0 0-6-6a1 1 0 0 1-1-1a1 1 0 0 1 1-1a8 8 0 0 1 8 8"/></svg>
    <div className="drone-status-copy"><strong>{status.title}</strong>{(status.tone !== 'ready' || data?.flight.enabled || completed) && <small>{status.detail}</small>}{nextStep && <small className="drone-next-step">{nextStep}</small>}{failed && event.source === 'auto' && data?.flight.enabled && <small>新小时有效数据到达后，将重新判断超标与起飞条件。</small>}</div>
    <div className="drone-actions">
      {checkable && <button className="drone-action drone-finish" disabled={busy || refreshing} aria-busy={refreshing} onClick={() => void refreshStatus()}>{refreshing ? '正在刷新…' : '刷新状态'}</button>}
      {cancelable ? <button className="drone-action drone-cancel" onClick={() => void action('cancel_flight', { eventId: event.id })}>取消任务</button>
        : failed ? <><ManualLaunchButton data={data} ready={ready} started={started} busy={busy} action={action} className="drone-action drone-launch" /><button className="drone-action drone-details" aria-haspopup="dialog" onClick={e => openDialog('failure', e.currentTarget)}>查看失败详情</button></>
        : completed && !reportGenerating ? <button className="drone-action drone-launch" onClick={onFlight}>核对资料并生成报告</button>
        : active ? event.status !== 'submitting' && <button className="drone-action drone-launch" disabled={busy} onClick={openDji}>{djiLabel}</button>
        : !reportGenerating && <ManualLaunchButton data={data} ready={ready} started={started} busy={busy} action={action} className="drone-action drone-launch" />}
      {(failed || resolvable || completed && !reportGenerating) && <div ref={more} className="drone-more" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMoreOpen(false); }}>
        <button ref={moreTrigger} className="drone-action drone-details" aria-expanded={moreOpen} aria-controls={`${id}-more`} onClick={() => setMoreOpen(!moreOpen)}>更多 ⋯</button>
        <div id={`${id}-more`} className="drone-more-popover" hidden={!moreOpen}>
          {failed && <button disabled={busy} onClick={openDji}>到司空核查任务 ↗</button>}
          {completed && <ManualLaunchButton data={data} ready={ready} started={started} busy={busy} action={action} className="drone-more-launch" />}
          {resolvable && <button disabled={busy} aria-haspopup="dialog" onClick={e => openDialog('resolve', e.currentTarget)}>{preview ? '结束演练' : '核查后结束任务'}</button>}
          {failed && <button className="drone-defer" disabled={busy} aria-haspopup="dialog" onClick={e => openDialog('dismiss', e.currentTarget)}>暂不执行本次任务</button>}
        </div>
      </div>}
    </div>
    {taskDialog && <dialog ref={dialog} className="settings-dialog drone-task-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={e => { e.preventDefault(); closeDialog(); }}>
      <header className="settings-header"><div><h2 id={`${id}-title`}>{taskDialog.kind === 'resolve' ? preview ? '结束本次填写演练？' : '核查后结束本地任务？' : taskDialog.kind === 'failure' ? '起飞准备失败详情' : '暂不执行本次任务？'}</h2><p id={`${id}-description`}>{taskDialog.kind === 'resolve' ? preview ? '演练仅填写计划，不发送起飞请求。' : '请先到司空确认原计划已结束或已取消。' : '本次任务未发送起飞请求。'}</p></div></header>
      <div className="drone-task-body">
        <dl><div><dt>任务</dt><dd>{taskDialog.event.name}</dd></div><div><dt>{taskDialog.event.source === 'auto' ? '触发数据时间' : '任务创建时间'}</dt><dd>{taskDialog.event.observedAt || '暂无记录'}（北京时间）</dd></div><div><dt>{taskDialog.kind === 'resolve' ? '任务回执' : '失败原因'}</dt><dd>{taskDialog.event.error || '未获取到具体原因，请到巡查任务中核查。'}</dd></div></dl>
        {taskDialog.kind === 'resolve' ? <><p>结束后保留原任务状态、回执和天气记录，解除本地占用。此操作不会取消平台计划，也不会发起新的起飞请求。</p>{!preview && <label className="manual-launch-override"><input type="checkbox" checked={resolutionConfirmed} disabled={changed || dismissing} onChange={e => setResolutionConfirmed(e.target.checked)} />我已在司空核实：原计划已结束或已取消，不存在待执行或正在执行的任务。</label>}</> : taskDialog.kind === 'failure' ? <><p>{nextStep}</p><p className="capture-help">重新发起会创建新的手动任务，保留原失败记录；无需先处理或归档提醒。</p></> : <p>确认后将收起本次失败提醒，不会重新发起任务，也不会关闭自动巡查。{taskDialog.event.source === 'auto' ? '本轮连续超标不会因此自动重试；需要执行时可手动发起新任务。' : '后续自动巡查仍按现有设置与超标规则运行；需要执行时也可手动发起新任务。'}</p>}
        {(changed || dismissError) && <p className="notice warning" role="alert">{changed ? '任务状态已变化，请关闭后查看当前任务。' : dismissError}</p>}
      </div>
      <footer className="settings-footer"><button className="secondary-button" autoFocus disabled={dismissing} onClick={closeDialog}>{taskDialog.kind === 'failure' ? '关闭' : '继续保留提醒'}</button>{taskDialog.kind !== 'failure' && <button className="primary-button" disabled={changed || busy || dismissing || (taskDialog.kind === 'resolve' && !preview && !resolutionConfirmed)} onClick={() => void dismiss()}>{dismissing ? '正在处理…' : taskDialog.kind === 'resolve' ? preview ? '确认结束演练' : '确认已核查并结束' : '确认暂不执行'}</button>}</footer>
    </dialog>}
  </div>;
}
