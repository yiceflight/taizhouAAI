import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UpdateBanner } from '../src/components/UpdateBanner';

const api = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: api.isTauri, invoke: api.invoke }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.2.0' }));
vi.mock('../src/lib/appUpdater', () => ({ checkForAppUpdate: api.check }));
let root: Root;
const mount = async () => { await act(async () => root.render(<StrictMode><UpdateBanner /></StrictMode>)); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const event = async (type: string) => { await act(async () => { window.dispatchEvent(new window.Event(type)); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('PROD', true);
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
  api.invoke.mockReset().mockResolvedValue(false);
  api.check.mockReset().mockResolvedValue(null);
  api.isTauri.mockReturnValue(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('checks on production startup without clicks, and again six hours later', async () => {
  await mount();
  expect(document.body.textContent).toContain('当前客户端 v0.2.0');
  expect(api.check).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('自动检查：已是最新版本');
  await event('focus');
  await advance(6 * 60 * 60_000 - 1);
  expect(api.check).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(api.check).toHaveBeenCalledTimes(2);
});

it('retries failures after five minutes without exposing parser errors', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  api.check.mockRejectedValueOnce('invalid value for `pub_date`');
  await mount();
  expect(document.body.textContent).toContain('5 分钟后自动重试');
  expect(document.body.textContent).not.toContain('pub_date');
  await advance(5 * 60_000 - 1);
  expect(api.check).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(api.check).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain('自动检查：已是最新版本');
});

it('retries immediately when connectivity returns and skips overlapping requests', async () => {
  let resolve!: (value: null) => void;
  api.check.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await mount();
  await event('online');
  await advance(6 * 60 * 60_000);
  expect(api.check).toHaveBeenCalledTimes(1);
  await act(async () => resolve(null));
  await event('online');
  expect(api.check).toHaveBeenCalledTimes(2);
});

it('offers an update automatically but waits for the user to install it', async () => {
  const install = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  api.check.mockResolvedValue({ currentVersion: '0.2.0', latestVersion: '0.2.2', releaseNotes: [], install, close });
  await mount();
  const updateButton = document.querySelector<HTMLButtonElement>('.update-install');
  expect(updateButton?.textContent).toContain('有新版本 v0.2.2，下载并重启');
  expect(updateButton?.disabled).toBe(false);
  await event('online');
  await advance(6 * 60 * 60_000);
  expect(api.check).toHaveBeenCalledTimes(1);
  expect(install).not.toHaveBeenCalled();
});

it('cleans up timers, listeners and a late result on unmount', async () => {
  let resolve!: (value: unknown) => void;
  api.check.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await mount();
  await act(async () => root.render(null));
  const close = vi.fn().mockResolvedValue(undefined);
  await act(async () => resolve({ close }));
  expect(close).toHaveBeenCalledTimes(1);
  await event('online');
  await advance(6 * 60 * 60_000);
  expect(api.check).toHaveBeenCalledTimes(1);
});

it('does not automatically check in development or browser previews', async () => {
  vi.stubEnv('PROD', false);
  await mount();
  await event('online');
  await advance(6 * 60 * 60_000);
  expect(api.check).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  vi.stubEnv('PROD', true);
  api.isTauri.mockReturnValue(false);
  await mount();
  await event('online');
  await advance(6 * 60 * 60_000);
  expect(api.check).not.toHaveBeenCalled();
});


it('test packages never check or offer production updates even with a production frontend build', async () => {
  api.invoke.mockResolvedValue(true);
  await mount();
  await event('focus');
  await event('online');
  await advance(6 * 60 * 60_000);
  expect(document.body.textContent).toContain('测试版客户端');
  expect(document.body.textContent).toContain('不接收正式版更新');
  expect(document.querySelector('.update-action')).toBeNull();
  expect(api.check).not.toHaveBeenCalled();
});

it('does not contact update services before the native environment is known', async () => {
  api.invoke.mockImplementation(() => new Promise(() => {}));
  await mount();
  await event('online');
  await advance(6 * 60 * 60_000);
  expect(api.check).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLButtonElement>('.update-action')?.disabled).toBe(true);
});
