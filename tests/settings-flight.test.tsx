import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { defaultSettings } from '../src/lib/workspace';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ipc);
let root: ReturnType<typeof createRoot>;
const onClose = vi.fn();
const onSaved = vi.fn(async () => {});
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
  ipc.invoke.mockReset().mockResolvedValue(null); onClose.mockClear(); onSaved.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = async (_legacyEnabled = false, ready = true) => { await act(async () => root.render(<SettingsDialog settings={{ ...defaultSettings, requireManualConfirmation: false }} flightReady={ready} routes={[{ routeId: 'test-route', name: '现场巡查航线' }]} selectedRoute="现场巡查航线" onClose={onClose} onSaved={onSaved} />)); };
const submit = async () => { await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))); };

it('persists the execution strategy without a separate automatic patrol switch', async () => {
  await render();
  await submit();
  expect(ipc.invoke.mock.calls.map(call => call[0])).toEqual(['save_workspace_settings']);
  expect(document.querySelector('[aria-labelledby="automatic-patrol-label"]')).toBeNull();
  expect(onSaved).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
});
it('shows manual or automatic execution as the only execution choice', async () => {
  await render();
  expect(document.body.textContent).toContain('自动执行');
  expect(document.body.textContent).toContain('K⁺ 或 PM2.5 超过阈值后自动创建巡查计划');
  const choices = [...document.querySelectorAll<HTMLInputElement>('input[name="takeoff-execution-mode"]')];
  expect(choices).toHaveLength(2);
  expect(choices.map(choice => choice.value)).toEqual(['manual', 'automatic']);
  expect(choices[1].checked).toBe(true);
  await act(async () => { choices[0].click(); });
  expect(choices[0].checked).toBe(true);
  expect(document.body.textContent).toContain('由工作人员确认后起飞');
  expect(document.body.textContent).not.toContain('超标仅提示');
});
it('does not invoke a legacy patrol switch when saving fails', async () => {
  await render();
  ipc.invoke.mockRejectedValueOnce('设置写入失败');
  await submit();
  expect(ipc.invoke.mock.calls.map(call => call[0])).toEqual(['save_workspace_settings']);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('设置写入失败');
  expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});
it('saves multiple daily no-fly periods and allows removing every period', async () => {
  await render();
  expect(document.querySelector<HTMLInputElement>('[aria-label="第 1 段禁飞开始时间"]')?.value).toBe('05:00');
  const add = [...document.querySelectorAll('button')].find(b => b.textContent === '＋ 添加时段')!;
  await act(async () => add.click());
  await submit();
  expect(ipc.invoke).toHaveBeenCalledWith('save_workspace_settings', { settings: expect.objectContaining({ noFlyPeriods: [{start:'05:00',end:'08:00'}, {start:'12:00',end:'13:00'}] }) });
  ipc.invoke.mockClear();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="删除第 2 段禁飞时间"]')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="删除第 1 段禁飞时间"]')!.click());
  await submit();
  expect(ipc.invoke).toHaveBeenCalledWith('save_workspace_settings', { settings: expect.objectContaining({ noFlyPeriods: [] }) });
});
it('refreshes the workspace after a no-fly removal is saved and before closing the dialog', async () => {
  await render(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="删除第 1 段禁飞时间"]')!.click());
  ipc.invoke.mockImplementationOnce(async () => {
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  onSaved.mockImplementationOnce(async () => {
    expect(ipc.invoke).toHaveBeenCalledWith('save_workspace_settings', {settings:expect.objectContaining({noFlyPeriods:[]})});
    expect(onClose).not.toHaveBeenCalled();
  });
  await submit();
  expect(onSaved).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
it('cancels no-fly drafts without saving and restores the morning default only in the form', async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="删除第 1 段禁飞时间"]')!.click());
  const click = async (text: string) => { await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === text)!.click()); };
  await click('恢复默认');
  expect(document.querySelector<HTMLInputElement>('[aria-label="第 1 段禁飞结束时间"]')?.value).toBe('08:00');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await click('取消');
  expect(onClose).toHaveBeenCalledOnce();
  expect(ipc.invoke).not.toHaveBeenCalled();
});

const clickText = async (text: string) => { await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === text)!.click()); };
it('clears all local data only after confirmation and keeps unsaved settings open', async () => {
  const cleared = vi.fn(async () => {});
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} onClose={onClose} onSaved={onSaved} onDataCleared={cleared} />));
  await clickText('清空数据');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await clickText('暂不清空');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await clickText('清空数据');
  ipc.invoke.mockResolvedValueOnce({ cleared: true });
  await clickText('确认清空数据');
  expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('clear_all_data', { confirmed: true });
  expect(cleared).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('本地数据已清空');
});
it('keeps the confirmation available and shows storage errors on clear failure', async () => {
  await render();
  await clickText('清空数据');
  ipc.invoke.mockRejectedValueOnce('本地数据库清理失败');
  await clickText('确认清空数据');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('本地数据库清理失败');
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
it('shows the synced route choice and persists a changed route prefix', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} flightReady routes={[{ routeId: 'r1', name: '东南火点巡查航线-改' }, { routeId: 'r2', name: '东南火点巡查航线-改-副本(6)' }]} selectedRoute="东南火点巡查航线-改" onClose={onClose} onSaved={onSaved} />));
  const select = document.querySelector<HTMLSelectElement>('#flight-route')!;
  expect(select.value).toBe('东南火点巡查航线-改');
  expect([...select.options].map(option => option.textContent)).toEqual(['东南火点巡查航线-改', '东南火点巡查航线-改-副本(6)']);
  ipc.invoke.mockResolvedValueOnce({ routes: [{ routeId: 'r2', name: '东南火点巡查航线-改-副本(6)' }], selected: '东南火点巡查航线-改-副本(6)' });
  await act(async () => { select.options[1].selected = true; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  expect(ipc.invoke).toHaveBeenCalledWith('set_flight_route', { route: '东南火点巡查航线-改-副本(6)' });
});
it('configures wind based route selection with direction ranges', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} routes={[{ routeId: 'r1', name: '东南航线' }, { routeId: 'r2', name: '西北航线' }]} selectedRoute="东南航线" onClose={onClose} onSaved={onSaved} />));
  await act(async () => document.querySelector<HTMLInputElement>('input[name="route-selection-mode"][value="wind"]')!.click());
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '＋ 添加风向规则')!.click());
  expect(document.querySelector('[aria-label="第 1 条风向规则开始角度"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="第 1 条风向规则航线"]')?.value).toBe('东南航线');
  await submit();
  expect(ipc.invoke).toHaveBeenCalledWith('save_workspace_settings', { settings: expect.objectContaining({ routeSelectionMode: 'wind', windRouteRules: [{ startDegrees: 0, endDegrees: 45, route: '东南航线' }] }) });
});
it('requires at least one wind rule before enabling advanced mode', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} routes={[{ routeId: 'r1', name: '东南航线' }]} selectedRoute="东南航线" onClose={onClose} onSaved={onSaved} />));
  await act(async () => document.querySelector<HTMLInputElement>('input[name="route-selection-mode"][value="wind"]')!.click());
  await submit();
  expect(ipc.invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('至少配置一条风向规则');
});
it('keeps the sync prompt only before the first route sync', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} onClose={onClose} onSaved={onSaved} />));
  const unsynced = document.querySelector<HTMLSelectElement>('#flight-route')!;
  expect([...unsynced.options].map(option => option.textContent)).toEqual(['请先同步航线列表']);
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} routes={[{ routeId: 'r1', name: '东南火点巡查航线' }]} routesSyncedAt={Date.now()} onClose={onClose} onSaved={onSaved} />));
  const synced = document.querySelector<HTMLSelectElement>('#flight-route')!;
  expect([...synced.options].map(option => option.textContent)).toEqual(['请选择航线', '东南火点巡查航线']);
  expect(document.body.textContent).not.toContain('请先同步航线列表');
});
it('uses a matching-height refresh icon and shows its spinning state while syncing', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} flightReady routes={[{ routeId: 'r1', name: '东南火点巡查航线-改' }]} selectedRoute="东南火点巡查航线-改" onClose={onClose} onSaved={onSaved} />));
  const select = document.querySelector<HTMLSelectElement>('#flight-route')!;
  const refresh = document.querySelector<HTMLButtonElement>('[aria-label="同步司空航线"]')!;
  expect(select.className).toBe('');
  expect(refresh.classList.contains('settings-route-sync')).toBe(true);
  expect(refresh.querySelector('svg.refresh-icon')?.classList.contains('is-spinning')).toBe(false);
  let resolveSync!: (value: unknown) => void;
  ipc.invoke.mockImplementationOnce(() => new Promise(resolve => { resolveSync = resolve; }));
  await act(async () => { refresh.click(); await Promise.resolve(); });
  expect(document.querySelector('[aria-label="正在同步航线"] svg.refresh-icon')?.classList.contains('is-spinning')).toBe(true);
  await act(async () => resolveSync({ routes: [], selected: '东南火点巡查航线-改' }));
});
