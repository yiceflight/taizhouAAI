import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { applyPluginRequirement } from './pluginCompatibility';
import type { BridgeStatus, MonitorView, Readiness } from './workspace';
export function useWorkspace() {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [monitor, setMonitor] = useState<MonitorView | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const failedAction = useRef<{ command: string; eventId?: unknown; at: number } | null>(null);
  const [acting, setActing] = useState(false);
  const lock = useRef(false);
  const pendingActions = useRef(0);
  const autoStartAttempted = useRef(false);
  const missingWeatherRequested = useRef(false);
  const [startupReset, setStartupReset] = useState(0);
  const refresh = useCallback(async () => {
    if (!isTauri()) { setPollError('请使用桌面客户端完成插件配置和监测。'); return; }
    try {
      const [b, r, m] = await Promise.all([invoke<BridgeStatus>('get_bridge_status'), invoke<Readiness>('get_readiness'), invoke<MonitorView>('get_monitoring')]);
      setBridge(b); setReadiness(applyPluginRequirement(r, b)); setMonitor(m); setPollError('');
      const failure = failedAction.current;
      if (failure?.command === 'refresh_flight_status') {
        const event = [m?.flight.event, ...(m?.flight.records ?? [])].find(event => event?.id === failure.eventId);
        // Reading local state is not itself recovery. Require a newer successful
        // platform observation for this exact task (including archived tasks).
        if (event && !event.statusCheckError && (event.statusCheckedAt ?? 0) > failure.at) {
          failedAction.current = null; setError('');
        }
      }
    } catch { setReadiness(null); setBridge(null); setMonitor(null); setPollError('无法读取客户端状态，请重新检测；如持续失败，请重启客户端。'); }
  }, []);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onFocus = () => { void refresh(); };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    const weather = monitor?.weather;
    if (!readiness?.pluginReady || weather?.current) {
      missingWeatherRequested.current = false;
      return;
    }
    if (!monitor || weather?.refreshing || missingWeatherRequested.current) return;
    // Recover immediately from a weather read made before the plugin connected.
    // Leave subsequent retries to the native timer, without locking other actions.
    missingWeatherRequested.current = true;
    void invoke('refresh_weather').catch(() => {}).then(refresh);
  }, [readiness?.pluginReady, monitor, refresh]);
  const action = useCallback(async (command: string, args?: Record<string, unknown>) => {
    const priority = command === 'cancel_flight';
    if (lock.current && !priority) return false;
    if (!priority) lock.current = true;
    pendingActions.current += 1; setActing(true); setError(''); failedAction.current = null;
    try { await invoke(command, args); await refresh(); return true; }
    catch (e) { failedAction.current = { command, eventId: args?.eventId, at: Date.now() }; setError(String(e)); await refresh(); return false; }
    finally { if (!priority) lock.current = false; pendingActions.current -= 1; setActing(pendingActions.current > 0); }
  }, [refresh]);
  useEffect(() => {
    if (!readiness?.ready || readiness.started || readiness.checking || acting || lock.current || autoStartAttempted.current) return;
    // One automatic attempt per launch. A failed first sync stays visible and
    // can be retried explicitly, rather than looping on every status poll.
    autoStartAttempted.current = true;
    void action('start_workspace');
  }, [readiness, acting, action, startupReset]);
  const resetStartup = useCallback(() => {
    // Clearing local data resets the native workspace. Allow the same client
    // session to perform its initial monitoring sync again after that reset.
    autoStartAttempted.current = false;
    setStartupReset(value => value + 1);
  }, []);
  const dismissError = useCallback(() => { failedAction.current = null; setError(''); }, []);
  return { dismissError, canDismissError: !!error && !pollError, bridge, readiness, monitor, error: pollError || error, acting, action, refresh, resetStartup };
}
