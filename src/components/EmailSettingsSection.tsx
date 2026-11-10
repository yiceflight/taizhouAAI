import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { mergeRecipients, type EmailSettings } from '../lib/email';

export type EmailSettingsHandle = { saveIfDirty: () => Promise<boolean> };
export const EmailSettingsSection = forwardRef<EmailSettingsHandle, { disabled?: boolean; onBusyChange: (busy: boolean) => void }>(function EmailSettingsSection({ disabled = false, onBusyChange }, ref) {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [removed, setRemoved] = useState<string[] | null>(null);
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const password = useRef<HTMLInputElement>(null);
  const recipientInput = useRef<HTMLInputElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void invoke<EmailSettings>('get_email_settings').then(value => {
      if (!active) return;
      setSettings(value); setRecipients(value.recipients); setDraft(''); setUsername(value.username);
    }).catch(e => { if (active) setError(String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const addRecipients = (raw: string) => {
    try {
      const next = mergeRecipients(recipients, raw);
      setRecipients(next); setDraft(''); dirty.current = true; setError('');
    } catch (e) { setDraft(raw); setError(String(e).replace(/^Error: /, '')); }
  };
  const removeRecipient = (address: string) => {
    setRemoved(recipients); setRecipients(current => current.filter(value => value !== address));
    dirty.current = true;
  };
  const save = async () => {
    if (lock.current || loading || !settings || !usernameInput.current?.reportValidity()) return false;
    let nextRecipients: string[];
    try { nextRecipients = mergeRecipients(recipients, draft); }
    catch (e) { setError(String(e).replace(/^Error: /, '')); recipientInput.current?.focus(); return false; }
    lock.current = true; setSaving(true); onBusyChange(true); setError('');
    try {
      const value = await invoke<EmailSettings>('save_email_settings', { recipients: nextRecipients, username: username.trim(), password: password.current?.value ?? '' });
      setSettings(value); setRecipients(value.recipients); setDraft(''); setUsername(value.username); setRemoved(null);
      if (password.current) password.current.value = '';
      dirty.current = false;
      return true;
    } catch (e) { setError(String(e)); return false; }
    finally { lock.current = false; setSaving(false); onBusyChange(false); }
  };
  useImperativeHandle(ref, () => ({ saveIfDirty: () => dirty.current ? save() : Promise.resolve(!loading && !!settings) }));
  return <fieldset disabled={disabled || loading || saving} className="settings-section">
    <legend>邮件发送</legend>
    {loading ? <p className="settings-help" role="status">正在读取邮件设置…</p> : <>
      {settings && <>
        <div className="settings-fields">
          <div className="email-recipient-field">
            <label htmlFor="report-recipient">报告接收邮箱</label>
            <div className="email-recipient-input">
              {recipients.map(recipient => <span className="email-recipient-tag" key={recipient}>
                <span>{recipient}</span>
                <button type="button" aria-label={`移除 ${recipient}`} onClick={() => removeRecipient(recipient)}>×</button>
              </span>)}
              <input ref={recipientInput} id="report-recipient" type="text" inputMode="email" autoComplete="off" spellCheck={false}
                aria-describedby="report-recipient-help" placeholder={recipients.length ? '继续添加邮箱' : '输入邮箱后按回车添加'} value={draft}
                onInput={e => { setDraft(e.currentTarget.value); dirty.current = true; setError(''); }}
                onBlur={() => { if (draft.trim()) addRecipients(draft); }}
                onPaste={event => {
                  const value = event.clipboardData.getData('text');
                  if (/[\s,;，；]/.test(value)) {
                    event.preventDefault();
                    const input = event.currentTarget;
                    addRecipients(draft.slice(0, input.selectionStart ?? draft.length) + value + draft.slice(input.selectionEnd ?? draft.length));
                  }
                }}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (['Enter', ',', ';', '，', '；'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); addRecipients(draft); }
                  if (event.key === 'Backspace' && !draft && recipients.length) { event.preventDefault(); removeRecipient(recipients[recipients.length - 1]); }
                }} />
            </div>
            <p className="settings-help" id="report-recipient-help">按回车添加，可粘贴多个邮箱，以逗号、分号或换行分隔。</p>
            {removed && <p className="settings-help" role="status">已移除邮箱。<button type="button" className="text-button" onClick={() => { setRecipients(current => mergeRecipients(current, removed.join(';'))); setRemoved(null); dirty.current = true; }}>撤销</button></p>}
          </div>
          <label htmlFor="report-sender">发信地址<div className="settings-input"><input ref={usernameInput} id="report-sender" type="email" required value={username} onChange={e => { setUsername(e.target.value); dirty.current = true; }} /></div></label>
          <label htmlFor="report-password">SMTP 密码<div className="settings-input"><input ref={password} id="report-password" type="password" autoComplete="new-password" maxLength={512} placeholder={settings.configured && username.trim() === settings.username ? '已配置，留空保留现有密码' : '请输入此发信地址的 SMTP 密码'} onChange={() => { dirty.current = true; }} /></div></label>
        </div>
        <p className="settings-help">{settings.configured ? '发信服务已预配置。' : '请填写发信地址对应的 SMTP 密码。'} 点击底部“保存设置”一并保存，之后发送报告无需重复填写。接收邮箱留空时不能发送。</p>
      </>}
      {error && <p className="notice warning" role="alert">{error}</p>}
      {!settings && <button type="button" className="secondary-button" onClick={() => setRevision(value => value + 1)}>重新读取邮件设置</button>}
    </>}
  </fieldset>;
});
