import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlightReportPanel } from '../src/components/FlightReportPanel';
import { DJI_MEDIA_URL, DJI_PLAN_URL, isTodayPatrolTask, localFlightTimeDisplay, missionOriginLabel, patrolTasks, visibleReportTasks, type Mission, type FlightSummary, type LocalFlightEvent } from '../src/lib/flightReport';
import type { BrowserTab } from '../src/lib/workspace';
import type { WeatherCheck } from '../src/lib/weather';
const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ipc);
vi.mock('../src/lib/flightReport', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/flightReport')>(), flightCharts: (data: { withoutAirData?: boolean }) => data.withoutAirData ? ['', ''] : ['chart', 'route'] }));
const first: Mission = { missionId: 11, missionName: '南侧巡飞', startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, geoLocation: '泰州' };
const second: Mission = { ...first, missionId: 12, missionName: '北侧巡飞' };
const completedWithoutAir: LocalFlightEvent = { id: 'bd1b9a5d-8792-445c-b7b0-02dc1d6c49bd', name: '无采样巡飞', observedAt: '2026-09-22 07:00:00', status: 'completed' };
const saved = (mission = first): FlightSummary => ({ id: `report-${mission.missionId}`, title: mission.missionName, mission, createdAt: Date.now(), path: '/fixture.docx', photoCount: 0, pointCount: 2, warning: '', airUrl: `https://aai.airins.cn/sniff/HistoryCloud?missionId=${mission.missionId}`, mediaUrl: 'https://fh.dji.com/organization/org/project/project#/media?page=1&pid=folder-1' });
const tabs: BrowserTab[] = [
  { session: 'fixture', id: 1, title: '可飞', url: 'https://aai.airins.cn/sniff/HistoryCloud', status: 'complete' },
  { session: 'fixture', id: 2, title: '司空', url: 'https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/media', status: 'complete' },
];
let root: ReturnType<typeof createRoot>;
let reports: FlightSummary[];
let missions: Mission[];
let reasons: Record<string, string>;
let prepare: ReturnType<typeof vi.fn>;
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const render = async (ready = true, browserTabs = tabs) => { await act(async () => root.render(<FlightReportPanel tabs={browserTabs} ready={ready} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />)); };
const useStableTestClock = () => vi.useFakeTimers({ now: Date.parse('2026-11-12T12:00:00+08:00') });
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!); reports = [saved()]; missions = [first, second]; reasons = {}; prepare = vi.fn();
  ipc.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === 'list_flight_reports') return reports;
    if (command === 'list_flight_reasons') return reasons;
    if (command === 'set_flight_reason') { if (args.reason) reasons[args.missionId] = args.reason; else delete reasons[args.missionId]; return; }
    if (command === 'list_flight_missions') return { missions, total: missions.length };
    if (command === 'collect_flight_report') return { withoutAirData: args.request.withoutAirData, localEventId: args.request.localEventId, mission: args.request.mission, air: { points: args.request.withoutAirData ? [] : [{ pm25: 10 }, { pm25: 20 }] }, media: { folder: 'Immediate-Media' }, photos: [] };
    if (command === 'save_flight_report') return { ...saved(args.data.mission), withoutAirData: args.data.withoutAirData, localEventId: args.data.localEventId };
  });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
describe('task-owned reports', () => {
  it('previews the annotated presentation and preserves both images when saving', async () => {
    await render(); await click('生成报告');
    const photo = { name: 'thermal.jpeg', kind: '司空原始照片', dataUrl: 'data:image/jpeg;base64,original',
      presentation: { method: 'dji-viewer-capture-v1', width: 1280, height: 1024, annotationCount: 2,
        labels: ['最高温度: 76.7℃', '最低温度: -2.5℃'], capturedAt: Date.now(), dataUrl: 'data:image/png;base64,annotated' } };
    ipc.invoke.mockResolvedValueOnce({ mission: second, air: { points: [] }, media: { folder: 'Immediate-Media' }, photos: [photo] });
    await click('自动匹配并读取资料');
    expect(document.querySelector('.flight-preview img')?.getAttribute('src')).toBe(photo.presentation.dataUrl);
    await click('生成并保存 Word 快报');
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ data: expect.objectContaining({ photos: [photo] }) }));
  });
  it('keeps a completed FlightHub receipt visible without inventing flight times from request or check times', async () => {
    missions = []; reports = [];
    const event = { ...completedWithoutAir, statusCheckedAt: Date.parse('2026-09-22T07:30:00+08:00') };
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready onPrepare={prepare} openAir={() => {}} openMedia={() => {}} flightEvent={event} />));
    const row = document.querySelector('tbody tr')!;
    expect(row.textContent).toContain('司空已确认飞行结束');
    expect(row.textContent).toContain('实际飞行时间待补全');
    expect(row.textContent).toContain('未关联可飞采样任务');
    expect(row.textContent).toContain('任务发起时间');
    expect(row.textContent).not.toContain('尚无飞行记录');
    expect(row.textContent).not.toContain('等待平台同步');
    expect(row.textContent).not.toContain('07:30:00');
    expect(row.querySelector<HTMLAnchorElement>('a')?.href).toBe(DJI_PLAN_URL);
    expect(row.querySelector('td:last-child button')?.textContent).toBe('生成报告');
    await click('生成报告');
    expect(document.querySelectorAll('dialog input[type="datetime-local"]')).toHaveLength(0);
    await click('补充时间');
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')].every(input => !input.value)).toBe(true);
  });
  it('filters failed DJI executions from the report list', async () => {
    missions = []; reports = [];
    const startTime = Date.parse('2026-09-22T09:00:00+08:00');
    const djiTask = { mission: { missionId: 0, missionName: '南侧上午9点航线巡查', startTime, endTime: 0, geoLocation: '' }, plannedStartTime: startTime, actualTimeMissing: true, status: '执行失败', mediaReady: false, noMedia: true, taskType: '自动任务', routeName: '南侧火点巡查航线-副本' };
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => command === 'list_dji_report_tasks' ? [djiTask] : original(command, args));
    await act(async () => root.render(<FlightReportPanel tabs={tabs.slice(1)} ready={false} mediaReady onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(document.querySelector('.history-card')?.textContent).toContain('0 个任务');
  });
  it('shows media counts and offers reports for explicit no-media flights', async () => {
    missions = []; reports = [];
    const start = Date.parse('2026-09-22T09:00:00+08:00');
    const task = (name: string, media: Partial<{ noMedia: boolean; mediaReady: boolean; mediaUploadedCount: number; mediaExpectedCount: number }>) => ({
      taskId: name,
      mission: { missionId: 0, missionName: name, startTime: start, endTime: start + 20 * 60000, geoLocation: '' },
      status: '执行成功', mediaReady: true, mediaUploadedCount: 0, mediaExpectedCount: 0, ...media,
    });
    const noMedia = task('无媒体巡飞', { noMedia: true });
    const withMedia = task('有媒体巡飞', { mediaUploadedCount: 12, mediaExpectedCount: 15 });
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => command === 'list_dji_report_tasks' ? [noMedia, { ...withMedia, taskId: 'with-media' }] : original(command, args));
    await render(false, tabs.slice(1));
    const rows = [...document.querySelectorAll('tbody tr')];
    const noMediaRow = rows.find(row => row.textContent?.includes('无媒体巡飞'))!;
    const withMediaRow = rows.find(row => row.textContent?.includes('有媒体巡飞'))!;
    expect(noMediaRow.querySelector('.task-media')?.textContent).toContain('无媒体文件');
    expect(noMediaRow.querySelector('.task-actions')?.textContent).toContain('生成报告');
    expect(noMediaRow.querySelector('.task-actions button')).not.toBeNull();
    expect(withMediaRow.querySelector('.task-media')?.textContent).toContain('媒体文件（12/15）');
  });
  it('does not render missing media counts as 0/0', async () => {
    missions = []; reports = [];
    const start = Date.parse('2026-09-22T09:00:00+08:00');
    const task = {
      taskId: 'unknown-media',
      mission: { missionId: 0, missionName: '数量待核对巡飞', startTime: start, endTime: start + 20 * 60000, geoLocation: '' },
      status: '执行成功', mediaReady: true, noMedia: false,
    };
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => command === 'list_dji_report_tasks' ? [task] : original(command, args));
    await render(false, tabs.slice(1));
    const media = document.querySelector('.task-media')?.textContent ?? '';
    expect(media).toContain('媒体已上传（数量待核对）');
    expect(media).not.toContain('0/0');
  });
  it('links each DJI task to its corresponding media folder', async () => {
    missions = []; reports = [];
    const start = Date.parse('2026-09-22T09:00:00+08:00');
    const task = {
      taskId: 'media-folder-task',
      mediaFolderId: 101,
      mission: { missionId: 0, missionName: '媒体目录巡飞', startTime: start, endTime: start + 20 * 60000, geoLocation: '' },
      status: '执行成功', mediaReady: true, noMedia: false,
    };
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => command === 'list_dji_report_tasks' ? [task] : original(command, args));
    await render(false, tabs.slice(1));
    const link = document.querySelector<HTMLAnchorElement>('.task-link');
    expect(link?.textContent).toBe('司空媒体库 ↗');
    expect(link?.href).toBe(`${DJI_MEDIA_URL}?page=1&size=50&pid=101`);
  });
  it('uses DJI as the date authority and removes Airins-only rows while retaining partial executions', () => {
    const start = Date.parse('2026-10-16T09:00:00+08:00');
    const dji = (id: string, offsetMinutes: number, status: string) => ({
      taskId: id,
      mission: { missionId: 0, missionName: `司空-${id}`, startTime: start + offsetMinutes * 60000, endTime: start + offsetMinutes * 60000 + 20 * 60000, geoLocation: '' },
      status, mediaReady: true,
    });
    const platform = [dji('ok-1', 0, '执行成功'), dji('partial-1', 60, '部分执行'), dji('ok-2', 120, '执行成功'), dji('failed-1', 180, '执行失败'), dji('failed-2', 240, '执行失败')];
    const rows = platform.map((task, index) => ({ key: `dji-${index}`, mission: task.mission, report: null, djiTask: task }));
    rows.push({ key: 'airins-extra-1', mission: { missionId: 101, missionName: '50634a31_2026-10-16 17:01:13', startTime: start + 8 * 60 * 60000, endTime: start + 8 * 60 * 60000 + 30 * 60000, geoLocation: '' }, report: null });
    rows.push({ key: 'airins-extra-2', mission: { missionId: 102, missionName: '50634a31_2026-10-16 15:01:16', startTime: start + 6 * 60 * 60000, endTime: start + 6 * 60 * 60000 + 34 * 60000, geoLocation: '' }, report: null });
    expect(visibleReportTasks(rows, platform)).toHaveLength(3);
    expect(visibleReportTasks(rows, platform).map(task => task.djiTask?.status)).toEqual(['执行成功', '部分执行', '执行成功']);
  });
  it('uses synchronized DJI times in the row and photo matching without manual input or Airins', async () => {
    missions = []; reports = [];
    const startTime = Date.parse('2026-09-22T20:19:00+08:00');
    const endTime = startTime + 1260000;
    const event: LocalFlightEvent = { ...completedWithoutAir, flightTime: { startTime, endTime, durationMs: 1260000, source: 'dji-plan', precision: 'minute' } };
    await act(async () => root.render(<FlightReportPanel tabs={tabs.slice(1)} ready={false} mediaReady flightEvent={event} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    const row = document.querySelector('tbody tr')!;
    expect(row.textContent).toContain('20:19');
    expect(row.textContent).toContain('20:40');
    expect(row.textContent).toContain('执行时长 21 分钟');
    expect(row.textContent).not.toContain('待补全');
    expect(row.textContent).toContain('未关联可飞采样任务');
    await click('生成报告');
    expect(document.querySelector('dialog')?.textContent).toContain('司空实际时间');
    expect(button('补充时间')).toBeUndefined();
    expect(button('修改时间')).toBeDefined();
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ withoutAirData: true, localEventId: event.id, mission: { missionId: 0, missionName: event.name, startTime, endTime, geoLocation: '' } }) }));
    expect(document.querySelector('dialog')?.textContent).not.toContain('请填写任务名称');
  });
  it('keeps the Airins mission ID while using actual DJI time for the report', async () => {
    reports = [];
    const event: LocalFlightEvent = { ...completedWithoutAir, name: first.missionName, flightTime: { startTime: first.startTime - 60000, endTime: first.endTime, durationMs: first.endTime - first.startTime + 60000, source: 'dji-plan', precision: 'minute' } };
    missions = [first];
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready flightEvent={event} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await click('生成报告');
    expect(document.querySelector('dialog')?.textContent).toContain('司空实际时间');
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ mission: { ...first, startTime: event.flightTime!.startTime } }) }));
  });
  it.each(['flying', 'paused', 'flight_error', 'submitted', 'submitting', 'uncertain'])('does not interpret missing sampling as no flight for %s', status => {
    expect(localFlightTimeDisplay({ ...completedWithoutAir, status }).label).not.toBe('尚无飞行记录');
  });
  it('refreshes sampling once when a flight completes and merges the matching task', async () => {
    missions = []; reports = [];
    const props = { tabs, ready: true, onPrepare: prepare, openAir() {}, openMedia() {} };
    await act(async () => root.render(<FlightReportPanel {...props} flightEvent={{ ...completedWithoutAir, status: 'flying' }} />));
    missions = [{ ...first, missionName: completedWithoutAir.name }];
    await act(async () => root.render(<FlightReportPanel {...props} flightEvent={completedWithoutAir} />));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'list_flight_missions')).toHaveLength(2);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(document.querySelector('tbody')?.textContent).not.toContain('实际飞行时间待补全');
    expect(button('生成报告')).toBeDefined();
    await act(async () => root.render(<FlightReportPanel {...props} flightEvent={{ ...completedWithoutAir }} flightRecords={[completedWithoutAir]} />));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'list_flight_missions')).toHaveLength(2);
  });
  it('refreshes late sampling records when returning to the task page', async () => {
    missions = []; reports = [];
    const props = { tabs, ready: true, onPrepare: prepare, openAir() {}, openMedia() {}, flightEvent: completedWithoutAir };
    await act(async () => root.render(<FlightReportPanel {...props} active />));
    await act(async () => root.render(<FlightReportPanel {...props} active={false} />));
    missions = [{ ...first, missionName: completedWithoutAir.name }];
    await act(async () => root.render(<FlightReportPanel {...props} active />));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'list_flight_missions')).toHaveLength(2);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(button('生成报告')).toBeDefined();
  });
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
    expect(document.querySelector('tbody tr .task-actual-time')?.textContent).toContain('至');
    expect(document.querySelector('tbody tr .task-actual-time')?.textContent).not.toContain('结束');
    expect(document.querySelectorAll('tbody td:last-child button')).toHaveLength(5);
    expect(button('打开 Word')).toBeDefined();
    await click('生成报告');
    expect(document.querySelector('dialog[open]')?.textContent).toContain('北侧巡飞');
    expect(document.querySelector('dialog select')).toBeNull();
    expect(document.querySelector('.history-card dialog')).toBeNull();
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ mission: second }) }));
    await click('生成并保存 Word 快报');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect([...document.querySelectorAll('tbody td:last-child button')].map(b => b.textContent)).toEqual(['打开 Word', '重新发送邮件', '打开文件夹', '重新生成报告', '打开 Word', '重新发送邮件', '打开文件夹', '重新生成报告']);
    expect(button('生成报告')).toBeUndefined();
  });
  it('clears cached task rows after the local data reset completes', async () => {
    await render();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    await act(async () => root.render(<FlightReportPanel dataResetKey={1} tabs={tabs} ready onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(document.querySelector('.history-card')?.textContent).toContain('0 个任务');
  });
  it('uses the same primary action and dialog for tasks with and without Airins data', async () => {
    reports = [];
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready flightRecords={[completedWithoutAir]} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    const actions = [...document.querySelectorAll<HTMLButtonElement>('tbody td:last-child button')];
    expect(actions).toHaveLength(3);
    expect(actions.every(action => action.textContent === '生成报告' && action.className === 'primary-button')).toBe(true);
    await act(async () => actions[2].click());
    expect(document.querySelector('dialog')?.textContent).toContain('按飞行时间查找可飞历史采样');
    expect(button('自动匹配并读取资料')).toBeDefined();
    expect(document.querySelectorAll('dialog')).toHaveLength(1);
    expect(document.querySelectorAll('dialog input[type="datetime-local"]')).toHaveLength(0);
    const labels = [...document.querySelectorAll('.report-material-label')].map(item => item.textContent);
    expect(labels).toEqual(['飞行时间北京时间', '司空照片', '可飞采样']);
    expect(document.querySelector('.report-dialog-footer button')?.textContent).toBe('自动匹配并读取资料');
    await click('关闭');
    await click('生成报告');
    expect(document.querySelector('dialog')?.textContent).not.toContain('暂无可飞数据');
    expect(document.querySelectorAll('dialog input[type="datetime-local"]')).toHaveLength(0);
    expect([...document.querySelectorAll('.report-material-label')].map(item => item.textContent)).toEqual(labels);
    expect(document.querySelector('.report-dialog-footer button')?.textContent).toBe('自动匹配并读取资料');
  });
  it('regenerates from the report row and opens the newly saved version', async () => {
    await render();
    const row = button('打开 Word').closest('tr')!;
    expect([...row.querySelectorAll('td:last-child button')].map(b => b.textContent)).toEqual(['打开 Word', '重新发送邮件', '打开文件夹', '重新生成报告']);
    expect(row.querySelector('.task-action-list')).toBeDefined();
    expect(row.querySelectorAll('.task-action-link')).toHaveLength(3);
    await click('重新生成报告');
    expect(document.querySelector('dialog')?.textContent).toContain('重新生成巡飞报告');
    expect(document.querySelector('dialog')?.textContent).toContain(first.missionName);
    await click('自动匹配并读取资料');
    ipc.invoke.mockResolvedValueOnce({ ...saved(first), id: 'new-version', createdAt: Date.now() + 1 });
    await click('生成并保存 Word 快报');
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ regenerate: true, data: expect.objectContaining({ mission: first }) }));
    await click('打开 Word');
    expect(ipc.invoke).toHaveBeenCalledWith('open_flight_report', { id: 'new-version' });
    await click('打开文件夹');
    expect(ipc.invoke).toHaveBeenCalledWith('open_flight_report_directory', { id: 'new-version' });
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    await click('生成报告');
    await click('自动匹配并读取资料');
    await click('生成并保存 Word 快报');
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ regenerate: false, data: expect.objectContaining({ mission: second }) }));
  });
  it('prefills confirmed flight times when regenerating a report without Airins data', async () => {
    missions = [];
    const mission = { ...first, missionId: 0, missionName: completedWithoutAir.name };
    reports = [{ ...saved(mission), withoutAirData: true, localEventId: completedWithoutAir.id }];
    await act(async () => root.render(<FlightReportPanel tabs={[tabs[1]]} ready={false} mediaReady flightRecords={[completedWithoutAir]} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await click('重新生成报告');
    expect(document.querySelector('dialog')?.textContent).toContain('暂无可飞数据');
    expect(document.querySelectorAll('dialog input[type="datetime-local"]')).toHaveLength(0);
    await click('修改时间');
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')].every(input => !!input.value)).toBe(true);
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ withoutAirData: true, localEventId: completedWithoutAir.id, mission }) }));
    await click('生成并保存 Word 快报');
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ regenerate: true, charts: ['', ''] }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
  });
  it('retries historical association when regenerating a photo-only report', async () => {
    const historical = { ...first, missionId: 0, startTime: first.startTime - 7 * 86400000, endTime: first.endTime - 7 * 86400000 };
    const sampling = { ...historical, missionId: 88, startTime: historical.startTime + 78000, missionName: '自动采样时间戳' };
    reports = [{ ...saved(historical), withoutAirData: true }];
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'list_flight_missions') return { missions: args.cursorId ? [sampling] : [first], total: 2 };
      return original(command, args);
    });
    await render(); await click('重新生成报告');
    expect(document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.checked).toBeFalsy();
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('list_flight_missions', expect.objectContaining({ cursorId: first.missionId, cursorTime: first.startTime }));
    const request = ipc.invoke.mock.calls.find(([command]) => command === 'collect_flight_report')![1].request;
    expect(request.withoutAirData).toBeUndefined();
    expect(request.mission).toEqual({ ...historical, missionId: 88 });
    await click('生成并保存 Word 快报');
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ regenerate: true, charts: ['chart', 'route'] }));
  });
  it('rechecks history when retrying after a completed lookup found no sampling', async () => {
    missions = []; reports = [{ ...saved({ ...first, missionId: 0 }), withoutAirData: true }];
    await render(); await click('重新生成报告'); await click('自动匹配并读取资料');
    expect(document.querySelector('dialog')?.textContent).toContain('未找到匹配采样');
    missions = [first];
    await click('重新匹配资料'); await click('自动匹配并读取资料');
    const calls = ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report');
    expect(calls).toHaveLength(2);
    expect(calls[0][1].request.withoutAirData).toBe(true);
    expect(calls[1][1].request.withoutAirData).toBeUndefined();
    expect(calls[1][1].request.mission.missionId).toBe(first.missionId);
  });
  it('does not inherit the blank-data flag after an existing report is associated', async () => {
    missions = [first]; reports = [{ ...saved(first), withoutAirData: true }];
    await render(); await click('重新生成报告'); await click('自动匹配并读取资料');
    const request = ipc.invoke.mock.calls.find(([command]) => command === 'collect_flight_report')![1].request;
    expect(request.withoutAirData).toBeUndefined();
    expect(request.mission.missionId).toBe(first.missionId);
  });
  it('does not silently generate a blank report when historical lookup fails', async () => {
    missions = []; reports = [{ ...saved({ ...first, missionId: 0 }), withoutAirData: true }];
    await render(); await click('重新生成报告');
    ipc.invoke.mockRejectedValueOnce(new Error('历史查询网络中断'));
    await click('自动匹配并读取资料');
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('历史查询网络中断');
    expect(ipc.invoke.mock.calls.some(([command]) => command === 'collect_flight_report')).toBe(false);
  });
  it('explicitly skips unavailable Airins data for an existing mission and saves blank charts', async () => {
    await render(); await click('生成报告');
    ipc.invoke.mockRejectedValueOnce(new Error('可飞未返回任务数据'));
    await click('自动匹配并读取资料');
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('可飞未返回任务数据');
    const checkbox = document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!;
    await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); });
    expect(document.querySelector('dialog')?.textContent).toContain('暂无可飞数据');
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', { request: { djiSession: 'fixture', djiTabId: 2, mediaKey: `mission-${second.startTime}-${second.endTime}`, withoutAirData: true, localEventId: null, mission: second } });
    expect(document.querySelector('dialog')?.textContent).toContain('报告对应内容留空');
    expect(document.querySelector('dialog')?.textContent).not.toContain('全部为 0');
    await click('生成并保存 Word 快报');
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ charts: ['', ''], data: expect.objectContaining({ withoutAirData: true }) }));
  });
  it('generates without an Airins tab or monitoring readiness using explicit Beijing flight times', async () => {
    reports = [];
    await act(async () => root.render(<FlightReportPanel tabs={[tabs[1]]} ready={false} mediaReady flightRecords={[completedWithoutAir]} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    expect(document.querySelector('.page-heading')?.textContent).not.toContain('无可飞数据生成报告');
    expect(document.querySelector('tbody td:last-child button')?.textContent).toBe('生成报告');
    await click('生成报告');
    expect(button('自动匹配并读取资料').disabled).toBe(false);
    await click('自动匹配并读取资料');
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('实际飞行起止时间');
    expect(ipc.invoke.mock.calls.some(([command]) => command === 'collect_flight_report')).toBe(false);
    expect(button('收起').getAttribute('aria-expanded')).toBe('true');
    const fields = [...document.querySelectorAll<HTMLInputElement>('dialog input')];
    await act(async () => {
      ['无采样巡飞', '2026-09-22T07:00:05', '2026-09-22T07:20:05'].forEach((value, i) => {
        fields[i].value = value; fields[i].dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    });
    await click('收起');
    expect(document.querySelectorAll('dialog input[type="datetime-local"]')).toHaveLength(0);
    expect(document.querySelector('.report-material-value')?.textContent).toContain('07:00:05');
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', { request: { djiSession: 'fixture', djiTabId: 2, mediaKey: `mission-${Date.parse('2026-09-22T07:00:05+08:00')}-${Date.parse('2026-09-22T07:20:05+08:00')}`, withoutAirData: true, localEventId: completedWithoutAir.id, mission: { missionId: 0, missionName: '无采样巡飞', startTime: Date.parse('2026-09-22T07:00:05+08:00'), endTime: Date.parse('2026-09-22T07:20:05+08:00'), geoLocation: '' } } });
    await click('生成并保存 Word 快报');
    expect(button('打开 Word')).toBeDefined();
    expect(document.querySelector('tbody')?.textContent).not.toContain('任务编号 0');
    expect(document.querySelector('tbody a')?.textContent).toBe('司空任务 ↗');
    expect(ipc.invoke).not.toHaveBeenCalledWith('list_flight_missions', expect.anything());
  });
  it('requires verified media readiness even in the mode without Airins', async () => {
    await act(async () => root.render(<FlightReportPanel tabs={[tabs[1]]} ready={false} flightRecords={[completedWithoutAir]} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await click('生成报告');
    expect(button('自动匹配并读取资料').disabled).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('登录司空媒体库');
  });
  it('keeps independent reports with no Airins ID and attaches a local event by its ID', () => {
    const event = { id: 'local-flight', name: '已完成巡飞', observedAt: '2026-09-22 07:00:00', status: 'completed' };
    const report = { ...saved({ ...first, missionId: 0 }), id: 'photo-only', withoutAirData: true, localEventId: event.id };
    const other = { ...report, id: 'other-flight', localEventId: null };
    const tasks = patrolTasks([], [report, other], event);
    expect(tasks).toHaveLength(2);
    expect(tasks.find(task => task.localEvent)?.report?.id).toBe(report.id);
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
  it('shows platform origin without backfilling historical weather', async () => {
    await render();
    expect(document.querySelector('tbody')?.textContent).toContain('司空平台任务');
    expect(document.querySelector('tbody')?.textContent).not.toContain('模型条件正常');
    expect(document.querySelector('tbody')?.textContent).toContain('司空平台任务无需记录天气');
    expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(0);
    expect(ipc.invoke).not.toHaveBeenCalledWith('list_flight_weather', expect.anything());
    expect(ipc.invoke).not.toHaveBeenCalledWith('enrich_flight_weather', expect.anything());
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
    await click('打开文件夹');
    expect(ipc.invoke).toHaveBeenCalledWith('open_flight_report_directory', { id: 'report-11' });
    expect(ipc.invoke).not.toHaveBeenCalledWith('list_flight_missions', expect.anything());
    await click('重新检查环境'); expect(prepare).toHaveBeenCalledOnce();
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

it('keeps cleared missions and reports hidden after reload while showing new tasks', () => {
  const cutoff = Date.now();
  const oldReport = { id: 'old', createdAt: cutoff - 1, mission: first } as FlightSummary;
  const laterReport = { ...oldReport, id: 'late', createdAt: cutoff + 1 };
  const newMission = { ...second, startTime: cutoff + 1 };
  const newEvent = { ...completedWithoutAir, id: 'new-event' };
  const tasks = patrolTasks([first, newMission], [oldReport, laterReport], newEvent, [], cutoff);
  expect(tasks.map(task => task.key).sort()).toEqual(['event-new-event', 'mission-12']);
});

describe('DJI scheduled flight automation', () => {
  afterEach(() => vi.useRealTimers());
  // Keep the fixture on the current Beijing date even when the suite runs
  // across midnight. The production rule is intentionally date-based, so a
  // module-level `Date.now() - 2h` fixture would become yesterday after 00:00
  // and make these timer tests fail intermittently.
  const external = (offset = 0) => {
    const endTime = Date.now() - 60 * 60 * 1000 - offset;
    return { mission: { ...first, missionId: 0, missionName: '每日7时南侧火点巡飞', startTime: endTime - 60 * 60 * 1000, endTime }, status: '执行成功', mediaReady: true };
  };
  it('limits automatic report generation to today while keeping older tasks manual', async () => {
    useStableTestClock(); reports = []; missions = [];
    const today = external();
    const yesterday = external(86400000);
    expect(isTodayPatrolTask({ key: 'today', mission: today.mission, report: null, djiTask: today }, Date.now())).toBe(true);
    expect(isTodayPatrolTask({ key: 'yesterday', mission: yesterday.mission, report: null, djiTask: yesterday }, Date.now())).toBe(false);
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [today, yesterday], skipped: 0, mediaTabId: 2 };
      const result = await original(command, args);
      if (command === 'save_flight_report') reports = [result];
      return result;
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs.slice(1)} ready={false} mediaReady active={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    const collected = ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report');
    expect(collected).toHaveLength(1);
    expect(collected[0][1]).toEqual(expect.objectContaining({ request: expect.objectContaining({ mission: today.mission }) }));
    expect(document.body.textContent).toContain('生成报告');
  });
  it('emails each automatically generated report and reports delivery errors on its task', async () => {
    useStableTestClock(); reports = []; missions = [];
    const today = external();
    const settings = { recipients: ['first@example.com', 'second@example.com'], username: 'report@dayialgo.com', configured: true };
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [today], skipped: 0, mediaTabId: 2 };
      if (command === 'get_email_settings') return settings;
      if (command === 'send_flight_report_email') throw new Error('SMTP 发送失败或结果未确认');
      return original(command, args);
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs.slice(1)} ready={false} mediaReady active={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(ipc.invoke).toHaveBeenCalledWith('send_flight_report_email', {
      reportId: 'report-0', recipients: settings.recipients,
      expectedRecipients: settings.recipients, expectedUsername: settings.username,
    });
    expect(document.querySelector('tbody tr')?.textContent).toContain('报告已生成，但邮件发送失败：SMTP 发送失败或结果未确认');
  });
  it('synchronizes older Airins pages to associate historical DJI executions', async () => {
    useStableTestClock(); reports = []; missions = [];
    const task = external(7 * 86400000);
    const sampling = { ...task.mission, missionId: 88, startTime: task.mission.startTime + 78000 };
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [task], skipped: 0 };
      if (command === 'list_flight_missions') return { missions: args.cursorId ? [sampling] : [first], total: 2 };
      return original(command, args);
    });
    await render(); await act(async () => vi.advanceTimersByTimeAsync(5000));
    const row = [...document.querySelectorAll('tbody tr')].find(row => row.textContent?.includes(task.mission.missionName))!;
    expect(row.querySelector('a')?.getAttribute('href')).toContain('missionId=88');
    expect(ipc.invoke.mock.calls.some(([command]) => command === 'collect_flight_report')).toBe(false);
  });
  it('serializes automatic DJI collection because all jobs share one media tab', async () => {
    useStableTestClock(); reports = []; missions = [];
    const firstTask = external();
    const secondTask = { ...external(15 * 60000), mission: { ...external(15 * 60000).mission, missionName: '每日8时南侧火点巡飞' } };
    let active = 0;
    let maxActive = 0;
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [firstTask, secondTask], skipped: 0, mediaTabId: 2 };
      if (command === 'collect_flight_report') {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
      }
      return original(command, args);
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs.slice(1)} ready={false} mediaReady active={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(maxActive).toBe(1);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(2);
  });
  it.each([false, true])('generates an external flight without Airins (noMedia=%s), then reuses the report', async noMedia => {
    useStableTestClock(); reports = []; missions = [];
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [{ ...external(), noMedia }], skipped: 0, mediaTabId: 2 };
      const result = await original(command, args);
      if (command === 'save_flight_report') reports = [result];
      return result;
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs.slice(1)} ready={false} mediaReady active={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ withoutAirData: true, noMedia, mission: external().mission }) }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(document.querySelector('tbody')?.textContent).toContain('司空平台任务');
    expect(document.querySelector('tbody')?.textContent).toContain('已生成报告');
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'save_flight_report')).toHaveLength(1);
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('retries failed collection and waits for upload completion, without stopping other flights', async () => {
    useStableTestClock(); reports = []; missions = [];
    let fail = true;
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [external(), { ...external(86400000), mediaReady: false }], skipped: 0, mediaTabId: 2 };
      if (command === 'collect_flight_report' && fail) { fail = false; throw new Error('网络暂时中断'); }
      const result = await original(command, args);
      if (command === 'save_flight_report') reports = [result];
      return result;
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready={false} mediaReady onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(document.querySelector('tbody')?.textContent).toContain('下轮重试');
    expect(document.body.textContent).toContain('等待媒体上传结束');
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(2);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'save_flight_report')).toHaveLength(1);
  });
  it.each(['司空媒体无照片：已完整解析 2 个视频文件，本航次未发现照片', '司空媒体解析失败：文件数量未核对完整', '照片尚未上传'])(
    'stops automatic retries after completed-upload media outcome: %s', async failure => {
    useStableTestClock(); reports = []; missions = [];
    let task = { ...external(), mediaFolderId: 123, mediaUploadedCount: 2, mediaExpectedCount: 2 };
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [task], skipped: 0, mediaTabId: 2 };
      if (command === 'collect_flight_report') throw new Error(failure);
      return original(command, args);
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready={false} mediaReady onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(document.querySelector('tbody')?.textContent).toContain('媒体上传已结束');
    expect(document.querySelector('tbody')?.textContent).not.toContain('等待媒体上传结束');
    expect(document.querySelector('tbody')?.textContent).not.toContain('照片尚未上传');
    if (failure.startsWith('司空媒体无照片')) expect(document.querySelector('tbody')?.textContent).toContain('无照片');
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(1);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'save_flight_report')).toHaveLength(0);
    const retry = [...document.querySelectorAll('button')].find(button => button.textContent === '重新读取媒体')!;
    expect(retry).toBeTruthy();
    await act(async () => retry.click());
    expect(document.querySelector('dialog')).not.toBeNull();
    await click('自动匹配并读取资料');
    if (failure.startsWith('司空媒体无照片')) {
      expect(document.querySelector('dialog [role="alert"]')).toBeNull();
      expect(document.querySelector('dialog [role="status"]')?.textContent).toContain('媒体上传已结束，无照片');
      expect(document.querySelector('dialog')?.textContent).not.toContain('Error:');
    } else {
      expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('媒体上传已结束');
    }
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(2);
    await act(async () => (document.querySelector('[aria-label="关闭生成报告弹窗"]') as HTMLButtonElement).click());
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(2);
    task = { ...task, mediaUploadedCount: 3, mediaExpectedCount: 3 };
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(3);
  });
  it('explains a media-ready partial execution retry as a media-page switch issue', async () => {
    useStableTestClock(); reports = []; missions = [];
    const original = ipc.invoke.getMockImplementation()!;
    const partial = { ...external(), status: '部分执行', partialReason: '2026-10-17 15:25:04 飞行器执行飞行任务过程中低电量返航，无法完成航线飞行（错误码：321773）' };
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [partial], skipped: 0, mediaTabId: 2 };
      if (command === 'collect_flight_report') throw new Error('司空列表切换未完成，请等待媒体库加载后重试');
      return original(command, args);
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs.slice(1)} ready={false} mediaReady active={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(document.querySelector('tbody')?.textContent).toContain(partial.partialReason);
    expect(document.querySelector('tbody')?.textContent).toContain('媒体已上传');
    expect(document.querySelector('tbody')?.textContent).toContain('媒体库页面切换未完成');
    expect(document.querySelector('tbody')?.textContent).not.toContain('等待媒体上传结束');
  });
  it('upgrades a partial report when sampling recovers, retries failures, and stops once complete', async () => {
    useStableTestClock(); reports = []; missions = [];
    const task = external();
    let failUpgrade = true;
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [task], skipped: 0, mediaTabId: 2 };
      if (command === 'collect_flight_report' && !args.request.withoutAirData && failUpgrade) {
        failUpgrade = false; throw new Error('采样暂未上传完');
      }
      const result = await original(command, args);
      if (command === 'save_flight_report') reports = [result, ...reports];
      return result;
    });
    const props = { tabs, active: false, mediaReady: true, onPrepare: prepare, openAir() {}, openMedia() {} };
    await act(async () => root.render(<FlightReportPanel {...props} ready={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reports[0].withoutAirData).toBe(true);
    const partialId = reports[0].id;
    missions = [{ ...task.mission, missionId: 99 }];
    await act(async () => root.render(<FlightReportPanel {...props} ready />));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(reports[0].id).toBe(partialId);
    expect(document.body.textContent).toContain('下轮重试');
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ regenerate: true, data: expect.objectContaining({ withoutAirData: false, mission: expect.objectContaining({ missionId: 99 }) }) }));
    expect(reports[0].withoutAirData).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'save_flight_report')).toHaveLength(2);
  });
  it('recovers automatic reports after initial saved-report loading fails', async () => {
    useStableTestClock(); reports = []; missions = [];
    let firstRead = true;
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'list_flight_reports' && firstRead) { firstRead = false; throw new Error('temporary read failure'); }
      if (command === 'sync_dji_report_tasks') return { tasks: [external()], skipped: 0, mediaTabId: 2 };
      return original(command, args);
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready={false} mediaReady onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.anything());
  });
  it('shows the grouped issue count on Word and no badge for zero issues', async () => {
    reports = [{ ...saved(), issueCount: 5 }, { ...saved(second), issueCount: 0 }];
    await render(false, []);
    expect(document.querySelectorAll('.report-issue-badge')).toHaveLength(1);
    expect(document.querySelector('.word-report-button .report-issue-badge')?.textContent).toBe('5');
    expect(document.querySelector('.report-issue-badge')?.getAttribute('aria-label')).toBe('5 个问题');
  });
  it('keeps identical daily names separate and merges a later Airins association with an existing photo report', () => {
    const today = external(), yesterday = external(86400000);
    expect(patrolTasks([], [], null, [], 0, [today, yesterday])).toHaveLength(2);
    const photoReport = { ...saved(today.mission), withoutAirData: true };
    const airMission = { ...today.mission, missionId: 99 };
    const tasks = patrolTasks([airMission], [photoReport], null, [], 0, [today]);
    expect(tasks).toHaveLength(1); expect(tasks[0].report).toBe(photoReport); expect(tasks[0].djiTask).toBe(today);
    expect(patrolTasks([], [], null, [], today.mission.startTime, [today, yesterday])).toHaveLength(0);
  });
});

describe('report interaction during background work', () => {
  afterEach(() => vi.useRealTimers());
  const planTabs = [tabs[0], { ...tabs[1], url: DJI_PLAN_URL }];
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  };
  it('collects and regenerates with only the project plan page open', async () => {
    await render(true, planTabs);
    await click('重新生成报告');
    expect(button('自动匹配并读取资料').disabled).toBe(false);
    await click('自动匹配并读取资料');
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ djiSession: 'fixture', djiTabId: 2, mission: first }) }));
    await click('生成并保存 Word 快报');
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ regenerate: true }));
  });
  it.each([
    { ...tabs[1], url: DJI_PLAN_URL.replace('/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49', '/project/another-project') },
    { ...tabs[1], url: DJI_PLAN_URL.replace('https://fh.dji.com', 'https://example.com') },
    { ...tabs[1], url: DJI_PLAN_URL, status: 'loading' },
  ])('explains the missing usable project page instead of silently disabling collection', async djiTab => {
    await render(true, [tabs[0], djiTab]);
    await click('重新生成报告');
    expect(button('自动匹配并读取资料').disabled).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('未找到当前项目的司空页面');
    expect(button('打开媒体库 ↗').disabled).toBe(false);
    expect(ipc.invoke.mock.calls.some(([command]) => command === 'collect_flight_report')).toBe(false);
  });
  it('regenerates with the associated DJI execution time and task ID while preserving the sampling ID', async () => {
    const actual = { ...first, missionId: 0, missionName: '南侧上午9点航线巡查' };
    const task = { taskId: 'dji-morning-flight', mission: actual, status: '执行成功', mediaReady: true };
    const sampling = { ...first, missionName: '50634a31_采样', startTime: first.startTime + 71000, endTime: first.endTime + 539000 };
    missions = [sampling]; reports = [saved(sampling)];
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => command === 'list_dji_report_tasks' ? [task] : original(command, args));
    await render(true, planTabs);
    await click('重新生成报告');
    expect(document.querySelector('dialog')?.textContent).toContain('司空实际时间');
    await click('自动匹配并读取资料');
    const mission = { ...sampling, missionName: actual.missionName, startTime: actual.startTime, endTime: actual.endTime };
    expect(ipc.invoke).toHaveBeenCalledWith('collect_flight_report', expect.objectContaining({ request: expect.objectContaining({ mission, mediaKey: task.taskId }) }));
    await click('生成并保存 Word 快报');
    expect(ipc.invoke).toHaveBeenCalledWith('save_flight_report', expect.objectContaining({ data: expect.objectContaining({ mission }), regenerate: true }));
  });
  it('keeps report actions and the manual dialog usable throughout a pending task refresh', async () => {
    const sync = deferred<unknown>();
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => command === 'sync_dji_report_tasks' ? sync.promise : original(command, args));
    await render(true, planTabs);
    await click('刷新任务');
    expect(button('正在读取…').disabled).toBe(true);
    for (const action of ['打开 Word', '重新发送邮件', '打开文件夹', '重新生成报告', '生成报告']) expect(button(action).disabled).toBe(false);
    await click('打开 Word'); await click('打开文件夹');
    expect(ipc.invoke).toHaveBeenCalledWith('open_flight_report', { id: 'report-11' });
    expect(ipc.invoke).toHaveBeenCalledWith('open_flight_report_directory', { id: 'report-11' });
    await click('重新生成报告');
    expect(button('关闭').disabled).toBe(false);
    await click('关闭');
    await click('重新生成报告');
    expect(button('自动匹配并读取资料').disabled).toBe(false);
    await click('自动匹配并读取资料');
    await act(async () => sync.resolve({ tasks: [], skipped: 1 }));
    expect(document.querySelector('dialog [role="status"]')?.textContent).toBe('资料读取完成，请核对后生成 Word 快报。');
    expect(document.querySelector('dialog')?.textContent).not.toContain('司空记录缺少实际飞行时间');
    expect(button('生成并保存 Word 快报').disabled).toBe(false);
    await click('生成并保存 Word 快报');
  });
  it('pauses automatic collection when the user opens the dialog during synchronization', async () => {
    useStableTestClock();
    const started = Date.parse('2026-11-12T11:40:00+08:00');
    const scheduled = { missionId: 91, missionName: '同步后结束的任务', startTime: started, endTime: started + 10 * 60000, geoLocation: '泰州' };
    missions = [{ ...first, startTime: started - 3600000, endTime: started - 3540000 }];
    reports = [saved(missions[0])];
    const sync = deferred<unknown>();
    let savedReport: FlightSummary | null = null;
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return sync.promise;
      if (command === 'save_flight_report') return savedReport = { ...saved(args.data.mission), id: 'saved-during-sync' };
      return original(command, args);
    });
    await render(true, planTabs);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    // Opening a report while the list is still synchronizing must stop the
    // background collector before that synchronization delivers a new task.
    await click('重新生成报告');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => sync.resolve({ tasks: [{ taskId: 'scheduled', mission: { ...scheduled, missionId: 0 }, status: '执行成功', mediaReady: true }], skipped: 0 }));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(0);
    await click('自动匹配并读取资料');
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(1);
    // The new task waits its turn; the user's dialog remains in control and
    // can be saved without the background collector clearing the preview.
    await click('生成并保存 Word 快报');
    expect(savedReport).not.toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'collect_flight_report')).toHaveLength(2);
  });
  it('does not replace a newly saved report with an older in-flight refresh response', async () => {
    const reportList = deferred<FlightSummary[]>();
    const original = ipc.invoke.getMockImplementation()!;
    await render(true, planTabs);
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks: [], skipped: 0 };
      if (command === 'list_flight_reports') return reportList.promise;
      if (command === 'save_flight_report') return { ...saved(), id: 'new-version' };
      return original(command, args);
    });
    await click('刷新任务');
    await click('重新生成报告');
    await click('自动匹配并读取资料');
    await click('生成并保存 Word 快报');
    await act(async () => reportList.resolve([saved()]));
    await click('打开 Word');
    expect(ipc.invoke).toHaveBeenLastCalledWith('open_flight_report', { id: 'new-version' });
  });
  it('blocks a second report action while automatic collection is running', async () => {
    useStableTestClock(); reports = []; missions = [];
    const task = (name: string, offset: number) => {
      const endTime = Date.now() - 60 * 60 * 1000 - offset;
      return { taskId: name, mission: { ...first, missionId: 0, missionName: name, startTime: endTime - 60 * 60 * 1000, endTime }, status: '执行成功', mediaReady: true };
    };
    const tasks = [task('后台首份报告', 0), task('手动选择的报告', 15 * 60000), task('下一份自动报告', 30 * 60000)];
    const collected = deferred<unknown>();
    const original = ipc.invoke.getMockImplementation()!;
    let active = 0, maxActive = 0, count = 0;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return { tasks, skipped: 0 };
      if (command === 'collect_flight_report') {
        count++; active++; maxActive = Math.max(maxActive, active);
        try { return count === 1 ? await collected.promise : await original(command, args); }
        finally { active--; }
      }
      return original(command, args);
    });
    await act(async () => root.render(<FlightReportPanel tabs={[planTabs[1]]} ready={false} mediaReady onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    // Let the scheduled report start and the row reflect its collecting state
    // before making the assertion; the request itself remains pending.
    await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(count).toBe(1);
    // The automatic collection still owns its row and no second request starts.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(count).toBe(1);
    expect(button('刷新任务').disabled).toBe(false);
    const row = [...document.querySelectorAll('tbody tr')].find(item => item.getAttribute('aria-busy') === 'true')!;
    // Automatic collection owns the report generation until it finishes. The
    // row's own action shows that state and cannot start a competing request.
    expect(row.querySelector('button')!.textContent).toBe('正在自动采集…');
    expect(row.querySelector('button')!.disabled).toBe(true);
    // A second collection would compete for the same platform pages, so all
    // manual report actions stay locked until the automatic job is finished.
    const sibling = [...document.querySelectorAll('tbody tr')].find(item => item.textContent?.includes('下一份自动报告'))!;
    expect(sibling.querySelector('button')!.textContent).toBe('正在自动采集…');
    expect(sibling.querySelector('button')!.disabled).toBe(true);
    await act(async () => (row.querySelector('button') as HTMLButtonElement).click());
    expect(document.querySelector('dialog')).toBeNull();
    expect(count).toBe(1);
    await act(async () => collected.resolve(await original('collect_flight_report', { request: { withoutAirData: true, mission: tasks[0].mission } })));
    expect(maxActive).toBe(1);
    expect(count).toBeGreaterThanOrEqual(2);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    // The manual report follows in the next automatic cycle, one at a time.
    expect(maxActive).toBe(1);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'save_flight_report').length).toBeGreaterThanOrEqual(2);
  });
});

describe('task history pagination', () => {
  const history = () => Array.from({ length: 121 }, (_, index) => ({
    mission: { ...first, missionId: 0, missionName: '每日定时巡飞', startTime: first.startTime - index * 86400000, endTime: first.endTime - index * 86400000 },
    status: '执行成功', mediaReady: false,
  }));
  const more = () => document.querySelector<HTMLButtonElement>('.load-earlier-button')!;
  const historyButton = () => [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('显示历史任务'))!;
  const nextPage = () => document.querySelector<HTMLButtonElement>('[aria-label="下一页任务"]')!;
  it('paginates cleared DJI history fifty at a time offline without changing the automatic-report cutoff', async () => {
    reports = []; missions = [];
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => command === 'list_dji_report_tasks' ? history() : original(command, args));
    const props = { tabs: [], ready: false, tasksClearedAt: first.startTime - 60000, onPrepare: prepare, openAir() {}, openMedia() {} };
    await act(async () => root.render(<FlightReportPanel {...props} />));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    await act(async () => historyButton().click());
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    await act(async () => nextPage().click());
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(document.body.textContent).toContain('第 2 / 3 页');
    await act(async () => nextPage().click());
    expect(document.querySelectorAll('tbody tr')).toHaveLength(21);
    expect(nextPage().disabled).toBe(true);
    expect(ipc.invoke.mock.calls.some(([command]) => command === 'collect_flight_report' || command === 'list_flight_missions')).toBe(false);
    await act(async () => root.render(<FlightReportPanel {...props} tasksClearedAt={first.startTime + 1} />));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(historyButton()).toBeTruthy();
  });
  it('allows local history expansion during a long automatic sync', async () => {
    reports = []; missions = [];
    let finish!: (value: unknown) => void;
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'list_dji_report_tasks') return history();
      if (command === 'sync_dji_report_tasks') return new Promise(resolve => { finish = resolve; });
      return original(command, args);
    });
    await act(async () => root.render(<FlightReportPanel tabs={tabs} ready={false} mediaReady tasksClearedAt={first.startTime - 60000} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
    await click('刷新任务');
    expect(button('正在读取…').disabled).toBe(true);
    await act(async () => historyButton().click());
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    await act(async () => nextPage().click());
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    await act(async () => finish({ tasks: history(), skipped: 0, mediaTabId: 2 }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(document.body.textContent).toContain('第 2 / 3 页');
  });
  it('loads the next Airins page even while DJI synchronization is busy', async () => {
    reports = []; missions = [first];
    let finish!: (value: unknown) => void;
    const original = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'sync_dji_report_tasks') return new Promise(resolve => { finish = resolve; });
      if (command === 'list_flight_missions') return { missions: args.cursorId ? [second] : [first], total: 2 };
      return original(command, args);
    });
    await render();
    await click('刷新任务');
    expect(more().disabled).toBe(false);
    await act(async () => more().click());
    expect(ipc.invoke).toHaveBeenCalledWith('list_flight_missions', expect.objectContaining({ cursorId: first.missionId, cursorTime: first.startTime }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    await act(async () => finish({ tasks: [], skipped: 0, mediaTabId: 2 }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});

describe('distinct nearby DJI executions', () => {
  const mission = { missionId: 0, missionName: '同名巡查', startTime: Date.now() - 3600000, endTime: Date.now() - 3480000, geoLocation: '' };
  const a = { mission, status: '执行终止', mediaReady: true };
  const b = { mission: { ...mission, startTime: mission.startTime + 240000, endTime: mission.endTime + 240000 }, status: '执行成功', mediaReady: true };
  it('uses the DJI plan name when Airins returns a generated timestamp name', () => {
    const airins = { ...mission, missionId: 88, missionName: '50634a31_2026-10-16 10:03:27' };
    const dji = { ...a, taskId: '00000000-0000-4000-8000-000000000088', mission: { ...mission, missionName: '南侧上午9点航线巡查' } };
    const tasks = patrolTasks([airins], [], null, [], 0, [dji]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].djiTask).toBe(dji);
    expect(tasks[0].mission?.missionName).toBe('南侧上午9点航线巡查');
    const report = { ...saved({ ...airins, missionId: 0 }), withoutAirData: true };
    const withReport = patrolTasks([airins], [report], null, [], 0, [dji]);
    expect(withReport).toHaveLength(1);
    expect(withReport[0].report).toBe(report);
    expect(withReport[0].mission?.missionName).toBe('南侧上午9点航线巡查');
  });
  it('associates a unique start-time match when Airins and DJI end times differ', () => {
    const airins = {
      ...mission,
      missionId: 88,
      missionName: '50634a31_2026-10-17 09:01:13',
      startTime: mission.startTime + 60_000,
      endTime: mission.endTime + 9 * 60_000,
    };
    const dji = {
      ...a,
      taskId: '00000000-0000-4000-8000-000000000089',
      mission: { ...mission, missionName: '南侧上午9点航线巡查' },
    };
    const tasks = patrolTasks([airins], [], null, [], 0, [dji]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].djiTask).toBe(dji);
    expect(tasks[0].mission?.missionId).toBe(88);
    expect(tasks[0].mission?.missionName).toBe('南侧上午9点航线巡查');
  });
  it('keeps both executions and associates each saved photo report with its exact flight', () => {
    const report = { ...saved(mission), withoutAirData: true };
    for (const incoming of [[a, b], [b, a]]) {
      const tasks = patrolTasks([], [report], null, [], 0, incoming);
      expect(tasks).toHaveLength(2);
      expect(tasks.find(t => t.djiTask === a)?.report).toBe(report);
      expect(tasks.find(t => t.djiTask === b)?.report).toBeNull();
      for (const task of tasks) expect(task.mission).toEqual(task.djiTask?.mission);
    }
  });
  it('does not guess when two DJI flights could both match one Airins mission', () => {
    const tasks = patrolTasks([{ ...mission, missionId: 88 }], [], null, [], 0, [a, b]);
    expect(tasks).toHaveLength(3);
    expect(tasks.find(t => t.mission?.missionId === 88)?.djiTask).toBeUndefined();
    expect(tasks.filter(t => t.djiTask)).toHaveLength(2);
  });
  it('does not consume a photo report into the first of two ambiguous Airins candidates', () => {
    const report = saved(mission);
    const tasks = patrolTasks([{ ...mission, missionId: 88 }, { ...b.mission, missionId: 89 }], [report], null, [], 0, [a]);
    expect(tasks).toHaveLength(3);
    expect(tasks.find(t => t.report === report)?.mission?.missionId).toBe(0);
  });
});

it('review preserves local event evidence when collecting a report with Airins data', async () => {
  const event: LocalFlightEvent = { ...completedWithoutAir, name: first.missionName, route: '历史实际航线', flightTime: {startTime:first.startTime,endTime:first.endTime,durationMs:first.endTime-first.startTime,source:'dji-plan',precision:'minute'} };
  await act(async () => root.render(<FlightReportPanel tabs={tabs} ready flightEvent={event} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
  await click('重新生成报告');
  await click('自动匹配并读取资料');
  const call = ipc.invoke.mock.calls.find(call => call[0] === 'collect_flight_report');
  expect(call?.[1].request.localEventId).toBe(event.id);
});
it('review displays historical route instead of current default', async () => {
  const event: LocalFlightEvent = { ...completedWithoutAir, name: first.missionName, route: '历史实际航线', flightTime: {startTime:first.startTime,endTime:first.endTime,durationMs:first.endTime-first.startTime,source:'dji-plan',precision:'minute'} };
  await act(async () => root.render(<FlightReportPanel tabs={tabs} ready flightEvent={event} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
  const row = [...document.querySelectorAll('tbody tr')].find(row => row.textContent?.includes(first.missionName));
  expect(row?.textContent).toContain('历史实际航线');
});


it('ignores pre-reset mission, DJI and report list responses that arrive after reset', async () => {
  const pending = new Map<string, (value: unknown) => void>();
  const original = ipc.invoke.getMockImplementation()!;
  ipc.invoke.mockImplementation((command, args) => {
    if (['list_flight_missions', 'list_dji_report_tasks', 'list_flight_reports'].includes(command)) {
      return new Promise(resolve => pending.set(command, resolve));
    }
    return original(command, args);
  });
  await render();
  expect(pending.size).toBe(3);
  await act(async () => root.render(<FlightReportPanel dataResetKey={1} tabs={tabs} ready={false} onPrepare={prepare} openAir={() => {}} openMedia={() => {}} />));
  await act(async () => {
    pending.get('list_flight_missions')!({ missions: [first], total: 1 });
    pending.get('list_dji_report_tasks')!([{ taskId: 'old-task', mission: { ...second, missionId: 0 }, status: '执行成功', mediaReady: true }]);
    pending.get('list_flight_reports')!([saved()]);
  });
  expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
  expect(document.querySelector('.history-card')?.textContent).toContain('0 个任务');
});
