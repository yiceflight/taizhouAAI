import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluginVersionStatus } from '../src/components/PluginVersionStatus';

const bridge = (versions: string[]) => ({ connected: true, clients: 1, versions, tabs: [], error: null });
const readiness = (pluginUpdateRequired: boolean) => ({
  pluginReady: !pluginUpdateRequired, pluginMessage: '', pluginUpdateRequired,
  minimumExtensionVersion: '0.7.1', checking: false, sites: [], ready: !pluginUpdateRequired, started: false,
});

describe('environment plugin version status', () => {
  it('shows actual connected versions instead of a compatibility label', () => {
    const html = renderToStaticMarkup(<PluginVersionStatus bridge={bridge(['0.7.1', '0.7.2'])} readiness={readiness(false)} />);
    expect(html).toContain('已连接 · v0.7.1、v0.7.2');
    expect(html).not.toContain('版本兼容');
  });
  it('shows both the stale version and the required version in the same message', () => {
    const html = renderToStaticMarkup(<PluginVersionStatus bridge={bridge(['0.5.0'])} readiness={readiness(true)} />);
    expect(html).toContain('当前插件 v0.5.0 · 需更新至 v0.7.1 或以上');
  });
  it('does not present the required version as the installed version while loading', () => {
    const html = renderToStaticMarkup(<PluginVersionStatus bridge={null} readiness={readiness(false)} />);
    expect(html).toContain('正在获取版本号');
    expect(html).not.toContain('v0.7.1');
  });
  it('does not show stale versions after disconnection', () => {
    const html = renderToStaticMarkup(<PluginVersionStatus bridge={{ ...bridge(['0.5.0']), connected: false }} readiness={{ ...readiness(false), pluginReady: false }} />);
    expect(html).toContain('等待安装并连接 Chrome 插件');
    expect(html).not.toContain('v0.5.0');
  });
});
