import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { targetSites, type TargetSite } from "./config/sites";
import { UpdateBanner } from "./components/UpdateBanner";
import { tabKey, type BridgeStatus, type ReportSummary } from "./lib/workspace";
import { MonitoringPanel } from "./components/MonitoringPanel";
import "./App.css";
import { FlightReportPanel } from "./components/FlightReportPanel";

type WorkspaceTab = "monitoring" | "reports" | "sources";
type ExtensionDirectory = { path: string; platform: string };

function App() {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [bridgeError, setBridgeError] = useState("");
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [reportError, setReportError] = useState("");
  const [selectedTab, setSelectedTab] = useState("");
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const [reportMessage, setReportMessage] = useState("");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("monitoring");
  const [extensionMessage, setExtensionMessage] = useState("");
  const [extensionDirectory, setExtensionDirectory] = useState<ExtensionDirectory | null>(null);
  const [extensionPathError, setExtensionPathError] = useState("");
  const [siteMessage, setSiteMessage] = useState("");
  const [openingExtension, setOpeningExtension] = useState(false);
  const pluginDetails = useRef<HTMLDetailsElement>(null);
  const monitoringTab = useRef<HTMLButtonElement>(null);
  const reportsTab = useRef<HTMLButtonElement>(null);
  const sourcesTab = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isTauri()) {
      setExtensionPathError("请在桌面客户端中查看本机插件目录。");
      return;
    }
    let cancelled = false;
    invoke<ExtensionDirectory>("get_extension_directory")
      .then((directory) => { if (!cancelled) setExtensionDirectory(directory); })
      .catch((error) => { if (!cancelled) setExtensionPathError(`无法获取插件目录：${String(error)}`); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isTauri()) { setBridgeError("请在桌面客户端连接插件"); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const state = await invoke<BridgeStatus>("get_bridge_status");
        if (!cancelled) { setBridge(state); setBridgeError(""); }
      } catch (error) { if (!cancelled) { setBridge(null); setBridgeError(String(error)); } }
      if (!cancelled) timer = setTimeout(refresh, 2000);
    };
    void refresh();
    void invoke<ReportSummary[]>("list_reports").then((items) => { if (!cancelled) setReports(items); }).catch((error) => { if (!cancelled) setReportError(String(error)); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const connected = !!bridge?.connected && !bridge.error && !bridgeError;
  const pluginLabel = bridgeError || bridge?.error ? "连接异常" : !isTauri() ? "仅客户端可用" : bridge === null ? "检测中" : connected ? "已连接" : "未连接";
  const availableTabs = connected ? bridge.tabs : [];
  const selectedPage = availableTabs.find((tab) => tabKey(tab) === selectedTab);
  const generateReport = async () => {
    if (!selectedPage || generatingRef.current) return;
    generatingRef.current = true;
    setGenerating(true); setReportError(""); setReportMessage("正在采集所选页面，请保持 Chrome 和页面打开…");
    try {
      const report = await invoke<ReportSummary>("generate_report", { session: selectedPage.session, tabId: selectedPage.id });
      setReports((items) => [report, ...items]);
      setReportMessage("报告已保存到本地。点击「查看」打开，可在浏览器中打印或保存为 PDF。");
    } catch (error) { setReportError(String(error)); setReportMessage(""); }
    finally { generatingRef.current = false; setGenerating(false); }
  };
  const reportAction = async (command: string, id?: string) => {
    setReportError("");
    try { await invoke(command, id ? { id } : {}); }
    catch (error) { setReportError(String(error)); }
  };

  const copyExtensionPath = async () => {
    if (!extensionDirectory) return;
    try {
      await navigator.clipboard.writeText(extensionDirectory.path);
      setExtensionMessage("已复制插件目录路径。");
    } catch {
      setExtensionMessage("无法自动复制，请选中上方完整路径手动复制。");
    }
  };

  const openExtensionFolder = async () => {
    try {
      await invoke("open_extension_directory");
      setExtensionMessage("已打开上一级目录；可将 extension 文件夹拖入已开启开发者模式的 Chrome 扩展管理页。");
    } catch (error) {
      setExtensionMessage(String(error));
    }
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs: WorkspaceTab[] = ["monitoring", "reports", "sources"];
    const next = event.key === "Home" ? "monitoring" : event.key === "End" ? "sources" : tabs[(tabs.indexOf(activeTab) + (event.key === "ArrowRight" ? 1 : 2)) % 3];
    setActiveTab(next);
    (next === "monitoring" ? monitoringTab : next === "reports" ? reportsTab : sourcesTab).current?.focus();
  };

  const openSite = async (site: TargetSite) => {
    setSiteMessage("");
    try {
      if (isTauri()) await invoke("open_business_site", { url: site.url });
      else window.open(site.url, "_blank", "noopener,noreferrer");
    } catch {
      setSiteMessage(`无法打开${site.name}，请在浏览器中访问 ${site.url}`);
    }
  };

  const openExtensionManager = async () => {
    setExtensionMessage("");
    setOpeningExtension(true);
    try {
      if (isTauri()) {
        await invoke("open_chrome_extensions");
        setExtensionMessage("已打开扩展管理页，请开启开发者模式并选择上方显示的插件目录。");
      } else {
        setExtensionMessage("请在 Chrome 地址栏输入 chrome://extensions。");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setExtensionMessage(`无法自动打开 Chrome：${reason} 请在地址栏输入 chrome://extensions。`);
    } finally {
      setOpeningExtension(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/brand/monitoring-logo.png" alt="" width="36" height="36" />
          <h1>泰州市监测中心智能监测系统</h1>
        </div>
        <span className="workspace-label">监测工作台</span>
      </header>

      <nav className="workspace-nav" aria-label="工作台">
        <div className="tabs" role="tablist" aria-label="工作区">
          <button ref={monitoringTab} id="monitoring-tab" role="tab" aria-selected={activeTab === "monitoring"} aria-controls="monitoring-panel" tabIndex={activeTab === "monitoring" ? 0 : -1} onKeyDown={handleTabKey} onClick={() => setActiveTab("monitoring")}>小时监测</button>
          <button ref={reportsTab} id="reports-tab" role="tab" aria-selected={activeTab === "reports"} aria-controls="reports-panel" tabIndex={activeTab === "reports" ? 0 : -1} onKeyDown={handleTabKey} onClick={() => setActiveTab("reports")}>
            报告列表
          </button>
          <button ref={sourcesTab} id="sources-tab" role="tab" aria-selected={activeTab === "sources"} aria-controls="sources-panel" tabIndex={activeTab === "sources" ? 0 : -1} onKeyDown={handleTabKey} onClick={() => setActiveTab("sources")}>
            数据源
          </button>
        </div>
      </nav>

      <div className="site-shortcuts" aria-label="业务网站快捷入口">
        <span className="shortcut-label">业务网站</span>
        {targetSites.map((site) => <button key={site.id} className="site-shortcut" onClick={() => void openSite(site)} title={`打开${site.name} · ${site.url}`}>
          {site.name}<span aria-hidden="true">↗</span>
        </button>)}
      </div>
      {siteMessage && <p className="site-message" role="alert">{siteMessage}</p>}

      <main className="workspace-content">
        <section id="monitoring-panel" className="workspace-panel" role="tabpanel" aria-labelledby="monitoring-tab" tabIndex={0} hidden={activeTab !== "monitoring"}>
          <MonitoringPanel openSite={() => void openSite(targetSites[0])} />
        </section>
        <section id="reports-panel" className="workspace-panel report-workspace" role="tabpanel" aria-labelledby="reports-tab" tabIndex={0} hidden={activeTab !== "reports"}>
          <div className="panel-toolbar">
            <div><h2>报告列表</h2><span className="muted">本地巡飞快报与网页采集记录</span></div>
            <button className="secondary-button" onClick={() => void reportAction("open_reports_directory")}>报告目录</button>
          </div>
          <FlightReportPanel tabs={availableTabs} />
          <h3>网页采集记录</h3>
          <div className="capture-toolbar">
            <label htmlFor="capture-page">采集页面</label>
            <select id="capture-page" value={selectedPage ? selectedTab : ""} disabled={generating || !connected} onChange={(event) => setSelectedTab(event.target.value)}>
              <option value="">{connected ? "请选择已打开的业务页面" : "请先连接 Chrome 插件"}</option>
              {availableTabs.map((tab) => <option key={tabKey(tab)} value={tabKey(tab)}>{tab.title || "未命名页面"} · {tab.url}{tab.status !== "complete" ? "（加载中）" : ""}</option>)}
            </select>
            <button className="primary-button" disabled={!selectedPage || selectedPage.status !== "complete" || generating} onClick={() => void generateReport()}>{generating ? "采集中…" : "生成报告"}</button>
          </div>
          <p className="capture-help">采集所选页面当前可见正文和表格，生成本地网页采集报告。请先登录业务网站并打开需要的页面。</p>
          {reportError && <p className="site-message" role="alert">{reportError}</p>}
          {reportMessage && <p className="capture-help" role="status">{reportMessage}</p>}
          <div className="report-table-wrap">
            <table className="report-table">
              <thead><tr><th scope="col">报告名称</th><th scope="col">数据来源</th><th scope="col">生成时间</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
              <tbody>{reports.length > 0 ? reports.map((report) => <tr className="report-row" key={report.id}>
                <td title={report.title}>{report.title || "网页采集报告"}</td><td>{report.source}</td><td>{new Date(report.createdAt).toLocaleString("zh-CN")}</td><td>{report.truncated ? "已保存 · 有截断" : "已保存"}</td><td><button className="update-action" onClick={() => void reportAction("open_report", report.id)}>查看</button></td>
              </tr>) : <tr><td colSpan={5}>
                <div className="empty-state">
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M12 5h12l7 7v22H9V8a3 3 0 0 1 3-3Z" stroke="currentColor" strokeWidth="1.5"/><path d="M23 5v9h8M15 21h10M15 27h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  <h3>暂无报告</h3>
                  <p>生成后的监测报告将在这里统一管理。</p>
                  <span className="empty-note">打开业务页面后，在上方选择页面并生成采集报告。</span>
                  <button className="secondary-button" onClick={() => { setActiveTab("sources"); sourcesTab.current?.focus(); }}>查看数据源</button>
                </div>
              </td></tr>}</tbody>
            </table>
          </div>
          <div className="panel-footnote">本地网页采集报告 · 保留原始页面内容</div>
        </section>

        <section id="sources-panel" className="workspace-panel" role="tabpanel" aria-labelledby="sources-tab" tabIndex={0} hidden={activeTab !== "sources"}>
          <div className="panel-toolbar"><div><h2>业务数据源</h2><span className="muted">{targetSites.length} 个网站</span></div><span className="muted">{connected ? "根据 Chrome 中实际打开的页面更新" : "请先连接插件"}</span></div>
          <div className="source-list">
            {targetSites.map((site) => { const tabs = availableTabs.filter((tab) => { try { return new URL(tab.url).origin === new URL(site.url).origin; } catch { return false; } }); return <article className="source-row" key={site.id}>
              <div className="source-copy"><h3>{site.name}</h3><p>{site.description}</p><span className="source-host" title={site.url}>{new URL(site.url).host}</span></div>
              <span className="source-status"><span className={`status-dot${tabs.some((tab) => tab.status === "complete") ? " connected" : ""}`} />{!connected ? "插件未连接" : tabs.length ? tabs.some((tab) => tab.status === "complete") ? `已打开 ${tabs.length} 页` : "加载中" : "未打开"}</span>
              <button className="secondary-button" onClick={() => void openSite(site)}>打开网站 <span aria-hidden="true">↗</span></button>
            </article>; })}
          </div>
          <p className="source-help">状态表示 Chrome 中的页面是否打开，不代表已登录或业务数据完整。打开并登录网站后，在报告列表选择具体页面采集。</p>
        </section>
      </main>

      <footer className="status-bar">
        <details className="plugin-details" ref={pluginDetails} onKeyDown={(event) => {
          if (event.key === "Escape" && pluginDetails.current) {
            pluginDetails.current.open = false;
            pluginDetails.current.querySelector("summary")?.focus();
          }
        }}>
          <summary><span className={`status-dot${connected ? " connected" : ""}`} />Chrome 插件 · {pluginLabel}<span className="status-caret" aria-hidden="true">⌃</span></summary>
          <section className="plugin-popover" aria-label="Chrome 插件安装">
            <div className="popover-heading"><h2>Chrome 插件</h2><button className="icon-button" aria-label="关闭插件说明" onClick={() => {
              if (pluginDetails.current) {
                pluginDetails.current.open = false;
                pluginDetails.current.querySelector("summary")?.focus();
              }
            }}>×</button></div>
            <p>{connected ? `插件已连接（v${bridge?.versions.join("、")}），检测到 ${availableTabs.length} 个业务页面。` : "安装或更新插件后，请在扩展管理页重新加载插件，并保持 Chrome 运行。连接可能需要约 30 秒。"}</p>
            {(bridgeError || bridge?.error) && <p role="alert">{bridgeError || bridge?.error}</p>}
            <ol><li>打开 Chrome 扩展管理页。</li><li>开启右上角「开发者模式」。</li><li>选择「加载已解压的扩展程序」，选择下方完整路径对应的文件夹。</li></ol>
            {extensionDirectory ? <div className="extension-directory">
              <p>本机插件目录</p>
              <code className="extension-path">{extensionDirectory.path}</code>
              <div className="extension-actions">
                <button className="secondary-button" onClick={() => void copyExtensionPath()}>复制路径</button>
                <button className="secondary-button" onClick={() => void openExtensionFolder()}>打开文件夹</button>
              </div>
              <p className="extension-path-help">{extensionDirectory.platform === "macos"
                ? "在选择文件夹窗口按 ⌘⇧G，粘贴路径并回车，再点击「选择」。"
                : extensionDirectory.platform === "windows"
                  ? "在选择文件夹窗口按 Ctrl+L，粘贴路径并回车，再点击「选择文件夹」。"
                  : "在选择文件夹窗口中输入或粘贴此完整路径。"}</p>
            </div> : <p className="extension-directory" role="status">{extensionPathError || "正在获取本机插件目录…"}</p>}
            <button className="secondary-button" disabled={openingExtension} onClick={() => void openExtensionManager()}>{openingExtension ? "正在打开…" : "打开扩展管理"}</button>
            {extensionMessage && <p className="extension-message" role="status">{extensionMessage}</p>}
          </section>
        </details>
        <span className="local-status">本地工作区</span>
        <UpdateBanner />
      </footer>
    </div>
  );
}

export default App;
