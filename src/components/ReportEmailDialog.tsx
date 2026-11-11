import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { mergeRecipients, type EmailSettings } from '../lib/email';

export function ReportEmailDialog({ reportId, onClose, onSent, onSettings }: { reportId: string; onClose: () => void; onSent: (to: string) => void; onSettings?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [removed, setRemoved] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const recipientInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { opener?.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setSettings(null);
    void invoke<EmailSettings>('get_email_settings').then(value => { if (active) { setSettings(value); setRecipients(value.recipients); setDraft(''); setRemoved(null); } })
      .catch(e => { if (active) setError(String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const addRecipients = (raw: string) => {
    try {
      setRecipients(current => mergeRecipients(current, raw)); setDraft(''); setRemoved(null); setError('');
    } catch (e) { setError(String(e).replace(/^Error: /, '')); recipientInput.current?.focus(); }
  };
  const removeRecipient = (address: string) => {
    setRemoved(recipients); setRecipients(current => current.filter(value => value !== address)); setError('');
  };
  const ready = !!settings?.configured && recipients.length > 0;
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="report-email-title" onCancel={event => { event.preventDefault(); if (!sending.current) onClose(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (sending.current || !ready || !settings) return;
      let nextRecipients: string[];
      try { nextRecipients = mergeRecipients(recipients, draft); }
      catch (e) { setError(String(e).replace(/^Error: /, '')); recipientInput.current?.focus(); return; }
      sending.current = true; setBusy(true); setError('');
      try {
        const to = await invoke<string>('send_flight_report_email', { reportId, recipients: nextRecipients, expectedRecipients: settings.recipients, expectedUsername: settings.username });
        onSent(to);
      } catch (e) { setError(String(e)); }
      finally { sending.current = false; setBusy(false); }
    }}>
      <div className="settings-header"><div><h3 id="report-email-title">发送 Word 报告</h3><p>将此任务已保存的 Word 报告作为附件发送。</p></div><button type="button" className="text-button" disabled={busy} onClick={onClose}>关闭</button></div>
      <div className="settings-body settings-fields" aria-busy={busy || loading}>
        {loading ? <p role="status">正在读取邮件设置…</p> : settings && <>
          <div className="email-recipient-field">
            <label htmlFor="report-recipient">本次收件人</label>
            <div className="email-recipient-input">
              {recipients.map(recipient => <span className="email-recipient-tag" key={recipient}>
                <span>{recipient}</span>
                <button type="button" aria-label={`移除 ${recipient}`} disabled={busy} onClick={() => removeRecipient(recipient)}>×</button>
              </span>)}
              <input ref={recipientInput} id="report-recipient" type="text" inputMode="email" autoComplete="off" spellCheck={false}
                aria-describedby="report-recipient-help" placeholder={recipients.length ? '继续添加邮箱' : '输入邮箱后按回车添加'} value={draft} disabled={busy}
                onInput={event => setDraft(event.currentTarget.value)}
                onBlur={() => { if (draft.trim()) addRecipients(draft); }}
                onPaste={event => {
                  const value = event.clipboardData.getData('text');
                  if (/[;,，；\n]/.test(value)) { event.preventDefault(); addRecipients(value); }
                }}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (['Enter', ',', ';', '，', '；'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); addRecipients(draft); }
                  if (event.key === 'Backspace' && !draft && recipients.length) { event.preventDefault(); removeRecipient(recipients[recipients.length - 1]); }
                }} />
            </div>
            <p className="settings-help" id="report-recipient-help">可临时删除或添加邮箱，仅对本次发送生效，不会修改邮件设置。</p>
            {removed && <p className="settings-help" role="status">已移除邮箱。<button type="button" className="text-button" disabled={busy} onClick={() => { setRecipients(current => mergeRecipients(current, removed.join(';'))); setRemoved(null); }}>撤销</button></p>}
          </div>
          <p>发信地址：{settings.username}</p>
          {!ready && <p className="notice warning">{!recipients.length ? '请至少保留一个本次发送的收件邮箱。' : '请先在设置 → 邮件发送中配置发信密码。'}</p>}
          <p className="muted">正文包含本次巡飞时间和基本情况。提交成功后，可在阿里云发送详情中查看最终投递状态。</p>
        </>}
        {error && <p className="notice warning" role="alert">{error}</p>}
        {!loading && !settings && <button type="button" className="secondary-button" onClick={() => setRevision(value => value + 1)}>重新读取邮件设置</button>}
      </div>
      <div className="settings-footer">{onSettings && <button type="button" className="text-button" disabled={busy} onClick={onSettings}>修改邮件设置</button>}<button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || loading || !ready}>{busy ? '正在发送…' : '发送报告'}</button></div>
    </form>
  </dialog>;
}
