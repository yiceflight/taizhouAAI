import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { version as configuredVersion } from "../../src-tauri/tauri.conf.json";
import { checkForAppUpdate, type AppUpdateProgress, type AvailableAppUpdate } from "../lib/appUpdater";
import { RequiredSetupDialog, type EnvironmentCheckProps } from './RequiredSetupDialog';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

export function UpdateBanner({ environment }: { environment?: EnvironmentCheckProps } = {}) {
  const [testEnvironment, setTestEnvironment] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    if (isTauri()) void invoke<boolean>("is_test_environment").then(value => { if (alive) setTestEnvironment(value); }).catch(() => { /* Keep updates disabled until the runtime environment is known. */ });
    else setTestEnvironment(import.meta.env.DEV);
    return () => { alive = false; };
  }, []);
  const [version, setVersion] = useState(configuredVersion);
  const [update, setUpdate] = useState<AvailableAppUpdate | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const currentUpdate = useRef<AvailableAppUpdate | null>(null);
  const nextAutoCheck = useRef(0);
  const automatic = testEnvironment === false && import.meta.env.PROD && isTauri();

  const checkUpdate = useCallback(async (background = false) => {
    if (testEnvironment !== false || busy.current || currentUpdate.current) return;
    if (!isTauri()) {
      setMessage("请在客户端检查更新");
      return;
    }
    busy.current = true;
    nextAutoCheck.current = Date.now() + CHECK_INTERVAL_MS;
    setChecking(true);
    setMessage("");
    setError(false);
    try {
      const result = await checkForAppUpdate();
      if (!mounted.current) {
        await result?.close();
        return;
      }
      currentUpdate.current = result;
      setUpdate(result);
      nextAutoCheck.current = Date.now() + CHECK_INTERVAL_MS;
      setMessage(result ? "" : background ? "自动检查：已是最新版本" : "已是最新版本");
    } catch (error) {
      nextAutoCheck.current = Date.now() + RETRY_INTERVAL_MS;
      if (mounted.current) {
        setError(true);
        console.warn("检查更新失败", error);
        setMessage(import.meta.env.PROD ? "暂时无法检查更新，5 分钟后自动重试" : "检查更新失败，请稍后重试");
      }
    } finally {
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [testEnvironment]);

  useEffect(() => {
    mounted.current = true;
    if (isTauri()) void getVersion().then((value) => { if (mounted.current) setVersion(value); }).catch(() => {});
    const checkWhenDue = () => {
      if (automatic && Date.now() >= nextAutoCheck.current) void checkUpdate(true);
    };
    const checkWhenOnline = () => { if (automatic) void checkUpdate(true); };
    checkWhenDue();
    // Also recover after sleep or a failed check, without waiting six hours.
    const timer = automatic ? window.setInterval(checkWhenDue, 60_000) : undefined;
    window.addEventListener("online", checkWhenOnline);
    window.addEventListener("focus", checkWhenDue);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("online", checkWhenOnline);
      window.removeEventListener("focus", checkWhenDue);
      const available = currentUpdate.current;
      currentUpdate.current = null;
      if (available) void available.close().catch(() => {});
    };
  }, [automatic, checkUpdate]);

  const installUpdate = async () => {
    if (!update || busy.current) return;
    busy.current = true;
    setInstalling(true);
    setError(false);
    setMessage("");
    setProgress(null);
    try {
      await update.install((value) => { if (mounted.current) setProgress(value); });
    } catch (error) {
      if (mounted.current) {
        setError(true);
        setMessage('更新未完成，请检查网络连接后重试。如仍失败，请联系技术支持。');
        setInstalling(false);
        setProgress(null);
      }
    } finally {
      busy.current = false;
    }
  };

  const percent = progress?.phase === "downloading" && progress.totalBytes
    ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : null;
  const installLabel = progress?.phase === "installing" ? "安装并重启中…"
    : installing ? `下载中${percent === null ? "…" : ` ${percent}%`}` : "下载并重启";

  const requiredUpdate = update ? <section className="required-update" aria-labelledby="required-update-title">
    <div className="section-heading"><div><h3 id="required-update-title">客户端新版本 v{update.latestVersion}</h3><p>当前版本 v{version} · 本次更新为必需更新</p></div><span className="badge warning">必须更新</span></div>
    {!!update.releaseNotes.length && <ul className="required-release-notes">{update.releaseNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    {installing && <div className="required-update-progress"><progress aria-label="客户端更新进度" max={100} value={percent ?? undefined} /><span role="status">{installLabel}</span></div>}
    {error && message && <p className="notice warning" role="alert">{message}</p>}
    <button className="primary-button update-install" disabled={installing} onClick={() => void installUpdate()}>有新版本 v{update.latestVersion}，{error ? '重试更新' : installLabel}</button>
  </section> : undefined;

  if (testEnvironment === true) return <><div className="update-status"><span className="app-version">测试版客户端 v{version}</span><span>独立数据与桥接端口 · 复用当前 Chrome · 不接收正式版更新</span></div><RequiredSetupDialog environment={environment} /></>;

  return <><div className="update-status">
    <span className="app-version">当前客户端 v{version}</span>
    {(!update || message) && <span className={`update-message${error ? " error" : ""}`} role="status" title={message}>
      {message || (automatic ? "已开启自动检查更新" : "")}
    </span>}
    {update ? <span className="update-message">有新版本 v{update.latestVersion}，请在弹窗中完成更新</span>
      : <button className="update-action" disabled={checking || testEnvironment === null} onClick={() => void checkUpdate()}>{checking ? "正在检查…" : "检查更新"}</button>}
  </div><RequiredSetupDialog environment={environment} update={requiredUpdate} /></>;
}
