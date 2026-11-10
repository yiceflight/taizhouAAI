import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let SettingsDialog: typeof import('../src/components/SettingsDialog').SettingsDialog;
import { defaultSettings } from '../src/lib/workspace';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ipc);
vi.mock('../src/components/EmailSettingsSection', () => ({ EmailSettingsSection: () => null }));
let root: ReturnType<typeof createRoot>;
const onClose = vi.fn();
const onSaved = vi.fn(async () => {});
beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  vi.stubGlobal('HTMLFormElement', window.HTMLFormElement);
  vi.stubGlobal('DocumentFragment', function () { return window.document.createDocumentFragment(); });
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('getComputedStyle', () => ({ animationName: 'none', display: 'block' }));
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Import after installing the DOM so Radix enables its browser layout effects.
  ({ SettingsDialog } = await import('../src/components/SettingsDialog'));
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
  const trigger = document.querySelector<HTMLButtonElement>('#flight-route')!;
  const select = trigger.parentElement!.querySelector<HTMLSelectElement>('select')!;
  expect(trigger.textContent).toBe('东南火点巡查航线-改');
  expect([...select.options].map(option => option.textContent)).toEqual(['东南火点巡查航线-改', '东南火点巡查航线-改-副本(6)']);
  ipc.invoke.mockResolvedValueOnce({ routes: [{ routeId: 'r2', name: '东南火点巡查航线-改-副本(6)' }], selected: '东南火点巡查航线-改-副本(6)' });
  await act(async () => { select.options[1].selected = true; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  expect(ipc.invoke).toHaveBeenCalledWith('set_flight_route', { route: '东南火点巡查航线-改-副本(6)' });
});
it('configures eight Chinese wind choices and persists the matching sector', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} routes={[{ routeId: 'r1', name: '东南航线' }, { routeId: 'r2', name: '西北航线' }]} selectedRoute="东南航线" onClose={onClose} onSaved={onSaved} />));
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '＋ 添加风向规则')!.click());
  expect(document.querySelector('[aria-label="第 1 条风向规则开始角度"]')).toBeNull();
  const direction = document.querySelector<HTMLSelectElement>('[aria-label="第 1 条风向规则风向"]')!;
  expect([...direction.options].map(option => option.textContent)).toEqual(['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风']);
  await act(async () => { direction.options[1].selected = true; direction.dispatchEvent(new window.Event('change', { bubbles: true })); });
  expect(document.querySelector('[aria-label="第 1 条风向规则航线"]')?.textContent).toBe('东南航线');
  await submit();
  expect(ipc.invoke).toHaveBeenCalledWith('save_workspace_settings', { settings: expect.objectContaining({ windRouteRules: [{ startDegrees: 22.5, endDegrees: 67.5, route: '东南航线' }] }) });
});
it('allows no wind rules when a synced default route is selected', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} routes={[{ routeId: 'r1', name: '东南航线' }]} selectedRoute="东南航线" onClose={onClose} onSaved={onSaved} />));
  await submit();
  expect(document.querySelector('label[for="flight-route"]')?.textContent).toContain('默认航线');
  expect(document.querySelector('input[name="route-selection-mode"]')).toBeNull();
  expect(ipc.invoke.mock.calls[0][1].settings).not.toHaveProperty('routeSelectionMode');
  expect(ipc.invoke).toHaveBeenCalledWith('save_workspace_settings', { settings: expect.objectContaining({windRouteRules:[]}) });
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it('keeps the sync prompt only before the first route sync', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} onClose={onClose} onSaved={onSaved} />));
  const unsynced = document.querySelector<HTMLButtonElement>('#flight-route')!;
  expect(unsynced.textContent).toBe('请先同步航线列表');
  expect(unsynced.disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} routes={[{ routeId: 'r1', name: '东南火点巡查航线' }]} routesSyncedAt={Date.now()} onClose={onClose} onSaved={onSaved} />));
  const synced = document.querySelector<HTMLButtonElement>('#flight-route')!;
  expect(synced.textContent).toBe('请选择航线');
  expect(synced.disabled).toBe(false);
  expect(document.body.textContent).not.toContain('请先同步航线列表');
});
it('uses a matching-height refresh icon and shows its spinning state while syncing', async () => {
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} flightReady routes={[{ routeId: 'r1', name: '东南火点巡查航线-改' }]} selectedRoute="东南火点巡查航线-改" onClose={onClose} onSaved={onSaved} />));
  const trigger = document.querySelector<HTMLButtonElement>('#flight-route')!;
  const refresh = document.querySelector<HTMLButtonElement>('[aria-label="同步司空航线"]')!;
  expect(trigger.classList.contains('route-select-trigger')).toBe(true);
  expect(trigger.getAttribute('role')).toBe('combobox');
  expect(refresh.classList.contains('settings-route-sync')).toBe(true);
  expect(refresh.querySelector('svg.refresh-icon')?.classList.contains('is-spinning')).toBe(false);
  let resolveSync!: (value: unknown) => void;
  ipc.invoke.mockImplementationOnce(() => new Promise(resolve => { resolveSync = resolve; }));
  await act(async () => { refresh.click(); await Promise.resolve(); });
  expect(document.querySelector('[aria-label="正在同步航线"] svg.refresh-icon')?.classList.contains('is-spinning')).toBe(true);
  await act(async () => resolveSync({ routes: [], selected: '东南火点巡查航线-改' }));
});

it('requires explicit reselection of legacy angle rules without silently changing them', async () => {
  const legacy = { ...defaultSettings, routeSelectionMode: 'wind' as const, windRouteRules: [{startDegrees:0,endDegrees:45,route:'东南航线'}] };
  await act(async () => root.render(<SettingsDialog settings={legacy} selectedRoute="东南航线" routes={[{routeId:'r1',name:'东南航线'}]} onClose={onClose} onSaved={onSaved} />));
  const direction = document.querySelector<HTMLSelectElement>('[aria-label="第 1 条风向规则风向"]')!;
  expect(direction.value).toBe('');
  expect(document.body.textContent).toContain('存在旧版自定义角度规则');
  await submit();
  expect(ipc.invoke).not.toHaveBeenCalled();
  await act(async () => { direction.options[1].selected = true; direction.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await submit();
  expect(ipc.invoke).toHaveBeenCalledWith('save_workspace_settings', {settings:expect.objectContaining({windRouteRules:[{startDegrees:337.5,endDegrees:22.5,route:'东南航线'}]})});
  expect(legacy.windRouteRules[0]).toEqual({startDegrees:0,endDegrees:45,route:'东南航线'});
});
it('offers each direction once and limits the list to eight rules', async () => {
  await act(async () => root.render(<SettingsDialog settings={{...defaultSettings,routeSelectionMode:'wind'}} selectedRoute="测试航线" routes={[{routeId:'r1',name:'测试航线'}]} onClose={onClose} onSaved={onSaved} />));
  for (let i=0;i<8;i++) await clickText('＋ 添加风向规则');
  expect([...document.querySelectorAll<HTMLSelectElement>('.wind-route-rule > label:first-child select')].map(select=>select.value)).toEqual(['N','NE','E','SE','S','SW','W','NW']);
  expect([...document.querySelectorAll('button')].find(button=>button.textContent==='＋ 添加风向规则')?.disabled).toBe(true);
  expect(document.querySelector<HTMLSelectElement>('[aria-label="第 1 条风向规则风向"]')!.options[1].hasAttribute('disabled')).toBe(true);
  await submit();
  expect(ipc.invoke.mock.calls[0][1].settings.windRouteRules).toHaveLength(8);
});
it('rejects duplicate saved sectors and routes no longer in the synced list', async () => {
  for (const rules of [
    [{startDegrees:22.5,endDegrees:67.5,route:'测试航线'},{startDegrees:22.5,endDegrees:67.5,route:'测试航线'}],
    [{startDegrees:22.5,endDegrees:67.5,route:'已删除航线'}],
  ]) {
    await act(async () => root.render(<SettingsDialog key={rules.length} settings={{...defaultSettings,routeSelectionMode:'wind',windRouteRules:rules}} selectedRoute="测试航线" routes={[{routeId:'r1',name:'测试航线'}]} onClose={onClose} onSaved={onSaved} />));
    await submit();
    expect(ipc.invoke).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  }
});

it('requires a synced default route in wind mode, even with matching rules', async () => {
  for (const selectedRoute of ['', '已删除航线']) {
    await act(async () => root.render(<SettingsDialog key={selectedRoute} settings={{...defaultSettings,routeSelectionMode:'wind',windRouteRules:[{startDegrees:337.5,endDegrees:22.5,route:'测试航线'}]}} routes={[{routeId:'r1',name:'测试航线'}]} selectedRoute={selectedRoute} onClose={onClose} onSaved={onSaved} />));
    await submit();
    expect(ipc.invoke).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('选择默认航线');
  }
});

it('shows and saves existing rules even for legacy fixed mode and allows removing the last rule', async () => {
  await act(async () => root.render(<SettingsDialog settings={{...defaultSettings,routeSelectionMode:'fixed',windRouteRules:[{startDegrees:22.5,endDegrees:67.5,route:'测试航线'}]}} routes={[{routeId:'r1',name:'测试航线'}]} selectedRoute="测试航线" onClose={onClose} onSaved={onSaved} />));
  expect(document.querySelector<HTMLSelectElement>('[aria-label="第 1 条风向规则风向"]')?.value).toBe('NE');
  await submit();
  expect(ipc.invoke.mock.calls[0][1].settings.windRouteRules).toHaveLength(1);
  expect(ipc.invoke.mock.calls[0][1].settings).not.toHaveProperty('routeSelectionMode');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="删除第 1 条风向规则"]')!.click());
  await submit();
  expect(ipc.invoke.mock.calls[1][1].settings.windRouteRules).toEqual([]);
  expect(document.body.textContent).toContain('将直接使用默认航线');
});

it('clears deleted route catalog after a successful data reset', async () => {
  const show = (cleared: boolean) => <SettingsDialog settings={defaultSettings}
    routes={cleared ? [] : [{routeId:'old',name:'已删除航线'}]} selectedRoute={cleared ? '' : '已删除航线'}
    onClose={onClose} onSaved={onSaved} onDataCleared={async () => {root.render(show(true));}} />;
  await act(async () => root.render(show(false)));
  await clickText('清空数据'); await clickText('确认清空数据');
  expect(document.body.textContent).toContain('本地数据已清空');
  expect(document.querySelector('#flight-route')?.textContent).not.toContain('已删除航线');
});

it('serializes route selection with clearing so a late selection cannot restore deleted routes', async () => {
  const routes=[{routeId:'a',name:'航线甲'},{routeId:'b',name:'航线乙'}];
  await act(async () => root.render(<SettingsDialog settings={defaultSettings} routes={routes} selectedRoute="航线甲" onClose={onClose} onSaved={onSaved} />));
  await clickText('清空数据');
  let finish!: (value: unknown) => void;
  ipc.invoke.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  const select=document.querySelector('#flight-route')!.parentElement!.querySelector<HTMLSelectElement>('select')!;
  await act(async () => { select.options[1].selected=true; select.dispatchEvent(new window.Event('change',{bubbles:true})); });
  // Programmatic clicks can bypass disabled fieldsets in a DOM fixture. The shared lock still rejects them.
  await clickText('确认清空数据');
  expect(ipc.invoke.mock.calls.map(call=>call[0])).toEqual(['set_flight_route']);
  await act(async () => finish({routes,selected:'航线乙'}));
  await clickText('确认清空数据');
  expect(ipc.invoke.mock.calls.map(call=>call[0])).toEqual(['set_flight_route','clear_all_data']);
  expect(document.querySelector('#flight-route')?.textContent).not.toContain('航线乙');
});


it.each([true, false])('preserves a single configured metric (potassium: %s)', async (potassiumEnabled) => {
  await act(async () => root.render(<SettingsDialog settings={{...defaultSettings, potassiumEnabled, pm25Enabled: !potassiumEnabled}} onClose={onClose} onSaved={onSaved} />));
  const blank = document.querySelector<HTMLInputElement>(potassiumEnabled ? '#pm25-threshold' : '#potassium-threshold')!;
  expect(blank.value).toBe('');
  expect(blank.required).toBeFalsy();
  await submit();
  expect(ipc.invoke).toHaveBeenCalledWith('save_workspace_settings', {settings:expect.objectContaining({potassiumEnabled, pm25Enabled: !potassiumEnabled})});
});
it('requires at least one configured metric', async () => {
  await act(async () => root.render(<SettingsDialog settings={{...defaultSettings, potassiumEnabled:false, pm25Enabled:false}} onClose={onClose} onSaved={onSaved} />));
  await submit();
  expect(ipc.invoke).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('请至少设置一个监测阈值');
});
