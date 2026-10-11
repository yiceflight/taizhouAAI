import { invoke, isTauri } from '@tauri-apps/api/core';
import type { BridgeStatus, Readiness } from '../lib/workspace';

type Props = {
  bridge: BridgeStatus | null;
  readiness: Readiness | null;
};

export function PluginVersionStatus({ bridge, readiness }: Props) {
  const versions = bridge?.versions ?? [];
  const label = versions.length > 0 ? versions.map((version) => `v${version}`).join('、') : '未连接';
  const needsRefresh = readiness?.pluginUpdateRequired === true;
  const openExtensions = () => {
    if (isTauri()) void invoke('open_chrome_extensions').catch(() => {});
  };

  return <span className="plugin-version-status">
    <span className="footer-plugin">当前浏览器插件 {label}</span>
    {needsRefresh && <button type="button" className="plugin-refresh-reminder" onClick={openExtensions} title="打开 Chrome 扩展管理页并点击“重新加载”">
      插件未刷新，去刷新
    </button>}
  </span>;
}
