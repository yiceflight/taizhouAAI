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
const render = async (enabled = false, ready = true) => { await act(async () => root.render(<SettingsDialog settings={{ ...defaultSettings, requireManualConfirmation: false }} flightEnabled={enabled} canEnableFlight={ready} onClose={onClose} onSaved={onSaved} />)); };
const toggle = () => document.querySelector<HTMLButtonElement>('[aria-labelledby="automatic-patrol-label"]')!;
const submit = async () => { await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))); };

it('persists the strategy before explicitly enabling automatic patrol', async () => {
  await render();
  await act(async () => toggle().click());
  await submit();
  expect(ipc.invoke.mock.calls.map(call => call[0])).toEqual(['save_workspace_settings', 'set_flight_enabled']);
  expect(ipc.invoke).toHaveBeenLastCalledWith('set_flight_enabled', { enabled: true });
  expect(onSaved).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
});
it('leaves automatic patrol off when only the confirmation strategy changes', async () => {
  await render();
  await submit();
  expect(ipc.invoke.mock.calls.map(call => call[0])).toEqual(['save_workspace_settings']);
  expect(document.body.textContent).toContain('自动巡查尚未开启');
});
it('disables automatic patrol before saving settings to cancel pending automatic tasks', async () => {
  await render(true);
  await act(async () => toggle().click());
  await submit();
  expect(ipc.invoke.mock.calls.map(call => call[0])).toEqual(['set_flight_enabled', 'save_workspace_settings']);
  expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'set_flight_enabled', { enabled: false });
});
it('requires readiness to enable but permits disabling an existing automatic patrol', async () => {
  await render(false, false);
  expect(toggle().disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root')!);
  await render(true, false);
  expect(toggle().disabled).toBe(false);
});
it('does not enable automatic patrol when saving the strategy fails', async () => {
  await render();
  await act(async () => toggle().click());
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
it('clears only after confirmation, refreshes tasks and keeps unsaved settings open', async () => {
  const cleared = vi.fn(async () => {});
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} onClose={onClose} onSaved={onSaved} onTasksCleared={cleared} />));
  await clickText('清空任务列表');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await clickText('暂不清空');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await clickText('清空任务列表');
  ipc.invoke.mockResolvedValueOnce({ preservedCurrentTask: false });
  await clickText('确认清空');
  expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('clear_task_list', { confirmed: true });
  expect(cleared).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('任务列表已清空');
});
it('keeps the confirmation available and shows storage errors on clear failure', async () => {
  await render();
  await clickText('清空任务列表');
  ipc.invoke.mockRejectedValueOnce('任务记录写入失败');
  await clickText('确认清空');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('任务记录写入失败');
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it('reports successful history clearing while retaining a current task', async () => {
  const cleared = vi.fn(async () => {});
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} onClose={onClose} onSaved={onSaved} onTasksCleared={cleared} />));
  await clickText('清空任务列表');
  expect(document.body.textContent).toContain('当前正在执行或待核查的任务会保留');
  ipc.invoke.mockResolvedValueOnce({ preservedCurrentTask: true });
  await clickText('确认清空');
  expect(cleared).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('历史任务已清空。当前正在执行或待核查的任务已保留');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
});
