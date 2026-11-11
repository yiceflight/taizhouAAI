import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export function DiagnosticReportSection({ disabled, onBusyChange }: { disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const lock = useRef(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const report = async () => {
    if (lock.current || disabled) return;
    lock.current = true; setSending(true); onBusyChange(true); setMessage(''); setError('');
    try { setMessage(await invoke<string>('report_diagnostics')); }
    catch (e) { setError(String(e)); }
    finally { lock.current = false; setSending(false); onBusyChange(false); }
  };
  return <fieldset className="settings-section" disabled={disabled || sending}>
    <legend>异常上报</legend>
    <p className="settings-help">异常及相关运行日志先缓存在本机，不会自动发送。点击后将缓存日志合并为附件，发送到 stuzhaoxing@gmail.com；附件较大时分批发送。</p>
    <p className="settings-help">发送成功后清理对应异常缓存，失败则保留，需手动重试。运行日志仍按原有规则保留。日志保留原文，不做脱敏；使用已保存的邮件发信账号，修改账号后请先保存设置。</p>
    <button type="button" className="secondary-button" onClick={() => void report()}>{sending ? '正在上报…' : '异常上报'}</button>
    {message && <p className="notice success" role="status">{message}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
  </fieldset>;
}
