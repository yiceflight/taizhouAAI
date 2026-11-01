import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RequiredSetupDialog } from '../src/components/RequiredSetupDialog';
import type { Readiness } from '../src/lib/workspace';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock('@tauri-apps/api/core', () => ipc);
let root: Root;
const ready = (): Readiness => ({ pluginReady: true, pluginUpdateRequired: false, pluginMessage: '', minimumExtensionVersion: '0.6.0', checking: false, ready: true, started: true, sites: ['map', 'dji', 'sniff'].map(id => ({ id, state: 'ready', message: '', checkedAt: null, session: null, tabId: null, url: null })) });
const render = async (state: Readiness | null, update?: React.ReactNode) => {
  await act(async () => root.render(<RequiredSetupDialog environment={{ bridge: { connected: true, clients: 1, versions: ['0.5.0'], tabs: [], error: null }, state, busy: false, onCheck: vi.fn(), openSite: vi.fn() }} update={update} />));
};
beforeEach(() => {
  ipc.invoke.mockReset().mockResolvedValue(undefined);
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('blocks unknown status, missing or incompatible plugins, and each unverified website', async () => {
  await render(null);
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  for (const id of ['map', 'dji', 'sniff']) {
    const state = ready(); state.sites.find(site => site.id === id)!.state = 'login_required';
    await render(state);
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    expect(document.querySelectorAll('.required-environment-list .health-row')).toHaveLength(4);
  }
  await render({ ...ready(), pluginReady: false });
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  await render({ ...ready(), pluginUpdateRequired: true });
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  const missing = ready(); missing.sites.pop(); await render(missing);
  expect(document.querySelector('dialog[open]')).not.toBeNull();
});

it('automatically releases only after all checks pass and reopens on login loss', async () => {
  await render(null); await render(ready());
  expect(document.querySelector('dialog')).toBeNull();
  const expired = ready(); expired.sites[1].state = 'login_required'; await render(expired);
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  const cancel = new window.Event('cancel', { cancelable: true });
  await act(async () => { document.querySelector('dialog')!.dispatchEvent(cancel); });
  expect(cancel.defaultPrevented).toBe(true);
  await render(ready(), <button>立即更新</button>);
  expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
  expect(document.body.textContent).toContain('请先更新客户端');
});

it('shows the connected plugin version and update action inside its environment row', async () => {
  await render({ ...ready(), pluginReady: false, pluginUpdateRequired: true });
  const row = document.querySelector('.required-environment-list .health-row')!;
  expect(row.textContent).toContain('当前插件 v0.5.0 · 需更新至 v0.6.0 或以上');
  const button = row.querySelector('button')!;
  expect(button.textContent).toBe('更新插件 ↗');
  await act(async () => button.click());
  expect(ipc.invoke).toHaveBeenCalledWith('open_chrome_extensions');
  expect(button.hasAttribute('aria-expanded')).toBe(false);
  expect(row.textContent).toContain('重新加载');
  expect(row.querySelector('.required-plugin-instructions')).toBeNull();
  expect(row.querySelector('.extension-path')).toBeNull();
});

it('keeps installation steps and the directory in the installation flow', async () => {
  await render({ ...ready(), pluginReady: false });
  const row = document.querySelector('.required-environment-list .health-row')!;
  const button = row.querySelector('button')!;
  expect(button.textContent).toBe('安装与连接');
  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(row.querySelector('.extension-path')).not.toBeNull();
  expect(row.textContent).toContain('加载已解压的扩展程序');
});

it('shows an actionable fallback when Chrome extension management cannot open', async () => {
  await render({ ...ready(), pluginReady: false, pluginUpdateRequired: true });
  ipc.invoke.mockRejectedValueOnce(new Error('open failed'));
  const row = document.querySelector('.required-environment-list .health-row')!;
  await act(async () => row.querySelector('button')!.click());
  expect(row.querySelector('[role="alert"]')?.textContent).toContain('chrome://extensions');
  expect(row.querySelector('.required-plugin-instructions')).toBeNull();
});
