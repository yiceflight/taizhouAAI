import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('starts hourly monitoring while other platforms are offline', async () => {
    state = { ...state, monitoringReady: true, flightReady: false, reportReady: false, ready: false };
    await mount();
    expect(start).toHaveBeenCalledTimes(1);
    expect(current.readiness?.started).toBe(true);
    expect(current.readiness?.ready).toBe(false);
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
