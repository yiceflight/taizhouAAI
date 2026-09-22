import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { version as configuredVersion } from "../../src-tauri/tauri.conf.json";
import { checkForAppUpdate, type AppUpdateProgress, type AvailableAppUpdate } from "../lib/appUpdater";

export function UpdateBanner() {
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

  const checkUpdate = useCallback(async () => {
    if (busy.current || currentUpdate.current) return;
    if (!isTauri()) {
      setMessage("请在客户端检查更新");
      return;
    }
    busy.current = true;
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
      setMessage(result ? "" : "已是最新版本");
    } catch (error) {
      if (mounted.current) {
        setError(true);
        setMessage(String(error));
      }
    } finally {
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (isTauri()) void getVersion().then((value) => { if (mounted.current) setVersion(value); }).catch(() => {});
    if (import.meta.env.PROD && isTauri()) void checkUpdate();
    const timer = window.setInterval(() => {
      if (import.meta.env.PROD && isTauri()) void checkUpdate();
    }, 6 * 60 * 60 * 1000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      const available = currentUpdate.current;
      currentUpdate.current = null;
      if (available) void available.close().catch(() => {});
    };
  }, [checkUpdate]);

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
        setMessage(`更新失败：${String(error)}`);
      }
    } finally {
      busy.current = false;
      if (mounted.current) {
        setInstalling(false);
        setProgress(null);
      }
    }
  };

  const percent = progress?.phase === "downloading" && progress.totalBytes
    ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : null;
  const installLabel = progress?.phase === "installing" ? "安装并重启中…"
    : installing ? `下载中${percent === null ? "…" : ` ${percent}%`}` : "下载并重启";

  return <div className="update-status">
    <span className="app-version">v{version}</span>
    <span className={`update-message${error ? " error" : ""}`} role="status" title={message}>
      {message || (update ? `新版本 v${update.latestVersion}` : "")}
    </span>
    {update ? <button className="update-install" disabled={installing} title={update.releaseNotes.join("\n")} onClick={() => void installUpdate()}>{installLabel}</button>
      : <button className="update-action" disabled={checking} onClick={() => void checkUpdate()}>{checking ? "正在检查…" : "检查更新"}</button>}
  </div>;
}
