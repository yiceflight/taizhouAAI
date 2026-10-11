import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PluginVersionStatus } from '../src/components/PluginVersionStatus';

const api = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => api);

const bridge = (versions: string[]) => ({ connected: true, clients: 1, versions, tabs: [], error: null });
const readiness = (pluginUpdateRequired: boolean) => ({
  pluginReady: !pluginUpdateRequired,
  pluginMessage: '',
  pluginUpdateRequired,
  minimumExtensionVersion: '0.7.1',
  checking: false,
  sites: [],
  ready: !pluginUpdateRequired,
  started: false,
});

describe('footer version status', () => {
  it('shows the connected browser plugin version', () => {
    const html = renderToStaticMarkup(<PluginVersionStatus bridge={bridge(['0.7.1'])} readiness={readiness(false)} />);
    expect(html).toContain('当前浏览器插件 v0.7.1');
    expect(html).not.toContain('插件未刷新');
  });

  it('shows a refresh reminder when the connected plugin is stale', () => {
    const html = renderToStaticMarkup(<PluginVersionStatus bridge={bridge(['0.5.0'])} readiness={readiness(true)} />);
    expect(html).toContain('当前浏览器插件 v0.5.0');
    expect(html).toContain('插件未刷新，去刷新');
  });

  it('explains when no browser plugin is connected', () => {
    const html = renderToStaticMarkup(<PluginVersionStatus bridge={null} readiness={null} />);
    expect(html).toContain('当前浏览器插件 未连接');
  });
});
