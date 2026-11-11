import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiagnosticReportSection } from '../src/components/DiagnosticReportSection';
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
  expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('report_diagnostics');
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
