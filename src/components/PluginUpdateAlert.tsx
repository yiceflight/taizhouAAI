import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Readiness } from '../lib/workspace';

export function PluginUpdateAlert({ state, onSetup }: { state: Readiness | null; onSetup: () => void }) {
  const [error, setError] = useState('');
  if (!state?.pluginUpdateRequired) return null;
  return <section className="plugin-update-required" role="alert" aria-labelledby="plugin-update-title">
    <div><strong id="plugin-update-title">必须更新浏览器插件，采集与监测已暂停</strong>
      <p>{state.pluginMessage}</p>
      <p>打开 Chrome 扩展管理，找到当前版本的“浏览器桥接”插件并点击“重新加载”。若仍提示旧版本，请按安装指引加载本客户端提供的插件目录。</p>
      <p>检测到 v{state.minimumExtensionVersion} 或以上版本后自动解除限制。</p>
      {error && <p>{error}</p>}
    </div>
    <div className="plugin-update-actions">
      <button className="primary-button" onClick={() => { setError(''); void invoke('open_chrome_extensions').catch(() => setError('无法打开 Chrome，请手动访问 chrome://extensions。')); }}>打开扩展管理 ↗</button>
      <button className="secondary-button" onClick={onSetup}>查看插件安装指引</button>
    </div>
  </section>;
}
