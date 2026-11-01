import { minimumExtensionVersion as bundledMinimum } from '../../bridge-config.json';
import type { BridgeStatus, Readiness } from './workspace';

function parseVersion(value: string): number[] | null {
  if (!/^\d+(?:\.\d+){0,3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  if (parts.some(part => part > 65535)) return null;
  return [...parts, ...Array(4 - parts.length).fill(0)];
}

function compareVersion(actual: number[], required: number[]) {
  for (let index = 0; index < 4; index++) {
    if (actual[index] !== required[index]) return actual[index] - required[index];
  }
  return 0;
}

// Dev HMR can update the UI while the native process still carries its older
// compiled requirement. Never let that older requirement relax the current UI.
export function applyPluginRequirement(state: Readiness | null, bridge: BridgeStatus | null): Readiness | null {
  if (!state) return null;
  const native = parseVersion(state.minimumExtensionVersion);
  const bundled = parseVersion(bundledMinimum)!;
  const minimumExtensionVersion = native && compareVersion(native, bundled) > 0
    ? state.minimumExtensionVersion : bundledMinimum;
  const minimum = parseVersion(minimumExtensionVersion)!;
  const outdated = !!bridge?.connected && bridge.versions.some(version => {
    const actual = parseVersion(version);
    return !actual || compareVersion(actual, minimum) < 0;
  });
  if (!outdated) return { ...state, minimumExtensionVersion };
  return {
    ...state, minimumExtensionVersion,
    pluginReady: false, pluginUpdateRequired: true, ready: false,
    monitoringReady: false, flightReady: false, reportReady: false,
    pluginMessage: `浏览器插件需要更新：当前 v${bridge!.versions.join('、v')}，需要 v${minimumExtensionVersion} 或以上。请在 Chrome 扩展管理中重新加载插件。`,
  };
}
