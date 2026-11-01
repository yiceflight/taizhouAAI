import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { tabKey, type BrowserTab, type ReportSummary } from '../lib/workspace';
export function CapturePanel({ tabs, ready }: { tabs: BrowserTab[]; ready: boolean }) {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const lock = useRef(false);
  const selected = tabs.find(t => tabKey(t) === key);
  useEffect(() => {
    let current = true;
    if (isTauri()) void invoke<ReportSummary[]>('list_reports')
      .then(items => { if (current) setReports(items); })
      .catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, []);
  const generate = async () => {
    if (!selected || !ready || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('正在采集当前页面…');
    try { const report = await invoke<ReportSummary>('generate_report', { session: selected.session, tabId: selected.id }); setReports(items => [report, ...items]); setMessage('网页采集记录已保存，可点击查看。'); }
    catch (e) { setError(String(e)); setMessage(''); }
    finally { lock.current = false; setBusy(false); }
  };
  return <details className="advanced-panel capture-panel"><summary>网页采集与历史记录（{reports.length}）</summary><p>保存业务页面的正文和表格，用于资料留存。</p><div className="capture-toolbar"><label htmlFor="capture-page">采集页面</label><select id="capture-page" disabled={!ready || busy} value={selected ? key : ''} onChange={e => setKey(e.target.value)}><option value="">{ready ? '选择已打开的业务页面' : '完成工作准备后可采集'}</option>{tabs.map(t => <option key={tabKey(t)} value={tabKey(t)}>{t.title} · 页面 {t.id}</option>)}</select><button className="secondary-button" disabled={!ready || !selected || selected.status !== 'complete' || busy} onClick={() => void generate()}>{busy ? '采集中…' : '保存网页记录'}</button></div>{message && <p role="status">{message}</p>}{error && <p className="notice warning" role="alert">{error}</p>}<div className="report-table-wrap"><table className="report-table"><thead><tr><th>记录名称</th><th>来源</th><th>保存时间</th><th>操作</th></tr></thead><tbody>{reports.length ? reports.map(r => <tr className="report-row" key={r.id}><td>{r.title}{r.truncated && <span className="badge warning">内容有截断</span>}</td><td>{r.source}</td><td>{new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td><td><button className="text-button" onClick={() => void invoke('open_report', { id: r.id }).catch(e => setError(String(e)))}>查看</button></td></tr>) : <tr><td colSpan={4}><div className="empty-state">暂无网页采集记录</div></td></tr>}</tbody></table></div></details>;
}
