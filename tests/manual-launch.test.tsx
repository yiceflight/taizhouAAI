import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DroneStatus } from '../src/components/DroneStatus';
import { defaultSettings, type MonitorView } from '../src/lib/workspace';

const now = Date.now();
const data = (potassium: number | null = 0.2, age = 1): MonitorView => ({
  enabled: true, syncing: false, lastAttempt: null, lastSuccess: null, error: null, total: 1, queryThrough: null,
  rows: [{ potassium, time: new Date(now + (8 - age) * 3600000).toISOString().slice(0, 19).replace('T', ' ') }],
  settings: { ...defaultSettings, noFlyPeriods: [] }, flight: { enabled: false, threshold: 1, event: null },
  weather: { location: '机场', latitude: 0, longitude: 0, source: 'test', refreshing: false, allowed: true, level: 'ok', label: '通过', reasons: [],
    current: { observedAt: now / 1000, fetchedAt: now / 1000, temperature: 25.7, weatherCode: 3, windSpeed: 1.97, windGusts: 3, windDirection: 0, precipitation: 0 } },
});
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  // linkedom does not implement native modal dialogs; model only their open state.
  Object.defineProperty(window.HTMLElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = async (d: MonitorView, action = vi.fn(async () => true), ready = true) => {
  const props = { data: d, ready, started: true, busy: false, action };
  await act(async () => root.render(<DroneStatus {...props} onFlight={() => {}} />));
  return action;
};
const click = async (text: string) => { await act(async () => button(text).click()); };

describe('manual launch confirmation', () => {
  it.each(['ready', 'flight_error'] as const)('requires explicit platform review before closing %s and never submits a flight', async status => {
    const d = data();
    d.flight.event = { id: 'review-task', observedAt: '2026-10-11 10:00:00', potassium: 2, name: '待核查任务', status, error: null, preview: false };
    let finish!: (ok: boolean) => void;
    const action = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await render(d, action);
    expect(button('刷新状态')).toBeDefined();
    await click('更多 ⋯'); await click('核查后结束任务');
    expect(button('确认已核查并结束').disabled).toBe(true);
    await click('确认已核查并结束'); expect(action).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')?.textContent).toContain('不会取消平台计划');
    const checkbox = document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!;
    await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); });
    expect(button('确认已核查并结束').disabled).toBe(false);
    const confirm = button('确认已核查并结束');
    await act(async () => { confirm.click(); confirm.click(); });
    expect(action).toHaveBeenCalledExactlyOnceWith('resolve_flight', { eventId: 'review-task', expectedStatus: status, confirmed: true });
    await act(async () => finish(true));
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('blocks closure when polling changes the state while the confirmation is open', async () => {
    const d = data();
    d.flight.event = { id: 'review-task', observedAt: '', potassium: null, name: '待确认任务', status: 'ready', error: null, preview: false };
    const action = await render(d);
    await click('更多 ⋯'); await click('核查后结束任务');
    const checkbox = document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!;
    await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); });
    d.flight.event.status = 'flying'; await render(d, action);
    expect(button('确认已核查并结束').disabled).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('任务状态已变化');
    await click('确认已核查并结束'); expect(action).not.toHaveBeenCalled();
  });
  it('finishes a preview without querying or claiming a real flight and permits retry on save failure', async () => {
    const d = data();
    d.flight.event = { id: 'preview-task', observedAt: '', potassium: null, name: '填写演练', status: 'ready', error: null, preview: true, source: 'preview' };
    const action = vi.fn(async () => false);
    await render(d, action);
    expect(button('刷新状态')).toBeUndefined();
    await click('更多 ⋯'); await click('结束演练');
    expect(document.querySelector('dialog input')).toBeNull();
    await click('确认结束演练');
    expect(action).toHaveBeenCalledExactlyOnceWith('resolve_flight', { eventId: 'preview-task', expectedStatus: 'ready', confirmed: true });
    expect(document.querySelector('dialog')?.textContent).toContain('未能处理本次提醒');
    expect(button('确认结束演练').disabled).toBe(false);
  });
  it('restores normal manual launch after an unresolved task is archived by explicit refresh', async () => {
    const d = data(null);
    d.flight.event = { id: 'uncertain-task', observedAt: '', potassium: null, name: '待核查任务', status: 'uncertain', error: '提交超时', preview: false };
    const action = vi.fn(async (command: string) => {
      if (command === 'refresh_flight_status') {
        d.flight.records = [{ ...d.flight.event!, statusCheckError: '已解除本地任务占用，原结果未确认' }];
        d.flight.event = null;
      }
      return true;
    });
    await render(d, action); await click('刷新状态'); await render(d, action);
    expect(button('立即执行任务').disabled).toBe(false);
    expect(action).toHaveBeenCalledExactlyOnceWith('refresh_flight_status', { eventId: 'uncertain-task' });
    await click('立即执行任务');
    expect(action).toHaveBeenCalledTimes(1);
    await click('确认执行任务');
    expect(action).toHaveBeenLastCalledWith('launch_flight');
    expect(d.flight.records![0].status).toBe('uncertain');
  });
  it('refreshes status without launching and prevents duplicate refresh requests', async () => {
    const d = data(); d.flight.event = { id: 'uncertain-task', observedAt: '', potassium: null, name: '待核查任务', status: 'uncertain', error: '提交超时', preview: false };
    let finish!: (ok: boolean) => void;
    const action = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await render(d, action);
    const refresh = button('刷新状态');
    await act(async () => { refresh.click(); refresh.click(); });
    expect(action).toHaveBeenCalledExactlyOnceWith('refresh_flight_status', { eventId: 'uncertain-task' });
    expect(button('正在刷新…').disabled).toBe(true);
    expect(button('核查后重新发起')).toBeUndefined();
    await act(async () => finish(false));
    expect(button('刷新状态').disabled).toBe(false);
  });
  it.each(['windSpeed', 'windGusts'] as const)('prohibits manual launch when DJI says unsafe regardless of wind (%s)', async field => {
    const d = data(2);
    d.weather!.allowed = false; d.weather!.level = 'unsafe'; d.weather!.current![field] = 0;
    const action = await render(d);
    expect(button('司空气象未通过').disabled).toBe(true);
    await click('司空气象未通过');
    expect(document.querySelector('dialog')).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });
  it.each(['windSpeed', 'windGusts'] as const)('blocks a confirmed override when DJI changes its verdict (%s)', async field => {
    const d = data(2);
    d.weather!.allowed = false; d.weather!.level = 'caution'; d.weather!.current![field] = 11.99;
    const action = await render(d); await click('手动强制起飞');
    const checkbox = document.querySelector<HTMLInputElement>('.manual-launch-override input')!;
    await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); });
    expect(button('确认强制起飞').disabled).toBe(false);
    d.weather!.current![field] = 12; d.weather!.level = 'unsafe'; await render(d, action);
    expect(button('确认强制起飞').disabled).toBe(true);
    expect(document.querySelector('.manual-launch-override')).toBeNull();
    expect(document.querySelector('dialog')?.textContent).toContain('人工确认不能覆盖');
    await click('确认强制起飞'); expect(action).not.toHaveBeenCalled();
  });
  it('blocks a manual launch when its open confirmation crosses into a no-fly period', async () => {
    const at=Date.parse('2026-10-09T04:59:00+08:00'); vi.setSystemTime(at);
    const d=data(); d.settings.noFlyPeriods=[{start:'05:00',end:'08:00'}];
    d.weather!.current!.fetchedAt=at/1000; d.weather!.current!.observedAt=at/1000;
    const action=await render(d);
    await click('立即执行任务');
    await act(async () => vi.advanceTimersByTime(60000));
    expect(button('确认执行任务').disabled).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('禁飞时间 05:00–08:00');
    await click('确认执行任务');
    expect(action).not.toHaveBeenCalled();
  });
  it('removes a completed status when polling finishes a flight without taking an action', async () => {
    const d=data();
    d.flight.event={id:'active-task',observedAt:'',potassium:2,name:'原任务',status:'flying',error:null,preview:false,source:'auto'};
    const action=await render(d);
    expect(document.querySelector('.drone-status-copy')?.textContent).toContain('正在执飞');
    d.flight.event={...d.flight.event,status:'completed'};await render(d,action);
    expect(document.querySelector('.drone-status-copy')).toBeNull();
    expect(button('立即执行任务').disabled).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });
  it('offers manual retry after failure without requiring dismissal of a status reminder', async () => {
    const d=data(2);
    d.flight.event={id:'failed-auto',observedAt:'2026-10-08 09:00:00',potassium:2,name:'原自动任务',status:'failed',error:'准备失败',preview:false,source:'auto'};
    const action=await render(d);
    expect(document.querySelector('.drone-status-copy')).toBeNull();
    expect(button('查看失败详情')).toBeUndefined();
    expect(button('更多 ⋯')).toBeUndefined();
    await click('重新发起任务');
    expect(document.querySelector('dialog')).not.toBeNull();
    expect(action).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation from the header launch entrance', async () => {
    const action = await render(data(), undefined, true);
    await click('立即执行任务');
    expect(action).not.toHaveBeenCalled();
    const dialog = document.querySelector('dialog[open]')!;
    expect(dialog).not.toBeNull();
    for (const text of ['当前钾离子未超标', '阴 · 25.7 °C', '1.97 m/s', '机场降雨', '预报湿度', '0.2 μg/m³', '> 1 μg/m³', '数据时间：', '天气时刻：']) expect(dialog.textContent).toContain(text);
    await click('取消');
    expect(action).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')).toBeNull();
    await click('立即执行任务');
    await click('确认执行任务');
    expect(action).toHaveBeenCalledExactlyOnceWith('launch_flight');
    expect(document.querySelector('dialog')).toBeNull();
  });
  it.each([[null, 1, '缺测'], [2, 4, '已过期'], [2, -1, '时间异常'], [NaN, 1, '数值异常']] as const)('does not call unavailable potassium data normal (%s, %s)', async (k, age, message) => {
    const action = await render(data(k, age));
    await click('立即执行任务');
    expect(document.querySelector('dialog')?.textContent).toContain(message);
    expect(document.querySelector('dialog')?.textContent).toContain('无法判断');
    expect(document.querySelector('dialog')?.textContent).not.toContain('未超标');
    expect(action).not.toHaveBeenCalled();
  });
  it('preserves zero and treats equality to the threshold as no warning', async () => {
    const d = data(0); const action = await render(d);
    await click('立即执行任务');
    expect(document.querySelector('dialog')?.textContent).toContain('0 μg/m³');
    expect(document.querySelector('dialog')?.textContent).toContain('未超标');
    await click('取消');
    d.rows[0].potassium = 1; await render(d, action);
    await click('立即执行任务');
    expect(document.querySelector('dialog')?.textContent).toContain('未超标');
    expect(action).not.toHaveBeenCalled();
  });
  it('preserves the existing launch flow for a valid exceedance warning', async () => {
    const action = await render(data(2));
    await click('立即执行任务');
    expect(action).toHaveBeenCalledExactlyOnceWith('launch_flight');
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('blocks confirmation when readiness, weather, or task state changes', async () => {
    const d = data(); const action = await render(d);
    await click('立即执行任务');
    await render(d, action, false);
    expect(button('确认执行任务').hasAttribute('disabled')).toBe(true);
    await click('确认执行任务');
    d.weather!.allowed = false; await render(d, action);
    expect(button('确认强制起飞').hasAttribute('disabled')).toBe(true);
    await click('确认强制起飞');
    d.weather!.allowed = true;
    d.flight.event = { id: 'another-task', observedAt: '', potassium: 2, name: '巡飞任务', status: 'preparing', error: null, preview: false };
    await render(d, action);
    expect(document.querySelector('dialog')).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });
  it('expires weather while the dialog is open', async () => {
    const action = await render(data());
    await click('立即执行任务');
    await act(async () => vi.advanceTimersByTime(601000));
    expect(button('确认强制起飞').hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('气象数据不可用');
    await click('确认强制起飞');
    expect(action).not.toHaveBeenCalled();
  });
  it('exposes a failed weather task and requires on-site confirmation before a single manual override', async () => {
    const d = data(2);
    d.weather!.allowed = false; d.weather!.level = 'caution'; d.weather!.current!.windGusts = 7; d.weather!.reasons = ['阵风 7.0 m/s，需人工确认并现场复核'];
    d.flight.event = { id: 'failed-auto', observedAt: '', potassium: 2, name: '原自动任务', status: 'failed', error: '天气条件未通过', preview: false, source: 'auto' };
    const action = await render(d);
    expect(button('手动强制起飞').hasAttribute('disabled')).toBe(false);
    await click('手动强制起飞');
    expect(action).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')?.textContent).toContain('阵风 7.0 m/s');
    expect(button('确认强制起飞').hasAttribute('disabled')).toBe(true);
    await click('确认强制起飞');
    expect(action).not.toHaveBeenCalled();
    const checkbox = document.querySelector<HTMLInputElement>('.manual-launch-override input')!;
    await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); });
    expect(button('确认强制起飞').hasAttribute('disabled')).toBe(false);
    await click('确认强制起飞');
    expect(action).toHaveBeenCalledExactlyOnceWith('launch_flight', { retryEventId: 'failed-auto', weatherOverrideConfirmed: true });
    expect(action).not.toHaveBeenCalledWith('dismiss_flight', expect.anything());
    expect(document.querySelector('dialog')).toBeNull();
    // The next attempt requires another confirmation, even with the same weather.
    d.flight.event = null; await render(d, action); await click('手动强制起飞');
    expect(button('确认强制起飞').hasAttribute('disabled')).toBe(true);
  });
  it('restarts a failed task without a weather override after the weather recovers', async () => {
    const d = data(2);
    d.flight.event = { id: 'failed-auto', observedAt: '', potassium: 2, name: '原自动任务', status: 'failed', error: '天气条件未通过', preview: false, source: 'auto' };
    const action = await render(d); await click('重新发起任务');
    expect(action).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')?.textContent).toContain('原任务未发送起飞请求');
    expect(document.querySelector('.manual-launch-override')).toBeNull();
    await click('确认执行任务');
    expect(action).toHaveBeenCalledExactlyOnceWith('launch_flight', { retryEventId: 'failed-auto' });
  });
  it('rejects a stale retry confirmation when a different failed task replaces it', async () => {
    const d = data(2);
    d.flight.event = { id: 'original', observedAt: '', potassium: 2, name: '原任务', status: 'failed', error: '', preview: false };
    const action = await render(d); await click('重新发起任务');
    d.flight.event = { ...d.flight.event, id: 'replacement' }; await render(d, action);
    expect(button('确认执行任务').hasAttribute('disabled')).toBe(true);
    await click('确认执行任务');
    expect(action).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')?.textContent).toContain('原任务已变化');
  });
  it('prevents duplicate requests and leaves a failed confirmation available to retry', async () => {
    let finish!: (success: boolean) => void;
    const action = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await render(data(), action); await click('立即执行任务');
    const confirm = button('确认执行任务');
    await act(async () => { confirm.click(); confirm.click(); });
    expect(action).toHaveBeenCalledTimes(1);
    expect(button('正在发起…').hasAttribute('disabled')).toBe(true);
    await act(async () => finish(false));
    expect(document.querySelector('dialog')?.textContent).toContain('巡查任务未能发起');
    expect(button('确认执行任务').hasAttribute('disabled')).toBe(false);
  });
  it('dismisses with Escape without sending a flight request', async () => {
    const action = await render(data()); await click('立即执行任务');
    await act(async () => document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true })));
    expect(document.querySelector('dialog')).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });
});
