import { weatherPasses } from '../lib/weather';
import { useEffect, useState } from 'react';
import { flightSummary, type MonitorView } from '../lib/workspace';

type Props = {
  data: MonitorView | null;
  ready: boolean;
  started: boolean;
  busy: boolean;
  action: (command: string, args?: Record<string, unknown>) => Promise<boolean>;
  onFlight: () => void;
};

export function DroneStatus({ data, ready, started, busy, action, onFlight }: Props) {
  const [now, setNow] = useState(Date.now);
  const event = data?.flight.event;
  useEffect(() => {
    if (event?.status !== 'countdown') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [event?.id, event?.status, event?.launchAt]);
  const status = flightSummary(data, started && ready, event?.status === 'countdown' ? now : Date.now());
  const cancelable = event && ['countdown', 'preparing'].includes(event.status);
  const active = event && !['dismissed', 'canceled'].includes(event.status);
  return <div className={`drone-status drone-status-${status.tone}`} aria-label="无人机状态">
    <svg className="drone-status-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><ellipse cx="8" cy="8" rx="6" ry="3"/><ellipse cx="24" cy="8" rx="6" ry="3"/><ellipse cx="8" cy="24" rx="6" ry="3"/><ellipse cx="24" cy="24" rx="6" ry="3"/><path d="m8 8 16 16M24 8 8 24"/><rect x="11" y="12" width="10" height="8" rx="3" fill="currentColor"/></svg>
    <button className="drone-status-copy" onClick={onFlight} title="查看巡飞任务与设置"><strong>{status.title}</strong><small>{status.detail}</small></button>
    <label className="drone-auto-toggle"><input type="checkbox" checked={data?.flight.enabled ?? false} disabled={!data || busy || (!data.flight.enabled && (!ready || !started))} onChange={e => void action('set_flight_enabled', { enabled: e.target.checked })}/><span>自动巡飞</span></label>
    {cancelable ? <button className="drone-action drone-cancel" onClick={() => void action('cancel_flight', { eventId: event.id })}>取消任务</button>
      : active ? <button className="drone-action drone-finish" onClick={onFlight}>查看任务</button>
      : <button className="drone-action drone-launch" disabled={!data || !started || !ready || busy || !weatherPasses(data.weather)} onClick={() => void action('launch_flight')}>{status.needsManualLaunch ? '执行任务' : '手动起飞'}</button>}
  </div>;
}
