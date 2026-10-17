import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { displayMessage, LogRows, RuntimeLogs, timeFilter, type LogEntry } from '../src/components/RuntimeLogs';
const api = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => api);
const entry: LogEntry = { id: 101, at: Date.parse('2026-10-15T02:00:00Z'), session: 'session-1', level: 'warning', category: 'bridge', event: 'bridge.state', message: '浏览器插件连接未就绪', details: { reason: '<script>alert(1)</script>', clients: 0 } };
let root: Root;
const click = async (label: string) => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === label)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
};
beforeEach(() => {
  vi.useFakeTimers();
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
  api.isTauri.mockReturnValue(true);
  api.invoke.mockReset().mockImplementation(async (command: string, args: { filter: { beforeId?: number } }) => {
    if (command === 'export_runtime_logs') return '/logs/export.jsonl';
    return { entries: [{ ...entry, id: args.filter.beforeId ? 90 : 101 }], hasMore: !args.filter.beforeId, session: 'session-1' };
  });
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('runtime logs', () => {
  it('keeps details escaped and displays explicit Beijing time', () => {
    const html = renderToStaticMarkup(<LogRows entries={[entry]}/>);
    expect(html).toContain('10:00:00');
    expect(html).toContain('警告'); expect(html).toContain('原因');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('<pre>'); expect(html).not.toContain('bridge.state');
    expect(timeFilter('2026-10-15T10:00')).toBe(entry.at);
    expect(timeFilter('')).toBeUndefined();
  });
  it('turns window state details into a compact Chinese summary', () => {
    const html = renderToStaticMarkup(<LogRows entries={[{ ...entry, event: 'window.state', category: 'window', message: '窗口状态变化', details: { current: { visible: true, minimized: false, focused: true }, previous: { visible: true, minimized: false, focused: false } } }]}/>);
    expect(html).toContain('当前窗口');
    expect(html).toContain('窗口可见 · 已聚焦 · 未最小化');
    expect(html).toContain('此前窗口');
    expect(html).not.toContain('current');
    expect(html).not.toContain('{');
  });
  it('translates browser job records into an explicit human-readable action', () => {
    const started = { ...entry, event: 'job.started', message: '开始请求浏览器任务', details: { type: 'dji-tasks', requestId: 'request-1' } };
    const delivered = { ...started, event: 'job.delivered', message: '任务已交给浏览器插件' };
    const finished = { ...started, event: 'job.finished', message: '浏览器任务已返回结果', level: 'info' };
    const failed = { ...started, event: 'job.finished', message: '浏览器任务失败', level: 'error', details: { type: 'dji-weather', error: '天气页面未打开' } };
    expect(displayMessage(started)).toContain('正在请求浏览器插件执行“同步司空任务”');
    expect(displayMessage(delivered)).toContain('已将“同步司空任务”交给浏览器插件');
    expect(displayMessage(finished)).toContain('浏览器插件已返回“同步司空任务”回执');
    expect(displayMessage(failed)).toContain('浏览器插件执行“获取司空机场天气”失败');
    expect(renderToStaticMarkup(<LogRows entries={[started, delivered, finished, failed]} />)).not.toContain('开始请求浏览器任务');
  });
  it('reads only while active and pauses polling on historical pages', async () => {
    await act(async () => root.render(<RuntimeLogs active={false}/>));
    expect(api.invoke).not.toHaveBeenCalled();
    await act(async () => root.render(<RuntimeLogs active/>));
    expect(api.invoke).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.invoke).toHaveBeenCalledTimes(2);
    await click('更早记录');
    expect(api.invoke).toHaveBeenLastCalledWith('get_runtime_logs', { filter: expect.objectContaining({ beforeId: 101 }) });
    const count = api.invoke.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.invoke).toHaveBeenCalledTimes(count);
    await click('上一页');
    expect(api.invoke).toHaveBeenLastCalledWith('get_runtime_logs', { filter: expect.objectContaining({ beforeId: undefined }) });
    await act(async () => root.render(<RuntimeLogs active={false}/>));
    const inactiveCount = api.invoke.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.invoke).toHaveBeenCalledTimes(inactiveCount);
  });
  it('exports all matching retained entries without a page cursor', async () => {
    await act(async () => root.render(<RuntimeLogs active/>));
    await click('更早记录');
    await click('导出筛选结果');
    const args = api.invoke.mock.calls.find(([command]) => command === 'export_runtime_logs')![1];
    expect(args.filter).not.toHaveProperty('beforeId');
    expect(document.body.textContent).toContain('/logs/export.jsonl');
  });
  it('shows storage failures rather than claiming an empty healthy log', async () => {
    api.invoke.mockRejectedValue(new Error('磁盘写入失败'));
    await act(async () => root.render(<RuntimeLogs active/>));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('磁盘写入失败');
    expect([...document.querySelectorAll('button')].find(b => b.textContent === '导出筛选结果')?.disabled).toBe(true);
  });
});
