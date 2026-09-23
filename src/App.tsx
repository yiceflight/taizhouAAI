import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { targetSites, type TargetSite } from './config/sites';
import { useWorkspace } from './lib/useWorkspace';
import { siteLabels } from './lib/workspace';
import { PluginUpdateAlert } from './components/PluginUpdateAlert';
import { SettingsDialog } from './components/SettingsDialog';
import { SetupPanel } from './components/SetupPanel';
import { MonitoringPanel, FlightPanel } from './components/MonitoringPanel';
import { FlightReportPanel } from './components/FlightReportPanel';
import { CapturePanel } from './components/CapturePanel';
import { UpdateBanner } from './components/UpdateBanner';
import { DroneStatus } from './components/DroneStatus';
import { WeatherStatus } from './components/WeatherPanel';
import './App.css';

type Page = 'monitoring' | 'flight' | 'reports' | 'setup';
const pages: { id: Page; label: string }[] = [
  { id: 'monitoring', label: '监测总览' }, { id: 'flight', label: '巡查任务' },
  { id: 'reports', label: '报告与成果' }, { id: 'setup', label: '工作环境' },
];
export default function App() {
  const { bridge, readiness, monitor, error, acting, action, refresh } = useWorkspace();
  const [page, setPage] = useState<Page>('monitoring');
  const [siteMessage, setSiteMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const content = useRef<HTMLElement>(null);
  const started = !!readiness?.started;
  const ready = !!readiness?.ready;
  const preparing = page === 'setup' || (!started && page !== 'reports');
  const wasStarted = useRef(started);
  useEffect(() => {
    if (started && !wasStarted.current) setPage(current => current === 'setup' ? 'monitoring' : current);
    wasStarted.current = started;
  }, [started]);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [page, preparing, started]);
  useEffect(() => {
    if (!settingsSaved) return;
    const timer = window.setTimeout(() => setSettingsSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [settingsSaved]);
  const tabs = bridge?.connected && !bridge.error ? bridge.tabs : [];
  const event = monitor?.flight.event;
  const taskNeedsAttention = event && ['ready', 'failed', 'uncertain', 'countdown'].includes(event.status);
  const openSite = async (site: TargetSite) => {
    setSiteMessage('');
    try { if (isTauri()) await invoke('open_business_site', { url: site.url }); else window.open(site.url, '_blank', 'noopener,noreferrer'); }
    catch { setSiteMessage(`无法打开${site.name}，请在 Chrome 中访问 ${site.url}`); }
  };
  const toSetup = () => setPage('setup');
  const openMedia = () => void openSite({ ...targetSites[1], url: targetSites[1].url.replace('#/plan', '#/media') });
  const start = async () => { if (started || await action('start_workspace')) setPage('monitoring'); };
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const available = started ? pages : pages.filter(p => ['reports', 'setup'].includes(p.id));
    const current = available.findIndex(p => p.id === (preparing ? 'setup' : page));
    const next = e.key === 'Home' ? available[0] : e.key === 'End' ? available[available.length - 1] : available[(current + (e.key === 'ArrowRight' ? 1 : available.length - 1)) % available.length];
    setPage(next.id); nav.current?.querySelector<HTMLButtonElement>(`[data-page="${next.id}"]`)?.focus();
  };
  const operationProps = { data: monitor, busy: acting, ready, started, action, onPrepare: toSetup };
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><img className="brand-logo" src="/brand/monitoring-logo.png" alt="" width="36" height="36" /><h1>泰州市监测中心智能监测系统</h1></div><div className="topbar-status"><WeatherStatus weather={monitor?.weather} busy={acting} onRefresh={() => void action('refresh_weather')} /><DroneStatus data={monitor} ready={ready} started={started} busy={acting} action={action} onFlight={() => setPage(started ? 'flight' : 'setup')} /></div></header>
    <PluginUpdateAlert state={readiness} onSetup={() => setPage('setup')} />
    {(started || page === 'reports') && <nav ref={nav} className="workspace-nav" aria-label="工作台"><div className="tabs" role="tablist">{pages.map(p => <button key={p.id} id={`tab-${p.id}`} data-page={p.id} role="tab" disabled={!started && !['reports', 'setup'].includes(p.id)} aria-selected={p.id === (preparing ? 'setup' : page)} aria-controls={`panel-${p.id}`} tabIndex={p.id === (preparing ? 'setup' : page) ? 0 : -1} onKeyDown={keys} onClick={() => setPage(p.id)}>{p.label}{p.id === 'flight' && taskNeedsAttention && <span className="nav-alert">1</span>}{p.id === 'setup' && !ready && <span className="nav-alert">!</span>}</button>)}</div><button className="settings-trigger" disabled={!monitor || acting} aria-haspopup="dialog" onClick={() => { setSettingsSaved(false); setSettingsOpen(true); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6" /></svg>设置</button></nav>}
    {settingsOpen && monitor && <SettingsDialog settings={monitor.settings} onClose={() => setSettingsOpen(false)} onSaved={async () => { await refresh(); setSettingsSaved(true); }} />}
    {settingsSaved && <div className="save-message" role="status" aria-live="polite" aria-atomic="true"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" /><path d="m6 10 2.5 2.5L14 7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>设置已保存</div>}
    <main ref={content} className="workspace-content">
      {(error || siteMessage) && <div className="notice warning" role="alert">{error || siteMessage}</div>}
      <section id="panel-setup" aria-labelledby={started ? 'tab-setup' : undefined} hidden={!preparing}><SetupPanel state={readiness} busy={acting} onCheck={() => void action('check_readiness')} onStart={() => void start()} openSite={site => void openSite(site)} onHistory={() => setPage('reports')} /></section>
      {started && <><section id="panel-monitoring" role="tabpanel" aria-labelledby="tab-monitoring" hidden={preparing || page !== 'monitoring'}><MonitoringPanel {...operationProps} onFlight={() => setPage('flight')} /></section><section id="panel-flight" role="tabpanel" aria-labelledby="tab-flight" hidden={preparing || page !== 'flight'}><FlightPanel {...operationProps} /></section></>}
      <section id="panel-reports" role="tabpanel" aria-labelledby="tab-reports" hidden={preparing || page !== 'reports'}><FlightReportPanel tabs={tabs} ready={ready && started} onPrepare={toSetup} openMedia={openMedia} openAir={() => void openSite(targetSites[2])} /><CapturePanel tabs={tabs} ready={ready && started} /><button className="text-button directory-link" onClick={() => void invoke('open_reports_directory').catch(() => setSiteMessage('无法打开本地报告目录。'))}>打开本地报告文件夹 ↗</button></section>
    </main>
    <footer className="status-bar">
      {started && <div className="connection-strip" aria-label="工作环境摘要"><button onClick={toSetup}><span className={`status-dot${readiness?.pluginReady ? ' connected' : ''}`} />插件{readiness?.pluginReady ? '已连接' : '异常'}</button>{targetSites.map(site => { const health = readiness?.sites.find(s => s.id === site.id); return <button key={site.id} onClick={toSetup}><span className={`status-dot${health?.state === 'ready' ? ' connected' : ''}`} />{site.name} · {health ? siteLabels[health.state] : '待检测'}</button>; })}</div>}
      <span className="local-status">数据与报告保存在本机</span><span className="footer-plugin">{readiness?.pluginReady ? `插件 v${bridge?.versions.join('、')}` : '工作环境待就绪'}</span><UpdateBanner />
    </footer>
  </div>;
}
