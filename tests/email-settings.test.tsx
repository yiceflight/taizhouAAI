import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmailSettingsSection, type EmailSettingsHandle } from '../src/components/EmailSettingsSection';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { ReportEmailDialog } from '../src/components/ReportEmailDialog';
import { defaultSettings } from '../src/lib/workspace';
import { mergeRecipients } from '../src/lib/email';
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ipc);
let root: ReturnType<typeof createRoot>;
const saved = { recipients: ['chosen@example.com', 'second@example.com'], username: 'sender@example.com', configured: true };
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(window.HTMLInputElement.prototype, 'reportValidity', { configurable: true, value() { return true; } });
  vi.stubGlobal('HTMLFormElement', window.HTMLFormElement); vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('HTMLInputElement', window.HTMLInputElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
  ipc.invoke.mockReset().mockImplementation(async (command, payload) => command === 'save_email_settings' ? { ...saved, ...payload } : saved);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const click = async (label: string) => { await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === label)!.click()); };
const remove = async (address: string) => { await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="移除 ${address}"]`)!.click()); };
const inputDraft = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>('#report-recipient')!;
  await act(async () => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
};
const submit = async () => { await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))); };
it('deduplicates across existing tags and a pasted batch, and rejects invalid addresses', () => {
  expect(mergeRecipients(['first@example.com'], ' FIRST@example.com;second@example.com\nsecond@example.com，third@example.com')).toEqual(['first@example.com', 'second@example.com', 'third@example.com']);
  expect(() => mergeRecipients([], 'good@example.com;invalid')).toThrow('邮箱地址无效');
});
it('loads tags and retains the password without a separate save button', async () => {
  const ref = createRef<EmailSettingsHandle>();
  await act(async () => root.render(<EmailSettingsSection ref={ref} onBusyChange={() => {}} />));
  expect([...document.querySelectorAll('.email-recipient-tag > span')].map(node => node.textContent)).toEqual(saved.recipients);
  const password = document.querySelector<HTMLInputElement>('#report-password')!;
  expect(password.type).toBe('password'); expect(password.value).toBe(''); expect(password.placeholder).toContain('已配置');
  expect(document.body.textContent).not.toContain('保存邮件设置');
  await remove(saved.recipients[1]);
  expect(ipc.invoke.mock.calls.filter(call => call[0] === 'save_email_settings')).toHaveLength(0);
  await act(async () => { expect(await ref.current!.saveIfDirty()).toBe(true); });
  expect(ipc.invoke).toHaveBeenCalledWith('save_email_settings', { recipients: [saved.recipients[0]], username: saved.username, password: '' });
});
it('pastes multiple tags, deduplicates, removes and undoes without saving', async () => {
  await act(async () => root.render(<EmailSettingsSection onBusyChange={() => {}} />));
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'third@example.com;THIRD@example.com\nfourth@example.com' } });
  await act(async () => document.querySelector('#report-recipient')!.dispatchEvent(event));
  expect(document.querySelectorAll('.email-recipient-tag')).toHaveLength(4);
  await remove('third@example.com');
  expect(document.querySelectorAll('.email-recipient-tag')).toHaveLength(3);
  await click('撤销');
  expect(document.querySelectorAll('.email-recipient-tag')).toHaveLength(4);
  expect(ipc.invoke.mock.calls.filter(call => call[0] === 'save_email_settings')).toHaveLength(0);
});
it('the unified save includes the unfinished last address and saves monitoring settings', async () => {
  const close = vi.fn(); const onSaved = vi.fn(async () => {});
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} onClose={close} onSaved={onSaved} />));
  await inputDraft('last@example.com');
  await submit();
  expect(ipc.invoke).toHaveBeenCalledWith('save_email_settings', { recipients: [...saved.recipients, 'last@example.com'], username: saved.username, password: '' });
  expect(ipc.invoke.mock.calls.some(call => call[0] === 'save_workspace_settings')).toBe(true);
  expect(onSaved).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it('invalid drafts block the unified save without losing user input', async () => {
  const close = vi.fn();
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} onClose={close} onSaved={async () => {}} />));
  await inputDraft('invalid'); await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('邮箱地址无效');
  expect(document.querySelector<HTMLInputElement>('#report-recipient')!.value).toBe('invalid');
  expect(ipc.invoke.mock.calls.filter(call => call[0].startsWith('save_'))).toHaveLength(0);
  expect(close).not.toHaveBeenCalled();
});
it('a credential save failure keeps the dialog open and blocks the remaining save', async () => {
  const close = vi.fn();
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} onClose={close} onSaved={async () => {}} />));
  await remove(saved.recipients[1]);
  ipc.invoke.mockRejectedValueOnce('系统凭据存储已锁定');
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('系统凭据存储已锁定');
  expect(ipc.invoke.mock.calls.some(call => call[0] === 'save_workspace_settings')).toBe(false);
  expect(close).not.toHaveBeenCalled();
});
it('uses all saved recipients for sending and prevents duplicate submits', async () => {
  const sent = vi.fn();
  await act(async () => root.render(<ReportEmailDialog reportId="report-1" onClose={() => {}} onSent={sent} />));
  expect(document.querySelectorAll('input')).toHaveLength(0);
  saved.recipients.forEach(address => expect(document.body.textContent).toContain(address));
  let finish!: (to: string) => void;
  ipc.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await submit(); await submit();
  expect(ipc.invoke.mock.calls.filter(call => call[0] === 'send_flight_report_email')).toEqual([['send_flight_report_email', { reportId: 'report-1', expectedRecipients: saved.recipients, expectedUsername: saved.username }]]);
  await act(async () => finish(saved.recipients.join('、')));
  expect(sent).toHaveBeenCalledWith(saved.recipients.join('、'));
});
it('requires recipients and links directly to settings', async () => {
  ipc.invoke.mockResolvedValue({ ...saved, recipients: [] });
  const openSettings = vi.fn();
  await act(async () => root.render(<ReportEmailDialog reportId="report-1" onClose={() => {}} onSent={() => {}} onSettings={openSettings} />));
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await click('修改邮件设置');
  expect(openSettings).toHaveBeenCalledOnce();
  expect(ipc.invoke.mock.calls.some(call => call[0] === 'send_flight_report_email')).toBe(false);
});
