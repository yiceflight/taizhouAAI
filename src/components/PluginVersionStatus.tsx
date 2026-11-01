import type { BridgeStatus, Readiness } from '../lib/workspace';

type Props = {
  bridge?: BridgeStatus | null;
  readiness: Readiness | null;
};

export function PluginVersionStatus({ bridge, readiness }: Props) {
  const versions = bridge?.connected ? bridge.versions : [];
  const label = versions.map(version => `v${version}`).join('、');
  const needsUpdate = readiness?.pluginUpdateRequired === true;
  const message = needsUpdate
    ? `当前插件 ${label || '版本未知'} · 需更新至 v${readiness.minimumExtensionVersion} 或以上`
    : readiness?.pluginReady
      ? `已连接 · ${label || '正在获取版本号'}`
      : readiness?.pluginMessage || '等待安装并连接 Chrome 插件';

  return <p className="plugin-version-message">{message}</p>;
}
