import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { minimumExtensionVersion } from '../bridge-config.json';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupPanel } from '../src/components/SetupPanel';
import { useWorkspace } from '../src/lib/useWorkspace';
import type { Readiness } from '../src/lib/workspace';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ipc);
let current: ReturnType<typeof useWorkspace>;
let root: Root;
let state: Readiness;
let start: ReturnType<typeof vi.fn>;
function Harness() { current = useWorkspace(); return <div>{current.readiness?.started ? '主页' : '准备中'}</div>; }
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); };
const mount = async () => { await act(async () => root.render(<StrictMode><Harness /></StrictMode>)); };

beforeEach(() => {
  vi.useFakeTimers();
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(window.document.getElementById('root')!);
  state = { pluginReady:true, pluginMessage:'connected', pluginUpdateRequired:false, minimumExtensionVersion:'0.7.1', checking:false, started:false, ready:false, sites:[] };
  start = vi.fn(async () => { state = { ...state, started:true }; });
  ipc.isTauri.mockReturnValue(true);
  ipc.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_readiness') return state;
    if (command === 'start_workspace') return start();
    return null;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('automatic workspace startup', () => {
  it('refreshes immediately when the window becomes visible or focused, without waiting for timers', async () => {
    await mount();
    state = { ...state, ready: true, started: true };
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
    expect(current.readiness?.ready).toBe(true);
    state = { ...state, ready: false, pluginReady: false };
    await act(async () => { window.dispatchEvent(new window.Event('focus')); });
    expect(current.readiness?.pluginReady).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('waits for every check, then enters without a click and starts once under StrictMode', async () => {
    await mount();
    expect(start).not.toHaveBeenCalled();
    state = { ...state, ready:true, checking:true };
    await tick();
    expect(start).not.toHaveBeenCalled();
    state = { ...state, checking:false };
    await tick();
    expect(start).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toBe('主页');
    await tick();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('waits for all platforms before starting hourly monitoring', async () => {
    state = { ...state, monitoringReady: true, flightReady: false, reportReady: false, ready: false };
    await mount();
    expect(start).not.toHaveBeenCalled();
    expect(current.readiness?.started).toBe(false);
    state = { ...state, ready: true, flightReady: true, reportReady: true };
    await tick();
    expect(start).toHaveBeenCalledTimes(1);
    expect(current.readiness?.started).toBe(true);
  });

  it('does not duplicate a slow initial sync across status polls', async () => {
    let finish!: () => void;
    start.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    state = { ...state, ready:true };
    await mount();
    await tick();
    await tick();
    expect(start).toHaveBeenCalledTimes(1);
    expect(current.acting).toBe(true);
    await act(async () => { state = { ...state, started:true }; finish(); });
    expect(current.acting).toBe(false);
    expect(document.body.textContent).toBe('主页');
  });

  it('keeps a failed sync visible without a retry loop and allows manual retry', async () => {
    state = { ...state, ready:true };
    start.mockRejectedValueOnce(new Error('数据读取失败'));
    await mount();
    await tick();
    await tick();
    expect(start).toHaveBeenCalledTimes(1);
    expect(current.error).toContain('数据读取失败');
    expect(document.body.textContent).toBe('准备中');
    await act(async () => { await current.action('start_workspace'); });
    expect(start).toHaveBeenCalledTimes(2);
    expect(current.error).toBe('');
    expect(document.body.textContent).toBe('主页');
  });

  it('does not restart an existing workspace after reconnecting', async () => {
    state = { ...state, ready:true, started:true };
    await mount();
    state = { ...state, ready:false };
    await tick();
    state = { ...state, ready:true };
    await tick();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a fresh initial sync after local data is cleared', async () => {
    state = { ...state, ready:true };
    await mount();
    await tick();
    expect(start).toHaveBeenCalledTimes(1);

    state = { ...state, started:false };
    await act(async () => current.resetStartup());
    await tick();
    expect(start).toHaveBeenCalledTimes(2);
  });
});

it('flags an old running plugin even when the native process still reports its old requirement as passed', async () => {
  let version = '0.7.32';
  state = { ...state, minimumExtensionVersion: '0.7.32', ready: true };
  ipc.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_bridge_status') return { connected: true, clients: 1, versions: [version], tabs: [], error: null };
    if (command === 'get_readiness') return state;
    if (command === 'start_workspace') return start();
    return null;
  });
  await mount();
  expect(current.readiness?.pluginUpdateRequired).toBe(true);
  expect(current.readiness?.minimumExtensionVersion).toBe(minimumExtensionVersion);
  expect(current.readiness?.pluginReady).toBe(false);
  expect(start).not.toHaveBeenCalled();
  const html = renderToStaticMarkup(<SetupPanel bridge={current.bridge} state={current.readiness} busy={false} onCheck={() => {}} openSite={() => {}} />);
  expect(html).toContain(`当前插件 v0.7.32 · 需更新至 v${minimumExtensionVersion} 或以上`);
  expect(html).toContain('需更新');
  expect(html).toContain('更新插件');
  version = minimumExtensionVersion;
  await tick();
  expect(current.readiness?.pluginUpdateRequired).toBe(false);
  expect(start).toHaveBeenCalledTimes(1);
});


it('clears a failed flight refresh only after a newer successful observation of the same task', async () => {
  state = { ...state, started: true };
  let event = { id: 'flight-a', status: 'submitted', statusCheckedAt: Date.now() - 1000, statusCheckError: null };
  let archived = false;
  ipc.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_readiness') return state;
    if (command === 'get_monitoring') return { flight: { event: archived ? null : event, records: archived ? [event] : [] } };
    if (command === 'refresh_flight_status') throw '后台页面读取超时';
    return null;
  });
  await mount();
  await act(async () => { await current.action('refresh_flight_status', { eventId: 'flight-a' }); });
  await tick();
  expect(current.error).toBe('后台页面读取超时'); // old success is not recovery
  event = { ...event, id: 'flight-b', statusCheckedAt: Date.now() };
  await tick();
  expect(current.error).toBe('后台页面读取超时'); // another task is not recovery
  event = { ...event, id: 'flight-a', statusCheckedAt: Date.now(), statusCheckError: '仍然超时' as any };
  await tick();
  expect(current.error).toBe('后台页面读取超时');
  event = { ...event, status: 'completed', statusCheckedAt: Date.now(), statusCheckError: null };
  archived = true;
  await tick();
  expect(current.error).toBe('');
});

it('keeps unrelated action failures until dismissed and does not dismiss connection failures', async () => {
  state = { ...state, started: true };
  await mount();
  ipc.invoke.mockRejectedValueOnce('保存设置失败');
  await act(async () => { await current.action('save_settings'); });
  await tick();
  expect(current.error).toBe('保存设置失败');
  expect(current.canDismissError).toBe(true);
  await act(async () => current.dismissError());
  expect(current.error).toBe('');
  ipc.invoke.mockRejectedValueOnce('连接失败');
  await act(async () => { await current.refresh(); });
  expect(current.error).toContain('无法读取客户端状态');
  expect(current.canDismissError).toBe(false);
});

it('fetches missing weather immediately after plugin checks pass without retrying on every poll', async () => {
  state = { ...state, pluginReady: false, started: true };
  let weather: { current: object | null; refreshing: boolean } = { current: null, refreshing: false };
  let finish!: () => void;
  ipc.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_readiness') return state;
    if (command === 'get_monitoring') return { weather, flight: {} };
    if (command === 'refresh_weather') return new Promise<void>(resolve => { finish = resolve; });
    return null;
  });
  const requests = () => ipc.invoke.mock.calls.filter(([command]) => command === 'refresh_weather');
  await mount();
  expect(requests()).toHaveLength(0);
  state = { ...state, pluginReady: true };
  await act(async () => { await current.refresh(); });
  expect(requests()).toHaveLength(1);
  expect(current.acting).toBe(false);
  await tick();
  expect(requests()).toHaveLength(1);
  await act(async () => finish());
  await tick();
  expect(requests()).toHaveLength(1); // native timer owns retries after a failed read
  weather = { current: {}, refreshing: false };
  await tick();
  expect(requests()).toHaveLength(1);
  weather = { current: null, refreshing: true };
  await tick();
  expect(requests()).toHaveLength(1); // an existing native fetch is enough
  weather = { current: null, refreshing: false };
  await tick();
  expect(requests()).toHaveLength(2);
  await act(async () => finish());
});

it('refreshes expired cached weather on focus once, and rearms after recovery', async () => {
  state = { ...state, started: true };
  let weather = { current: { fetchedAt: Date.now() / 1000 }, refreshing: false, level: 'ok' };
  let finish!: () => void;
  ipc.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_readiness') return state;
    if (command === 'get_monitoring') return { weather, flight: {} };
    if (command === 'refresh_weather') return new Promise<void>(resolve => { finish = resolve; });
    return null;
  });
  const requests = () => ipc.invoke.mock.calls.filter(([command]) => command === 'refresh_weather');
  await mount();
  expect(requests()).toHaveLength(0);
  weather = { ...weather, level: 'unknown', current: { fetchedAt: Date.now() / 1000 - 1801 } };
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  expect(requests()).toHaveLength(1);
  expect(current.acting).toBe(false);
  await tick();
  expect(requests()).toHaveLength(1);
  await act(async () => finish());
  await tick();
  expect(requests()).toHaveLength(1); // Failed recovery leaves retries to the native timer.
  weather = { ...weather, level: 'unsafe' };
  await tick();
  expect(requests()).toHaveLength(1); // A valid unfavorable verdict is not unavailable data.
  weather = { ...weather, level: 'unknown', refreshing: true };
  await tick();
  expect(requests()).toHaveLength(1);
  weather = { ...weather, refreshing: false };
  await tick();
  expect(requests()).toHaveLength(2);
  await act(async () => finish());
});
