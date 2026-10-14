import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

export type BridgeDiagnosticReport = {
  checkedAt: string; appVersion: string; platform: string; channel: string;
  address: string; extensionId: string; minimumExtensionVersion: string;
  checks: { id: string; label: string; state: 'pass' | 'fail' | 'warning' | 'skipped'; detail: string; suggestion: string }[];
};
const labels = { pass: '通过', fail: '失败', warning: '待确认', skipped: '未检测' };
export function diagnosticText(report: BridgeDiagnosticReport) {
  return [
    '本机连接诊断', `检测时间：${new Date(report.checkedAt).toLocaleString()}`,
    `客户端：${report.appVersion} / ${report.platform} / ${report.channel}`,
    `地址：${report.address}`, `插件 ID：${report.extensionId}`, `最低插件版本：${report.minimumExtensionVersion}`,
    ...report.checks.map(check => `[${labels[check.state]}] ${check.label}：${check.detail}${check.suggestion ? `\n建议：${check.suggestion}` : ''}`),
  ].join('\n');
}
export function DiagnosticResults({ report }: { report: BridgeDiagnosticReport }) {
  return <>
    <p className="diagnostic-time">最近检测：{new Date(report.checkedAt).toLocaleString()} · 本页每 5 秒自动刷新</p>
    <ul className="diagnostic-checks">{report.checks.map(check => <li key={check.id}>
      <div className="diagnostic-check-heading"><strong>{check.label}</strong><span className={`badge ${check.state === 'pass' ? 'success' : check.state === 'skipped' ? '' : 'warning'}`}>{labels[check.state]}</span></div>
      <p>{check.detail}</p>{check.suggestion && <small>{check.suggestion}</small>}
    </li>)}</ul>
    <details className="diagnostic-details"><summary>连接信息</summary><dl>
      <dt>客户端</dt><dd>{report.appVersion} · {report.platform} · {report.channel}</dd>
      <dt>本机地址</dt><dd><code>{report.address}</code></dd>
      <dt>应加载的插件 ID</dt><dd><code>{report.extensionId}</code></dd>
      <dt>最低插件版本</dt><dd>{report.minimumExtensionVersion}</dd>
    </dl></details>
  </>;
}
export function BridgeDiagnostics({ active = true }: { active?: boolean }) {
  const [report, setReport] = useState<BridgeDiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const run = useCallback(async (background = false) => {
    if (lock.current) return;
    if (!isTauri()) { setMessage('请在桌面客户端内运行本机连接诊断。'); return; }
    lock.current = true; setBusy(true);
    if (!background) { setMessage(''); setReport(null); }
    try { setReport(await invoke<BridgeDiagnosticReport>('diagnose_bridge')); setMessage(''); }
    catch (error) { setReport(null); setMessage(`诊断未完成：${String(error)}。请重试，并将此提示提供给技术支持。`); }
    finally { lock.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void run();
    const timer = setInterval(() => void run(true), 5000);
    return () => clearInterval(timer);
  }, [active, run]);
  const copy = async () => {
    if (!report) return;
    try { await navigator.clipboard.writeText(diagnosticText(report)); setMessage('诊断结果已复制，可发给技术支持。'); }
    catch { setMessage('复制失败，请截图保存诊断结果。'); }
  };
  return <section className="setup-card bridge-diagnostics" aria-labelledby="bridge-diagnostics-title" aria-busy={busy}>
    <div className="section-heading"><div><h3 id="bridge-diagnostics-title">本机连接诊断</h3><p>检查插件文件、本机端口、客户端服务和插件心跳。</p></div><div className="button-row">
      <button className="secondary-button" disabled={busy} onClick={() => void run()}>{busy ? '正在诊断…' : '重新诊断'}</button>
      <button className="secondary-button" disabled={!report || busy} onClick={() => void copy()}>复制诊断结果</button>
    </div></div>
    {busy && !report && <p role="status">正在检查本机连接，请稍候…</p>}
    {report && <DiagnosticResults report={report} />}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
