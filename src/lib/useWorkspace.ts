import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { BridgeStatus, MonitorView, Readiness } from './workspace';
export function useWorkspace() {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [monitor, setMonitor] = useState<MonitorView | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [acting, setActing] = useState(false);
  const lock = useRef(false);
  const pendingActions = useRef(0);
  const autoStartAttempted = useRef(false);
  const [startupReset, setStartupReset] = useState(0);
  const refresh = useCallback(async () => {
    if (!isTauri()) { setPollError('请使用桌面客户端完成插件配置和监测。'); return; }
    try {
      const [b, r, m] = await Promise.all([invoke<BridgeStatus>('get_bridge_status'), invoke<Readiness>('get_readiness'), invoke<MonitorView>('get_monitoring')]);
      setBridge(b); setReadiness(r); setMonitor(m); setPollError('');
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
  const action = useCallback(async (command: string, args?: Record<string, unknown>) => {
    const priority = command === 'cancel_flight';
    if (lock.current && !priority) return false;
    if (!priority) lock.current = true;
    pendingActions.current += 1; setActing(true); setError('');
    try { await invoke(command, args); await refresh(); return true; }
    catch (e) { setError(String(e)); await refresh(); return false; }
    finally { if (!priority) lock.current = false; pendingActions.current -= 1; setActing(pendingActions.current > 0); }
  }, [refresh]);
  useEffect(() => {
    if (!(readiness?.monitoringReady ?? readiness?.ready) || readiness.started || readiness.checking || acting || lock.current || autoStartAttempted.current) return;
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
  return { bridge, readiness, monitor, error: pollError || error, acting, action, refresh, resetStartup };
}
