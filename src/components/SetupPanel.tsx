import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { targetSites, type TargetSite } from '../config/sites';
import { siteLabels, type BridgeStatus, type Readiness } from '../lib/workspace';
import { PluginVersionStatus } from './PluginVersionStatus';
import { BridgeDiagnostics } from './BridgeDiagnostics';

type Props = { bridge?: BridgeStatus | null; state: Readiness | null; busy: boolean; onCheck: () => void; openSite: (site: TargetSite) => void };
export function SetupPanel({ bridge, state, busy, onCheck, openSite }: Props) {
  const [directory, setDirectory] = useState<{path:string;platform:string;testEnvironment?:boolean} | null>(null);
  const [message, setMessage] = useState('');
  const [opening, setOpening] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  useEffect(() => { if (isTauri()) void invoke<{path:string;platform:string;testEnvironment?:boolean}>('get_extension_directory').then(setDirectory).catch(() => setMessage('无法取得插件目录，请检查客户端是否完整安装。')); }, []);
  const command = async (name: string) => { setOpening(true); setMessage(''); try { await invoke(name); } catch (e) { setMessage(name === 'open_chrome_extensions' ? '无法打开 Chrome 扩展管理，请在 Chrome 地址栏输入 chrome://extensions 后，点击插件的“重新加载”。' : String(e)); } finally { setOpening(false); } };
  const conflict = /端口|重复|多个/.test(state?.pluginMessage || '');
  const pluginReady = !!state?.pluginReady && !state.pluginUpdateRequired;
  const pluginInstructions = <section className="setup-card">
      <div className="section-heading"><div><h3>{state?.pluginUpdateRequired ? '必须更新 Chrome 插件' : conflict ? '先解决客户端连接冲突' : '连接 Chrome 插件'}</h3><PluginVersionStatus bridge={bridge} readiness={state} /></div><span className="badge warning">{state ? '未就绪' : '检测中'}</span></div>
      {state?.pluginUpdateRequired ? <><p className="notice">在 Chrome 扩展管理中找到对应的“浏览器桥接”插件，点击 ↻“重新加载”，返回后会自动复查版本。</p><button className="secondary-button" disabled={opening} onClick={() => void command('open_chrome_extensions')}>更新插件 ↗</button></> : conflict ? <div className="notice warning"><strong>请查看本机连接诊断</strong><p>端口异常和多个浏览器会话需要分别处理，请按诊断结果中的建议操作。</p><button className="secondary-button" disabled={busy} onClick={onCheck}>重新检测连接</button></div> : <>
        <ol className="install-instructions"><li><strong>打开 Chrome 扩展管理</strong><p>在页面右上角开启“开发者模式”。</p><button className="primary-button" disabled={opening} onClick={() => void command('open_chrome_extensions')}>打开扩展管理 ↗</button></li><li><strong>加载本机插件</strong><p>选择“加载已解压的扩展程序”，选择下面的文件夹。已安装的插件请点击“重新加载”。</p><code className="extension-path">{directory?.path || '正在获取插件目录…'}</code><div className="button-row"><button className="secondary-button" disabled={!directory} onClick={() => { if (directory) void navigator.clipboard.writeText(directory.path).then(() => setMessage('插件目录已复制')).catch(() => setMessage('复制失败，请选中路径手动复制')); }}>复制路径</button><button className="secondary-button" disabled={opening || !directory} onClick={() => void command('open_extension_directory')}>打开所在文件夹</button></div><small>{directory?.platform === 'macos' ? '选择文件夹时按 ⌘⇧G，粘贴完整路径。' : '在文件夹选择窗口的地址栏粘贴完整路径。'}</small></li><li><strong>等待连接成功</strong><p>保持 Chrome 运行。系统识别到 v{state?.minimumExtensionVersion || "…"} 或以上插件后，会自动进入下一步。</p><button className="secondary-button" disabled={busy} onClick={onCheck}>重新检测</button></li></ol>
      </>}
      {message && <p className="notice" role="status">{message}</p>}<BridgeDiagnostics />
    </section>;
  const siteRows = <>{targetSites.map((site, index) => { const health = state?.sites.find(s => s.id === site.id); const checking = state?.checking === true && (!health || health.state === 'unchecked' || health.state === 'not_open'); const label = checking ? '验证中' : health ? siteLabels[health.state] : '待验证'; const message = checking ? '正在验证登录与业务访问' : health?.message || '等待检测'; return <article className="health-row" key={site.id}><span className={`site-number ${health?.state === 'ready' ? 'success' : ''}`}>{health?.state === 'ready' ? '✓' : index + 2}</span><div className="health-copy"><h4>{site.name}</h4><p>{message}</p><small>{health?.checkedAt ? `上次验证 ${health.checkedAt}` : site.description}</small></div><span className={`badge ${health?.state === 'ready' ? 'success' : 'warning'}`}>{label}</span><button className="secondary-button" onClick={() => openSite(site)}>{health?.state === 'ready' ? '打开网站 ↗' : health?.state === 'login_required' ? '前往登录 ↗' : '打开并处理 ↗'}</button></article>; })}</>;
  return <section className="setup-card required-environment-list" aria-label="必需的运行环境">
    <div className="health-list">
      <article className="health-row">
        <span className={`site-number ${pluginReady ? 'success' : ''}`}>{pluginReady ? '✓' : '1'}</span>
        <div className="health-copy"><h4>浏览器插件</h4><PluginVersionStatus bridge={bridge} readiness={state} />{state?.pluginUpdateRequired && <small>在 Chrome 扩展管理中找到对应的“浏览器桥接”插件，点击 ↻“重新加载”。</small>}{state?.pluginUpdateRequired && message && <small role="alert">{message}</small>}</div>
        <span className={`badge ${pluginReady ? 'success' : 'warning'}`}>{pluginReady ? '已连接' : state?.pluginUpdateRequired ? '需更新' : '待连接'}</span>
        {state?.pluginUpdateRequired ? <button className="secondary-button" disabled={opening} onClick={() => void command('open_chrome_extensions')}>更新插件 ↗</button> : !pluginReady && <button className="secondary-button" aria-expanded={showInstructions} onClick={() => setShowInstructions(value => !value)}>{showInstructions ? '收起指引' : '安装与连接'}</button>}
        {!pluginReady && !state?.pluginUpdateRequired && showInstructions && <div className="required-plugin-instructions">{pluginInstructions}</div>}
      </article>
      {siteRows}
    </div>
  </section>;
}
