import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_RELEASE_NOTES = 8;

export type AppUpdateProgress =
  | { phase: "downloading"; downloadedBytes: number; totalBytes?: number }
  | { phase: "installing" };

export interface AvailableAppUpdate {
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string[];
  install: (onProgress: (progress: AppUpdateProgress) => void) => Promise<void>;
  close: () => Promise<void>;
}

export function parseReleaseNotes(body?: string): string[] {
  if (!body?.trim()) return ["包含功能更新与稳定性改进"];
  const notes = body.split(/\r?\n/).map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")).filter(Boolean).slice(0, MAX_RELEASE_NOTES);
  return notes.length > 0 ? notes : ["包含功能更新与稳定性改进"];
}

function handleProgress(event: DownloadEvent, state: { downloadedBytes: number; totalBytes?: number }, onProgress: (progress: AppUpdateProgress) => void) {
  if (event.event === "Started") { state.downloadedBytes = 0; state.totalBytes = event.data.contentLength; }
  else if (event.event === "Progress") state.downloadedBytes += event.data.chunkLength;
  else { onProgress({ phase: "installing" }); return; }
  onProgress({ phase: "downloading", downloadedBytes: state.downloadedBytes, totalBytes: state.totalBytes });
}

function wrapUpdate(update: Update): AvailableAppUpdate {
  return {
    currentVersion: update.currentVersion,
    latestVersion: update.version,
    releaseNotes: parseReleaseNotes(update.body),
    install: async (onProgress) => {
      const state: { downloadedBytes: number; totalBytes?: number } = { downloadedBytes: 0 };
      await update.downloadAndInstall((event) => handleProgress(event, state, onProgress), { timeout: DOWNLOAD_TIMEOUT_MS, restartAfterInstall: true });
      onProgress({ phase: "installing" });
      await relaunch();
    },
    close: () => update.close(),
  };
}

export async function checkForAppUpdate(): Promise<AvailableAppUpdate | null> {
  await invoke("check_update_channel");
  const update = await check({ timeout: CHECK_TIMEOUT_MS });
  return update ? wrapUpdate(update) : null;
}
