import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { targetSites, type TargetSite } from './config/sites';
import { useWorkspace } from './lib/useWorkspace';
import { PluginUpdateAlert } from './components/PluginUpdateAlert';
import { SettingsDialog } from './components/SettingsDialog';
import { SetupPanel } from './components/SetupPanel';
import { MonitoringPanel } from './components/MonitoringPanel';
import { FlightReportPanel } from './components/FlightReportPanel';
import { CapturePanel } from './components/CapturePanel';
import { UpdateBanner } from './components/UpdateBanner';
import { PluginVersionStatus } from './components/PluginVersionStatus';
import { DroneStatus } from './components/DroneStatus';
import { WeatherStatus } from './components/WeatherPanel';
import { RuntimeLogs } from './components/RuntimeLogs';
import './App.css';

type Page = 'monitoring' | 'flight' | 'setup' | 'logs';
const pages: { id: Page; label: string }[] = [
  { id: 'monitoring', label: '监测总览' }, { id: 'flight', label: '巡查任务' },
  { id: 'setup', label: '运行状态' }, { id: 'logs', label: '运行日志' },
];
export default function App() {
  const { bridge, readiness, monitor, error, acting, action, refresh, resetStartup } = useWorkspace();
  const [page, setPage] = useState<Page>('monitoring');
  const [siteMessage, setSiteMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [dataResetKey, setDataResetKey] = useState(0);
  const [reportGenerating, setReportGenerating] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const content = useRef<HTMLElement>(null);
  const started = !!readiness?.started;
  const ready = !!readiness?.ready;
  const monitoringReady = readiness?.monitoringReady ?? ready;
  const flightReady = readiness?.flightReady ?? ready;
  const reportReady = readiness?.reportReady ?? ready;
  const statusNeedsAttention = readiness ? !ready : !!error;
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [page]);
  useEffect(() => {
    if (!settingsSaved) return;
    const timer = window.setTimeout(() => setSettingsSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [settingsSaved]);
  const tabs = bridge?.connected && !bridge.error ? bridge.tabs : [];
  const event = monitor?.flight.event;
  const taskNeedsAttention = event && ['ready', 'failed', 'uncertain', 'countdown', 'paused', 'flight_error'].includes(event.status);
  const openUrl = async (url: string, name = '业务平台') => {
    setSiteMessage('');
    try { if (isTauri()) await invoke('open_business_site', { url }); else window.open(url, '_blank', 'noopener,noreferrer'); }
    catch { setSiteMessage(`无法打开${name}，请在 Chrome 中访问 ${url}`); }
  };
  const openSite = async (site: TargetSite) => openUrl(site.url, site.name);
  const toSetup = () => setPage('setup');
  const openSettings = () => { setSettingsSaved(false); setSettingsOpen(true); };
  const handleDataCleared = async () => {
    resetStartup();
    await refresh();
    setDataResetKey(value => value + 1);
  };
  const openMedia = () => void openSite({ ...targetSites[1], url: targetSites[1].url.replace('#/plan', '#/media') });
  const openRealtime = () => {
    if (isTauri()) void invoke<{ selected?: boolean }>('open_airins_realtime').then(result => {
      if (!result?.selected) setSiteMessage('可飞实时页面已打开，但未自动定位到 PM2.5，请在实时数据列表中选择 PM2.5。');
    }).catch(() => openUrl('https://aai.airins.cn/sniff/Realtime', '可飞实时数据'));
    else void openUrl('https://aai.airins.cn/sniff/Realtime', '可飞实时数据');
  };
  const start = async () => { if (started || await action('start_workspace')) setPage('monitoring'); };
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const available = pages;
    const current = available.findIndex(p => p.id === page);
    const next = e.key === 'Home' ? available[0] : e.key === 'End' ? available[available.length - 1] : available[(current + (e.key === 'ArrowRight' ? 1 : available.length - 1)) % available.length];
    setPage(next.id); nav.current?.querySelector<HTMLButtonElement>(`[data-page="${next.id}"]`)?.focus();
  };
  const operationProps = { data: monitor, busy: acting, ready: monitoringReady, flightReady, started, action, onPrepare: toSetup, onSettings: openSettings };
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><img className="brand-logo" src="/brand/monitoring-logo.png" alt="" width="36" height="36" /><h1>江苏省泰州环境监测中心智能监测系统</h1></div><div className="topbar-status" role="group" aria-label="机场天气与无人机巡飞"><WeatherStatus weather={monitor?.weather} busy={acting} onRefresh={() => void action('refresh_weather')} /><DroneStatus compact data={monitor} ready={flightReady} started={started} busy={acting} action={action} onFlight={() => { setPage('monitoring'); requestAnimationFrame(() => document.getElementById('monitoring-task-details')?.scrollIntoView({ behavior: 'smooth', block: 'center' })); }} onAir={openRealtime} reportGenerating={reportGenerating} /></div></header>
    <PluginUpdateAlert state={readiness} onSetup={() => setPage('setup')} />
    <nav ref={nav} className="workspace-nav" aria-label="工作台"><div className="tabs" role="tablist">{pages.map(p => <button key={p.id} id={`tab-${p.id}`} data-page={p.id} role="tab" aria-selected={p.id === page} aria-controls={`panel-${p.id}`} tabIndex={p.id === page ? 0 : -1} onKeyDown={keys} onClick={() => setPage(p.id)}>{p.label}{p.id === 'flight' && taskNeedsAttention && <span className="nav-alert">1</span>}{p.id === 'setup' && statusNeedsAttention && <span className="nav-alert nav-status-alert" role="status" aria-label="运行状态异常，请检查浏览器连接和网站验证" title="浏览器连接或网站验证未就绪，点击查看">!</span>}</button>)}</div><button className="settings-trigger" disabled={!monitor || acting} aria-haspopup="dialog" onClick={openSettings}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6" /></svg>设置</button></nav>
    {settingsOpen && monitor && <SettingsDialog settings={monitor.settings} flightReady={flightReady && started} routes={monitor.flight.routes} selectedRoute={monitor.flight.selectedRoute} routesSyncedAt={monitor.flight.routesSyncedAt} onClose={() => setSettingsOpen(false)} onDataCleared={handleDataCleared} onRoutesChanged={refresh} onSaved={async () => { await refresh(); setSettingsSaved(true); }} />}
    {settingsSaved && <div className="save-message" role="status" aria-live="polite" aria-atomic="true"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" /><path d="m6 10 2.5 2.5L14 7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>设置已保存</div>}
    <main ref={content} className="workspace-content">
      {(error || siteMessage) && <div className="notice warning" role="alert">{error || siteMessage}{error && monitoringReady && !started && <button className="text-button startup-retry" disabled={acting || readiness?.checking} onClick={() => void start()}>重新读取数据</button>}</div>}
      <section id="panel-setup" role="tabpanel" aria-labelledby="tab-setup" hidden={page !== 'setup'}><SetupPanel active={page === 'setup'} state={readiness} busy={acting} onCheck={() => void action('check_readiness')} openSite={site => void openSite(site)} /></section>
      <section id="panel-monitoring" role="tabpanel" aria-labelledby="tab-monitoring" hidden={page !== 'monitoring'}><MonitoringPanel {...operationProps} onFlight={() => setPage('flight')} onAir={openRealtime} reportGenerating={reportGenerating} /></section>
      <section id="panel-flight" role="tabpanel" aria-labelledby="tab-flight" hidden={page !== 'flight'}><FlightReportPanel dataResetKey={dataResetKey} routeName={monitor?.flight.selectedRoute} mediaReady={!!readiness?.pluginReady && readiness.sites.some(site => site.id === 'dji' && site.state === 'ready')} active={page === 'flight'} tabs={tabs} ready={reportReady} flightEvent={monitor?.flight.event} flightRecords={monitor?.flight.records} tasksClearedAt={monitor?.flight.tasksClearedAt} onPrepare={toSetup} openMedia={openMedia} openAir={() => void openSite(targetSites[2])} openLink={url => void openUrl(url, '平台任务')} onReportGeneratingChange={setReportGenerating} /><CapturePanel tabs={tabs} ready={ready && started} /><button className="text-button directory-link" onClick={() => void invoke('open_reports_directory').catch(() => setSiteMessage('无法打开本地报告目录。'))}>打开本地报告文件夹 ↗</button></section>
      <section id="panel-logs" role="tabpanel" aria-labelledby="tab-logs" hidden={page !== 'logs'}><RuntimeLogs active={page === 'logs'} /></section>
    </main>
    <footer className="status-bar">
      <UpdateBanner /><PluginVersionStatus bridge={bridge} readiness={readiness} />
    </footer>
  </div>;
}
