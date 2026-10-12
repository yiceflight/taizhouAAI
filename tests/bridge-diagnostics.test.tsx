import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BridgeDiagnostics, diagnosticText, type BridgeDiagnosticReport } from '../src/components/BridgeDiagnostics';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ipc);
let root: Root;
const report: BridgeDiagnosticReport = {
  checkedAt: '2026-10-12T02:00:00Z', appVersion: '0.2.4', platform: 'windows', channel: '正式版',
  address: '127.0.0.1:14520', extensionId: 'fixture-id', minimumExtensionVersion: '0.7.14',
  checks: [
    { id: 'files', label: '随 App 附带的插件目录', state: 'pass', detail: 'D:\\监测系统\\extension', suggestion: '' },
    { id: 'tcp', label: '本机端口', state: 'pass', detail: 'TCP 连接成功', suggestion: '' },
    { id: 'service', label: '当前客户端服务', state: 'fail', detail: '回应的不是当前客户端实例', suggestion: '检查重复客户端或端口占用' },
    { id: 'plugin', label: '浏览器插件心跳', state: 'warning', detail: '无法据此判断插件是否已安装', suggestion: '查看 Chrome 扩展管理页' },
  ],
};
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  ipc.invoke.mockReset().mockResolvedValue(report); ipc.isTauri.mockReturnValue(true);
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const mount = () => act(async () => root.render(<StrictMode><BridgeDiagnostics /></StrictMode>));
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;

it('runs once on entry, preserves distinct failures, and copies the dated report', async () => {
  await mount();
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
  expect(ipc.invoke).toHaveBeenCalledWith('diagnose_bridge');
  expect(document.body.textContent).toContain('TCP 连接成功');
  expect(document.body.textContent).toContain('回应的不是当前客户端实例');
  expect(document.body.textContent).toContain('无法据此判断插件是否已安装');
  expect(document.body.textContent).toContain('D:\\监测系统\\extension');
  await act(async () => button('复制诊断结果').click());
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(diagnosticText(report));
  expect(diagnosticText(report)).toContain('[失败] 当前客户端服务');
  expect(diagnosticText(report)).toContain('127.0.0.1:14520');
});

it('clears stale success on a failed retry and allows another explicit retry', async () => {
  await mount();
  ipc.invoke.mockRejectedValueOnce('客户端命令不可用');
  await act(async () => button('重新诊断').click());
  expect(document.body.textContent).toContain('诊断未完成：客户端命令不可用');
  expect(document.body.textContent).not.toContain('TCP 连接成功');
  expect(button('复制诊断结果').disabled).toBe(true);
  await act(async () => button('重新诊断').click());
  expect(document.body.textContent).toContain('TCP 连接成功');
});

it('prevents overlapping diagnostic requests', async () => {
  let finish!: (value: BridgeDiagnosticReport) => void;
  ipc.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  expect(button('正在诊断…').disabled).toBe(true);
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
  await act(async () => finish(report));
  expect(button('重新诊断').disabled).toBe(false);
});
