import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { clientEnvironment, type BrowserJobSummary } from '../lib/diagnostics';

export function DiagnosticReportSection({ disabled, onBusyChange, tabs = [], version }: { disabled: boolean; onBusyChange: (busy: boolean) => void; tabs?: BrowserJobSummary[]; version?: string }) {
  const lock = useRef(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const report = async () => {
    if (lock.current || disabled) return;
    lock.current = true; setSending(true); onBusyChange(true); setMessage(''); setError('');
    // The window size and tab inventory travel with the request, so they are
    // logged before the packet is collected and are always part of it.
    const environment = clientEnvironment(tabs, version);
    try {
      setMessage(await invoke<string>('report_diagnostics', { environment }));
    }
    catch (e) { setError(String(e)); }
    finally { lock.current = false; setSending(false); onBusyChange(false); }
  };
  return <fieldset className="settings-section" disabled={disabled || sending}>
    <legend>异常上报</legend>
    <p className="settings-help">异常及相关运行日志先缓存在本机，不会自动发送。点击后将缓存日志合并为附件，发送到 stuzhaoxing@gmail.com；附件较大时分批发送。</p>
    <p className="settings-help">发送成功后清理对应异常缓存，失败则保留，需手动重试。运行日志仍按原有规则保留。日志保留原文，不做脱敏；使用已保存的邮件发信账号，修改账号后请先保存设置。</p>
    <p className="settings-help">每次上报同时附带最近 30 分钟的完整运行日志，以及当前窗口尺寸、屏幕和浏览器标签页清单，用于判断“白屏 / 窗口过小 / 页面被复用”这类只在用户电脑上出现的问题；不读取 Cookie、浏览器存储或网页正文。</p>
    <button type="button" className="secondary-button" onClick={() => void report()}>{sending ? '正在上报…' : '异常上报'}</button>
    {message && <p className="notice success" role="status">{message}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </fieldset>;
}
