import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlightReportPanel } from '../src/components/FlightReportPanel';
import { missionOriginLabel, patrolTasks, type Mission, type FlightSummary, type FlightWeather, type LocalFlightEvent } from '../src/lib/flightReport';
import type { BrowserTab } from '../src/lib/workspace';
import type { WeatherCheck } from '../src/lib/weather';
const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ipc);
vi.mock('../src/lib/flightReport', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/flightReport')>(), flightCharts: () => ['chart', 'route'] }));
const first: Mission = { missionId: 11, missionName: '南侧巡飞', startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, geoLocation: '泰州' };
const second: Mission = { ...first, missionId: 12, missionName: '北侧巡飞' };
const saved = (mission = first): FlightSummary => ({ id: `report-${mission.missionId}`, title: mission.missionName, mission, createdAt: Date.now(), path: '/fixture.docx', photoCount: 0, pointCount: 2, warning: '', airUrl: `https://aai.airins.cn/sniff/HistoryCloud?missionId=${mission.missionId}`, mediaUrl: 'https://fh.dji.com/organization/org/project/project#/media?page=1&pid=folder-1' });
const tabs: BrowserTab[] = [
  { session: 'fixture', id: 1, title: '可飞', url: 'https://aai.airins.cn/sniff/HistoryCloud', status: 'complete' },
  { session: 'fixture', id: 2, title: '司空', url: 'https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/media', status: 'complete' },
];
let root: ReturnType<typeof createRoot>;
let reports: FlightSummary[];
let missions: Mission[];
let reasons: Record<string, string>;
let weather: Record<string, FlightWeather>;
let prepare: ReturnType<typeof vi.fn>;
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const render = async (ready = true, browserTabs = tabs) => { await act(async () => root.render(<FlightReportPanel tabs={browserTabs} ready={ready} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />)); };
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!); reports = [saved()]; missions = [first, second]; reasons = {}; weather = {}; prepare = vi.fn();
  ipc.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === 'list_flight_reports') return reports;
    if (command === 'list_flight_reasons') return reasons;
    if (command === 'set_flight_reason') { if (args.reason) reasons[args.missionId] = args.reason; else delete reasons[args.missionId]; return; }
    if (command === 'list_flight_weather') return weather;
    if (command === 'enrich_flight_weather') return { weather, error: null };
    if (command === 'list_flight_missions') return { missions, total: missions.length };
    if (command === 'collect_flight_report') return { mission: args.request.mission, air: { points: [{ pm25: 10 }, { pm25: 20 }] }, media: { folder: 'Immediate-Media' }, photos: [] };
    if (command === 'save_flight_report') return saved(args.data.mission);
  });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
describe('task-owned reports', () => {
  it('merges by mission ID, keeps latest report, preserves unknown legacy reports and same-name tasks', () => {
    const old = { ...saved(), id: 'old', createdAt: 1 };
    const legacy = { ...saved(), id: 'legacy', mission: null };
    const tasks = patrolTasks([first, { ...second, missionName: first.missionName }], [old, saved(), legacy]);
    expect(tasks).toHaveLength(3);
    expect(tasks.find(t => t.mission?.missionId === first.missionId)?.report?.id).toBe('report-11');
    expect(tasks.find(t => t.mission?.missionId === second.missionId)?.report).toBeNull();
    expect(tasks.find(t => t.key === 'report-legacy')?.report).toBe(legacy);
  });
  it('loads tasks and generates a report only for the selected row, then replaces its action with open', async () => {
    await render();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(document.querySelectorAll('tbody td:last-child button')).toHaveLength(2);
    expect(button('打开 Word')).toBeDefined();
    await click('生成报告');
    expect(document.querySelector('dialog[open]')?.textContent).toContain('北侧巡飞');
    expect(document.querySelector('dialog select')).toBeNull();
    expect(document.querySelector('.history-card dialog')).toBeNull();
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ mission: second }) }));
    await click('生成并保存 Word 快报');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect([...document.querySelectorAll('tbody td:last-child button')].map(b => b.textContent)).toEqual(['打开 Word', '打开 Word']);
    expect(button('生成报告')).toBeUndefined();
  });
  it('closes the modal without saving and shows collection errors inside it', async () => {
    await render(); await click('生成报告');
    ipc.invoke.mockRejectedValueOnce(new Error('未找到匹配航次'));
    await click('自动匹配并读取资料');
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('未找到匹配航次');
    await click('关闭');
    expect(document.querySelector('dialog')).toBeNull();
    expect(ipc.invoke).not.toHaveBeenCalledWith('save_flight_report', expect.anything());
  });
  it('automatically uses a media session even with multiple open folders and blocks dismissal while collecting', async () => {
    await render(true, [...tabs, { ...tabs[1], id: 3 }]); await click('生成报告');
    let finish!: (value: unknown) => void;
    ipc.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenLastCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ djiTabId: 2 }) }));
    expect(button('关闭').disabled).toBe(true);
    await act(async () => document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true, bubbles: true })));
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    await act(async () => finish({ mission: second, air: { points: [] }, media: { folder: '' }, photos: [] }));
    await click('关闭');
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('shows platform origin and persisted historical weather for each task', async () => {
    weather = { 11: { missionId: 11, startTime: first.startTime, observedAt: Math.floor(first.startTime / 3600000) * 3600,
      fetchedAt: Date.now() / 1000, source: 'Open-Meteo 历史预报', status: 'ok', temperature: 21.5,
      weatherCode: 3, windSpeed: 1.4, windGusts: 2.6, windDirection: 90, precipitation: 0 } };
    await render();
    expect(document.querySelector('tbody')?.textContent).toContain('司空平台任务');
    expect(document.querySelector('tbody')?.textContent).not.toContain('模型条件正常');
    expect(document.querySelector('tbody')?.textContent).not.toContain('Open-Meteo 历史预报');
    expect(document.querySelector('tbody')?.textContent).toContain('阴 · 21.5 °C');
    expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(0);
    expect(ipc.invoke).toHaveBeenCalledWith('enrich_flight_weather', { missions });
  });
  it('links each task to its Airins mission and persisted DJI media folder', async () => {
    await render();
    const row = document.querySelector('tbody tr')!;
    const links = [...row.querySelectorAll<HTMLAnchorElement>('.task-link')];
    expect(links.map(link => link.textContent)).toEqual(['可飞任务 ↗', '司空任务 ↗']);
    expect(links[0].href).toBe(`https://aai.airins.cn/sniff/HistoryCloud?missionId=${first.missionId}`);
    expect(links[1].href).toContain('#/media?page=1&pid=folder-1');
    expect(links.every(link => link.target === '_blank')).toBe(true);
  });
  it('classifies app-generated names and defaults other names to FlightHub', () => {
    expect(missionOriginLabel({ ...first, missionName: '钾离子超标巡查-20260923-05' })).toBe('本应用 · 自动巡查');
    expect(missionOriginLabel({ ...first, missionName: '手动巡查-20260923-05-ab123456' })).toBe('本应用 · 手动起飞');
    expect(missionOriginLabel({ ...first, missionName: '司空填写演练-20260923-05' })).toBe('本应用 · 填写演练');
    expect(missionOriginLabel(first)).toBe('司空平台任务');
  });
  it('highlights app missions including saved reports, while retaining platform and legacy rows', async () => {
    const automatic = { ...first, missionId: 21, missionName: '钾离子超标巡查-20261008-19' };
    const manual = { ...first, missionId: 22, missionName: '手动巡查-20261008-19-ab123456' };
    const preview = { ...first, missionId: 23, missionName: '司空填写演练-20261008-19' };
    missions = [automatic, manual, first];
    reports = [saved(automatic), saved(preview), { ...saved(), id: 'legacy', mission: null }];
    await render();
    const rows = [...document.querySelectorAll('tbody tr')];
    expect(rows.filter(row => row.classList.contains('task-row-app'))).toHaveLength(3);
    expect(rows.find(row => row.textContent?.includes(first.missionName))?.classList.contains('task-row-app')).toBe(false);
    expect(rows.find(row => row.textContent?.includes('历史报告'))?.classList.contains('task-row-app')).toBe(false);
  });
  it('shows a weather-rejected automatic event as not flown and not retrying', async () => {
    const flightEvent: LocalFlightEvent = { id: 'weather-blocked', name: '钾离子超标巡查-20261008-19', observedAt: '2026-10-08 19:00:00', source: 'auto', status: 'failed', error: '天气条件未通过：阵风 6.1 m/s，超过 6 m/s，需现场复核。' };
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready onPrepare={prepare} openAir={() => {}} openMedia={() => {}} flightEvent={flightEvent} />));
    const row = document.querySelector('.task-row-app')!;
    expect(row.textContent).toContain('本应用 · 自动巡查');
    expect(row.textContent).toContain('起飞未完成 · 待人工核验');
    expect(row.textContent).toContain('未起飞 · 新小时数据到达后重新判断');
    expect(row.textContent).toContain('巡查任务模块人工核验后重新发起');
    expect(row.textContent).toContain('尚无飞行记录');
    expect(row.textContent).toContain('触发数据时间');
    expect(row.textContent).not.toContain('手动起飞');
    expect(row.textContent).not.toContain('等待飞行结束');
    expect(row.textContent).not.toContain('至 尚未结束');
    expect(row.textContent).not.toContain('等待平台同步');
    expect(row.querySelector('td:last-child button')).toBeNull();
  });
  it('retains forbidden-hour records and old failures without duplicating the current event', async () => {
    const skipped: LocalFlightEvent = { id:'restricted-06',name:'钾离子超标巡查-20261009-06',observedAt:'2026-10-09 06:00:00',source:'auto',status:'restricted',error:'禁飞时间：05:00–08:00（北京时间），超标仅记录，不执行起飞。' };
    const failed: LocalFlightEvent = { id:'failed-05',name:'钾离子超标巡查-20261009-05',observedAt:'2026-10-09 05:00:00',source:'auto',status:'failed',error:'填写核对未通过' };
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready onPrepare={prepare} openAir={()=>{}} openMedia={()=>{}} flightEvent={skipped} flightRecords={[skipped,failed]} />));
    const rows=[...document.querySelectorAll('.task-row-app')];
    expect(rows).toHaveLength(2);
    expect(rows.filter(row=>row.textContent?.includes(skipped.name))).toHaveLength(1);
    expect(rows.find(row=>row.textContent?.includes(skipped.name))?.textContent).toContain('禁飞时间 · 仅记录');
    expect(rows.find(row=>row.textContent?.includes(failed.name))?.querySelector('details')?.textContent).toContain('填写核对未通过');
  });
  it('keeps the original outcome visible after local resolution without suggesting a live pending task', async () => {
    const event: LocalFlightEvent = { id: 'resolved-task', name: '已处理的原任务', observedAt: '2026-10-11 10:00:00', status: 'flight_error', source: 'auto', error: '司空显示任务执行终止', resolvedAt: Date.now() };
    await act(async () => root.render(<FlightReportPanel tabs={[]} ready={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} flightRecords={[event]} />));
    const row = document.querySelector('.task-row-app')!;
    expect(row.textContent).toContain('已结束处理 · 原状态：执飞异常');
    expect(row.textContent).toContain('司空显示任务执行终止');
    expect(row.textContent).toContain('结束处理时间');
    expect(row.textContent).toContain('已保留任务记录');
    expect(row.textContent).not.toContain('等待平台同步');
  });
  it('shows only creation weather offline even when legacy tasks contain later checks', async () => {
    const check: WeatherCheck = { stage: 'creation', checkedAt: 1791507600000, weather: {
      location: '泰州环境监测 Dock 3', latitude: 32.434525, longitude: 119.92992, source: 'Open-Meteo', refreshing: false,
      allowed: false, level: 'unsafe', label: '禁止起飞', reasons: ['阵风 12.3 m/s，达到 12 m/s，禁止起飞。'],
      current: { observedAt: 1791507300, fetchedAt: 1791507600, temperature: 23.9, weatherCode: 2, windSpeed: 2.73, windGusts: 12.3, windDirection: 90, precipitation: 0 },
    } };
    const event: LocalFlightEvent = { id: 'blocked', name: '钾离子超标巡查-20261009-09', observedAt: '2026-10-09 09:00:00', source: 'auto', status: 'failed', error: '天气条件未通过', weatherChecks: [check, { ...check, stage: 'preparation', weather: { ...check.weather, current: { ...check.weather.current!, temperature: 30.1 } } }, { ...check, stage: 'submission' }, { ...check, stage: 'failure' }] };
    await act(async () => root.render(<FlightReportPanel tabs={[]} ready={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} flightRecords={[event]} />));
    const row = document.querySelector('.task-row-app')!;
    expect(row.querySelector('.task-weather')?.textContent).toContain('多云 · 23.9 °C');
    expect(row.textContent).toContain('阵风 12.3 m/s');
    expect(row.textContent).toContain('禁止起飞');
    expect(row.textContent).toContain('任务创建时刻：');
    expect(row.textContent).toContain('天气数据时刻：');
    expect(row.querySelector('.task-weather details')).toBeNull();
    expect(row.textContent).not.toContain('查看天气详情');
    expect(row.textContent).not.toContain('查看天气记录');
    expect(row.textContent).not.toContain('30.1 °C');
    expect(row.textContent).not.toContain('异常记录');
    expect(row.textContent).toContain('数据时刻');
    expect(ipc.invoke).not.toHaveBeenCalledWith('refresh_weather');
    expect(ipc.invoke).not.toHaveBeenCalledWith('list_flight_missions', expect.anything());
  });
  it('records unavailable weather explicitly and retains local weather after platform mission sync', async () => {
    const event: LocalFlightEvent = { id: 'missing', name: first.missionName, observedAt: '2026-10-09 09:00:00', status: 'failed', weatherChecks: [{
      stage: 'creation', checkedAt: Date.now(), weather: { location: 'Dock 3', latitude: 32.434525, longitude: 119.92992, source: 'Open-Meteo', refreshing: false, allowed: false, level: 'unknown', label: '暂无法判断', reasons: ['天气获取超时，请稍后重试。'], current: null },
    }] };
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready onPrepare={prepare} openAir={() => {}} openMedia={() => {}} flightRecords={[event]} />));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    const row = [...document.querySelectorAll('tbody tr')].find(item => item.textContent?.includes(first.missionName))!;
    expect(row.querySelector('.task-weather')?.textContent).toContain('当时天气获取不可用');
    expect(row.querySelector('.task-weather')?.textContent).toContain('天气获取超时');
    expect(row.querySelector('.task-weather')?.textContent).not.toContain('天气条件通过');
    expect(patrolTasks([], [saved()], null, [event])[0].localEvent).toBe(event);
  });
  it('marks legacy tasks as unrecorded rather than presenting current or flight weather', async () => {
    const event: LocalFlightEvent = { id: 'legacy-local', name: '旧失败任务', observedAt: '2026-10-09 08:00:00', status: 'failed' };
    await act(async () => root.render(<FlightReportPanel tabs={[]} ready={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} flightRecords={[event]} />));
    expect(document.querySelector('.task-row-app .task-weather')?.textContent).toBe('当时天气未记录');
  });
  it('keeps local reports openable before readiness, without loading platform tasks', async () => {
    await render(false, []);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    await click('打开 Word');
    expect(ipc.invoke).toHaveBeenCalledWith('open_flight_report', { id: 'report-11' });
    expect(ipc.invoke).not.toHaveBeenCalledWith('list_flight_missions', expect.anything());
    await click('完成工作准备'); expect(prepare).toHaveBeenCalledOnce();
  });
  it('blocks report generation until the mission has ended and uploaded for at least a minute', async () => {
    reports = []; missions = [{ ...second, endTime: 0 }, { ...first, endTime: Date.now() }];
    await render();
    expect([...document.querySelectorAll('tbody td:last-child button')].every(b => b.hasAttribute('disabled'))).toBe(true);
    expect(document.querySelector('tbody')?.textContent).toContain('等待任务结束');
  });
  it('allows already-collected local data to be saved after disconnecting', async () => {
    await render(); await click('生成报告'); await click('自动匹配并读取资料');
    await render(false, []);
    expect(button('生成并保存 Word 快报').disabled).toBe(false);
    await click('生成并保存 Word 快报');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });
  it('discards collected data when its task source changes during the request', async () => {
    let finish!: (value: unknown) => void;
    await render(); await click('生成报告');
    ipc.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await click('自动匹配并读取资料');
    await render(false, []);
    await act(async () => finish({ mission: second, air: { points: [] }, media: { folder: '' }, photos: [] }));
    expect(button('生成并保存 Word 快报')).toBeUndefined();
    expect(document.body.textContent).toContain('任务页面已变化');
  });
});
