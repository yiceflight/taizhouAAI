import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { EmailSettings } from '../lib/email';

export function ReportEmailDialog({ reportId, onClose, onSent, onSettings }: { reportId: string; onClose: () => void; onSent: (to: string) => void; onSettings?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { opener?.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setSettings(null);
    void invoke<EmailSettings>('get_email_settings').then(value => { if (active) setSettings(value); })
      .catch(e => { if (active) setError(String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const ready = !!settings?.recipients.length && settings.configured;
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="report-email-title" onCancel={event => { event.preventDefault(); if (!sending.current) onClose(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (sending.current || !ready || !settings) return;
      sending.current = true; setBusy(true); setError('');
      try {
        const to = await invoke<string>('send_flight_report_email', { reportId, expectedRecipients: settings.recipients, expectedUsername: settings.username });
        onSent(to);
      } catch (e) { setError(String(e)); }
      finally { sending.current = false; setBusy(false); }
    }}>
      <div className="settings-header"><div><h3 id="report-email-title">发送 Word 报告</h3><p>将此任务已保存的 Word 报告作为附件发送。</p></div><button type="button" className="text-button" disabled={busy} onClick={onClose}>关闭</button></div>
      <div className="settings-body settings-fields" aria-busy={busy || loading}>
        {loading ? <p role="status">正在读取邮件设置…</p> : settings && <>
          <p>收件人：<strong>{settings.recipients.join('、') || '尚未设置'}</strong></p>
          <p>发信地址：{settings.username}</p>
          {!ready && <p className="notice warning">{!settings.recipients.length ? '请先在设置 → 邮件发送中填写接收邮箱。' : '请先在设置 → 邮件发送中配置发信密码。'}</p>}
          <p className="muted">正文包含本次巡飞时间和基本情况。提交成功后，可在阿里云发送详情中查看最终投递状态。</p>
        </>}
        {error && <p className="notice warning" role="alert">{error}</p>}
        {!loading && !settings && <button type="button" className="secondary-button" onClick={() => setRevision(value => value + 1)}>重新读取邮件设置</button>}
      </div>
      <div className="settings-footer">{onSettings && <button type="button" className="text-button" disabled={busy} onClick={onSettings}>修改邮件设置</button>}<button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || loading || !ready}>{busy ? '正在发送…' : '发送报告'}</button></div>
    </form>
  </dialog>;
}
