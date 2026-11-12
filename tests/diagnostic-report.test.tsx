import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiagnosticReportSection } from '../src/components/DiagnosticReportSection';
import { clientEnvironment, tabRoute } from '../src/lib/diagnostics';
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ipc);
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!); ipc.invoke.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('only sends on explicit click, locks duplicates and shows completion', async () => {
  let resolve!: (message: string) => void;
  ipc.invoke.mockImplementation(() => new Promise<string>(r => { resolve = r; }));
  const busy = vi.fn();
  await act(async () => root.render(<DiagnosticReportSection disabled={false} onBusyChange={busy} />));
  expect(ipc.invoke).not.toHaveBeenCalled();
  await act(async () => { document.querySelector('button')!.click(); document.querySelector('button')!.click(); });
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
  // The environment travels with the request so it is collected in the same
  // click, before the packet is built.
  const [command, args] = ipc.invoke.mock.calls[0] as [string, { environment: { at: number; main: unknown; tabs: unknown[] } }];
  expect(command).toBe('report_diagnostics');
  expect(args.environment).toMatchObject({ main: {}, tabs: [] });
  expect(document.body.textContent).toContain('正在上报…');
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => resolve('SMTP 已接收异常日志邮件，已清理 2 批缓存。'));
  expect(document.querySelector('[role="status"]')!.textContent).toContain('已清理 2 批缓存');
  expect(busy).toHaveBeenLastCalledWith(false);
});
it('keeps failures visible and retries only after a second click', async () => {
  ipc.invoke.mockRejectedValueOnce('网络失败，缓存已保留').mockResolvedValueOnce('暂无需要上报的异常缓存。');
  await act(async () => root.render(<DiagnosticReportSection disabled={false} onBusyChange={() => {}} />));
  await act(async () => document.querySelector('button')!.click());
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('缓存已保留');
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
  await act(async () => document.querySelector('button')!.click());
  expect(ipc.invoke).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[role="status"]')!.textContent).toContain('暂无需要上报');
});
it('respects other settings operations', async () => {
  await act(async () => root.render(<DiagnosticReportSection disabled onBusyChange={() => {}} />));
  await act(async () => document.querySelector('button')!.click());
  expect(ipc.invoke).not.toHaveBeenCalled();
});
it('reports which pages are open without their parameters', () => {
  const project = 'https://fh.dji.com/organization/o/project/p';
  expect(tabRoute(`${project}#/plan/create-plan`)).toBe(`${project}#/plan/create-plan`);
  expect(tabRoute(`${project}#/media?page=1&size=50`)).toBe(`${project}#/media`);
  expect(tabRoute(`${project}?token=secret#/team`)).toBe(`${project}#/team`);
  expect(tabRoute('https://aai.airins.cn/sniff/HistoryCloud?missionId=71')).toBe('https://aai.airins.cn/sniff/HistoryCloud?missionId');
  const tabs = Array.from({ length: 120 }, (_, id) => ({ id, url: `${project}#/plan` }));
  const environment = clientEnvironment(tabs, '0.2.28');
  expect(environment.tabCount).toBe(120);
  expect(environment.tabs).toHaveLength(100);
});
