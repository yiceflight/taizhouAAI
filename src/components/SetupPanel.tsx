import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { targetSites, type TargetSite } from '../config/sites';
import { siteLabels, type Readiness } from '../lib/workspace';
import { BridgeDiagnostics } from './BridgeDiagnostics';

type Props = { state: Readiness | null; busy: boolean; active?: boolean; onCheck: () => void; openSite: (site: TargetSite) => void; onHistory: () => void };
export function SetupPanel({ state, busy, active = true, onCheck, openSite, onHistory }: Props) {
  const [directory, setDirectory] = useState<{path:string;platform:string} | null>(null);
  const [message, setMessage] = useState('');
  const [opening, setOpening] = useState(false);
  useEffect(() => { if (isTauri()) void invoke<{path:string;platform:string}>('get_extension_directory').then(setDirectory).catch(() => setMessage('无法取得插件目录，请检查客户端是否完整安装。')); }, []);
  const command = async (name: string) => { setOpening(true); setMessage(''); try { await invoke(name); } catch (e) { setMessage(String(e)); } finally { setOpening(false); } };
  const step = !state?.pluginReady ? 0 : !state.ready ? 1 : 2;
  const passed = state?.sites.filter(s => s.state === 'ready').length || 0;
  const conflict = /端口|重复|多个/.test(state?.pluginMessage || '');
  return <div className="setup-workspace">
    <div className="page-heading"><div><span className="eyebrow">运行状态</span><h2>{!state ? '正在检测运行状态' : state.ready ? '运行正常' : '运行状态待处理'}</h2><p>查看浏览器连接与网站验证状态，异常时请按下方提示处理。</p></div><button className="text-button" onClick={onHistory}>查看巡查任务与报告 →</button></div>
    <ol className="setup-steps" aria-label="运行状态检查">{['浏览器连接', '网站验证'].map((label, index) => <li key={label} className={index < step ? 'done' : index === step ? 'current' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? '✓' : index + 1}</span><div>{label}<small>{index < step ? index === 0 ? '已连接' : '全部通过' : index === step ? !state || state.checking ? '检测中' : '待处理' : '等待浏览器连接'}</small></div></li>)}</ol>
    <BridgeDiagnostics active={active} />
    {step === 0 ? <section className="setup-card">
      <div className="section-heading"><div><h3>{state?.pluginUpdateRequired ? '必须更新 Chrome 插件' : conflict ? '先解决客户端连接冲突' : '连接 Chrome 插件'}</h3><p>{state?.pluginMessage || '正在检查本机插件连接…'}</p></div><span className="badge warning">{state ? '未就绪' : '检测中'}</span></div>
      {conflict ? <div className="notice warning"><strong>请查看本机连接诊断</strong><p>端口异常和多个浏览器会话需要分别处理，请按诊断结果中的建议操作。</p><button className="secondary-button" disabled={busy} onClick={onCheck}>重新检测连接</button></div> : <>
        <ol className="install-instructions"><li><strong>打开 Chrome 扩展管理</strong><p>在页面右上角开启“开发者模式”。</p><button className="primary-button" disabled={opening} onClick={() => void command('open_chrome_extensions')}>打开扩展管理 ↗</button></li><li><strong>加载本机插件</strong><p>选择“加载已解压的扩展程序”，选择下面的文件夹。已安装的插件请点击“重新加载”。</p><code className="extension-path">{directory?.path || '正在获取插件目录…'}</code><div className="button-row"><button className="secondary-button" disabled={!directory} onClick={() => { if (directory) void navigator.clipboard.writeText(directory.path).then(() => setMessage('插件目录已复制')).catch(() => setMessage('复制失败，请选中路径手动复制')); }}>复制路径</button><button className="secondary-button" disabled={opening || !directory} onClick={() => void command('open_extension_directory')}>打开所在文件夹</button></div><small>{directory?.platform === 'macos' ? '选择文件夹时按 ⌘⇧G，粘贴完整路径。' : '在文件夹选择窗口的地址栏粘贴完整路径。'}</small></li><li><strong>等待连接成功</strong><p>保持 Chrome 运行。系统识别到 v{state?.minimumExtensionVersion || "…"} 或以上插件后，会自动进入下一步。</p><button className="secondary-button" disabled={busy} onClick={onCheck}>重新检测</button></li></ol>
      </>}
      {message && <p className="notice" role="status">{message}</p>}
    </section> : <>
      <section className="setup-card"><div className="section-heading"><div><h3>各平台连接状态 <span className="inline-count">{passed} / 3</span></h3><p>系统会在 Chrome 后台自动打开缺失的平台页面；请完成登录，登录状态会自动复查。江苏大气站就绪即可监测；起飞需司空就绪，可飞异常不影响监测与起飞。</p></div><button className="secondary-button" disabled={busy || state?.checking} onClick={onCheck}>{state?.checking ? '正在验证…' : '重新验证全部'}</button></div>
        <div className="health-list">{targetSites.map((site, index) => { const health = state?.sites.find(s => s.id === site.id); return <article className="health-row" key={site.id}><span className={`site-number ${health?.state === 'ready' ? 'success' : ''}`}>{health?.state === 'ready' ? '✓' : index + 1}</span><div className="health-copy"><h4>{site.name}</h4><p>{health?.message || '等待检测'}</p><small>{health?.checkedAt ? `上次验证 ${health.checkedAt}` : site.description}</small></div><span className={`badge ${health?.state === 'ready' ? 'success' : 'warning'}`}>{health ? siteLabels[health.state] : '待验证'}</span><button className="secondary-button" onClick={() => openSite(site)}>{health?.state === 'ready' ? '打开网站 ↗' : health?.state === 'login_required' ? '前往登录 ↗' : '打开并处理 ↗'}</button></article>; })}</div>
      </section>
    </>}
  </div>;
}
