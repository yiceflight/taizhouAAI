import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { targetSites, type TargetSite } from '../config/sites';
import { siteLabels, type Readiness } from '../lib/workspace';

type Props = { state: Readiness | null; busy: boolean; onCheck: () => void; onStart: () => void; openSite: (site: TargetSite) => void; onHistory: () => void };
export function SetupPanel({ state, busy, onCheck, onStart, openSite, onHistory }: Props) {
  const [directory, setDirectory] = useState<{path:string;platform:string} | null>(null);
  const [message, setMessage] = useState('');
  const [opening, setOpening] = useState(false);
  useEffect(() => { if (isTauri()) void invoke<{path:string;platform:string}>('get_extension_directory').then(setDirectory).catch(() => setMessage('无法取得插件目录，请检查客户端是否完整安装。')); }, []);
  const command = async (name: string) => { setOpening(true); setMessage(''); try { await invoke(name); } catch (e) { setMessage(String(e)); } finally { setOpening(false); } };
  const step = !state?.pluginReady ? 0 : !state.ready ? 1 : 2;
  const passed = state?.sites.filter(s => s.state === 'ready').length || 0;
  const conflict = /端口|重复|多个/.test(state?.pluginMessage || '');
  return <div className="setup-workspace">
    <div className="page-heading"><div><span className="eyebrow">开始工作前</span><h2>{state?.started ? state.ready ? '工作环境已就绪' : '恢复工作环境' : '完成准备，开始监测'}</h2><p>验证通过后，将自动读取最新数据并进入监测工作台。</p></div><button className="text-button" onClick={onHistory}>查看历史报告 →</button></div>
    <ol className="setup-steps" aria-label="准备进度">{['连接浏览器插件', '验证三个网站', '读取数据并开始'].map((label, index) => <li key={label} className={index < step ? 'done' : index === step ? 'current' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? '✓' : index + 1}</span><div>{label}<small>{index < step ? '已完成' : index === step ? '当前步骤' : '等待前一步完成'}</small></div></li>)}</ol>
    {step === 0 ? <section className="setup-card">
      <div className="section-heading"><div><h3>{state?.pluginUpdateRequired ? '必须更新 Chrome 插件' : conflict ? '先解决客户端连接冲突' : '连接 Chrome 插件'}</h3><p>{state?.pluginMessage || '正在检查本机插件连接…'}</p></div><span className="badge warning">{state ? '未就绪' : '检测中'}</span></div>
      {conflict ? <div className="notice warning"><strong>请为当前版本只保留一个客户端和一个 Chrome 插件会话</strong><p>退出同一版本重复运行的客户端后，重新启动要使用的客户端。此问题无需重复安装插件。</p><button className="secondary-button" disabled={busy} onClick={onCheck}>重新检测连接</button></div> : <>
        <ol className="install-instructions"><li><strong>打开 Chrome 扩展管理</strong><p>在页面右上角开启“开发者模式”。</p><button className="primary-button" disabled={opening} onClick={() => void command('open_chrome_extensions')}>打开扩展管理 ↗</button></li><li><strong>加载本机插件</strong><p>选择“加载已解压的扩展程序”，选择下面的文件夹。已安装的插件请点击“重新加载”。</p><code className="extension-path">{directory?.path || '正在获取插件目录…'}</code><div className="button-row"><button className="secondary-button" disabled={!directory} onClick={() => { if (directory) void navigator.clipboard.writeText(directory.path).then(() => setMessage('插件目录已复制')).catch(() => setMessage('复制失败，请选中路径手动复制')); }}>复制路径</button><button className="secondary-button" disabled={opening || !directory} onClick={() => void command('open_extension_directory')}>打开所在文件夹</button></div><small>{directory?.platform === 'macos' ? '选择文件夹时按 ⌘⇧G，粘贴完整路径。' : '在文件夹选择窗口的地址栏粘贴完整路径。'}</small></li><li><strong>等待连接成功</strong><p>保持 Chrome 运行。系统识别到 v{state?.minimumExtensionVersion || "…"} 或以上插件后，会自动进入下一步。</p><button className="secondary-button" disabled={busy} onClick={onCheck}>重新检测</button></li></ol>
      </>}
      {message && <p className="notice" role="status">{message}</p>}
    </section> : <>
      <section className="setup-card"><div className="section-heading"><div><h3>三个网站均需验证通过 <span className="inline-count">{passed} / 3</span></h3><p>在 Chrome 完成登录后，点击“重新验证全部”；系统也会自动复查。</p></div><button className="secondary-button" disabled={busy || state?.checking} onClick={onCheck}>{state?.checking ? '正在验证…' : '重新验证全部'}</button></div>
        <div className="health-list">{targetSites.map((site, index) => { const health = state?.sites.find(s => s.id === site.id); return <article className="health-row" key={site.id}><span className={`site-number ${health?.state === 'ready' ? 'success' : ''}`}>{health?.state === 'ready' ? '✓' : index + 1}</span><div className="health-copy"><h4>{site.name}</h4><p>{health?.message || '等待检测'}</p><small>{health?.checkedAt ? `上次验证 ${health.checkedAt}` : site.description}</small></div><span className={`badge ${health?.state === 'ready' ? 'success' : 'warning'}`}>{health ? siteLabels[health.state] : '待验证'}</span><button className="secondary-button" onClick={() => openSite(site)}>{health?.state === 'ready' ? '打开网站 ↗' : health?.state === 'login_required' ? '前往登录 ↗' : '打开并处理 ↗'}</button></article>; })}</div>
      </section>
      <section className={`setup-card start-card ${step < 2 ? 'pending' : ''}`}><div><h3>{state?.started ? '恢复监测工作台' : '自动读取数据，进入工作台'}</h3><p>{step < 2 ? '还需完成上方网站验证。已保存的数据和报告仍可查看。' : state?.started ? '环境已恢复，可继续处理原有任务。' : '验证已通过，数据读取成功后自动进入；读取失败时可点击下方按钮重试。'}</p></div><button className="primary-button" disabled={step < 2 || busy || state?.checking} onClick={onStart}>{busy ? state?.checking ? '正在验证…' : '正在读取数据…' : state?.started ? '返回工作台' : '读取数据并开始监测'}</button></section>
    </>}
  </div>;
}
