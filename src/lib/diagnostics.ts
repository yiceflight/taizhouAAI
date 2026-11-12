import { invoke } from '@tauri-apps/api/core';

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack,
      cause: 'cause' in error ? String(error.cause) : undefined };
  }
  try { return { value: JSON.parse(JSON.stringify(error)) }; }
  catch { return { value: String(error) }; }
}

// Summaries supplied by the caller. They describe the job being collected, not
// the browser session, so no cookie, storage or page text is ever inspected.
export type BrowserJobSummary = {
  id?: number; type?: string; url?: string; status?: string; active?: boolean;
  windowId?: number; discarded?: boolean; frozen?: boolean;
};

// The Airins chart check depends on the visible viewport. Without these
// numbers a "plot area incomplete" failure cannot be told apart from a
// genuinely broken page, so they are reported as facts only.
export function clientEnvironment(tabs: BrowserJobSummary[] = [], version?: string, extra: Record<string, unknown> = {}) {
  // Diagnostics must never break a business path. Outside a browser (tests,
  // prerender) the viewport globals are absent, so report what exists.
  const viewport = viewportSize();
  return {
    at: Date.now(),
    version: version ?? null,
    // WebView2 viewport, not the whole screen.
    main: { ...viewport, userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent, language: typeof navigator === 'undefined' ? null : navigator.language },
    // Which pages are open is the evidence for leftover tabs, so keep the
    // route (FlightHub routes live in the hash) and drop only parameters.
    tabCount: tabs.length,
    tabs: tabs.slice(0, 100).map(tab => ({ ...tab, url: tab.url ? tabRoute(tab.url) : tab.url })),
    ...extra,
  };
}

export function tabRoute(url: string) {
  const [page, ...hash] = url.split('#');
  const route = hash.length ? `#${hash.join('#').replace(/\?.*$/, '')}` : '';
  return page.replace(/\?.*$/, page.includes('?missionId=') ? '?missionId' : '') + route;
}

function viewportSize() {
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const screenValue = typeof screen === 'undefined' ? null : screen;
  const width = num(screenValue?.width), height = num(screenValue?.height);
  const availWidth = num(screenValue?.availWidth), availHeight = num(screenValue?.availHeight);
  const outerWidth = num(globalThis.outerWidth), outerHeight = num(globalThis.outerHeight);
  return {
    innerWidth: num(globalThis.innerWidth), innerHeight: num(globalThis.innerHeight),
    outerWidth, outerHeight, devicePixelRatio: num(globalThis.devicePixelRatio),
    screen: { width, height, availWidth, availHeight },
    maximized: outerWidth != null && outerHeight != null && availWidth != null && availHeight != null
      ? outerWidth >= availWidth && outerHeight >= availHeight : null,
  };
}

export function recordFrontendError(kind: string, error: unknown, extra: Record<string, unknown> = {}) {
  // A diagnostic IPC failure must not itself create an unhandled rejection loop.
  // The failure being reported is the priority: never let a missing browser
  // global replace it with a ReferenceError raised by this recorder.
  try {
    void invoke('record_frontend_error', { kind, details: {
      ...describe(error), ...extra,
      url: typeof location === 'undefined' ? null : location.href,
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
      at: Date.now(),
    } }).catch(() => {});
  } catch { /* Recording must never throw into the caller. */ }
}

// Report generation failures already surface in the task row, but only as
// prose. Keep the machine-readable reason next to it so a diagnostic packet
// can be read without guessing which check failed. Only identifiers and
// counts are added; the message itself is unchanged.
export function reportFailureDetail(task: { key: string; djiTask?: { taskId?: string; mediaReady?: boolean; mediaUploadedCount?: number; mediaExpectedCount?: number; status?: string } | undefined; mission?: { missionId?: number; missionName?: string; startTime?: number; endTime?: number } | null }, error: unknown) {
  const detail = String(error).replace(/^Error:\s*/, '');
  return {
    taskKey: task.key,
    djiTaskId: task.djiTask?.taskId ?? null,
    djiStatus: task.djiTask?.status ?? null,
    mediaReady: task.djiTask?.mediaReady ?? null,
    mediaUploaded: task.djiTask?.mediaUploadedCount ?? null,
    mediaExpected: task.djiTask?.mediaExpectedCount ?? null,
    missionId: task.mission?.missionId ?? null,
    missionName: task.mission?.missionName ?? null,
    window: task.mission ? [task.mission.startTime, task.mission.endTime] : null,
    reason: /airinsHistoryRouteMatches\s+is not defined/.test(detail) ? 'extension_script_incomplete'
      : /^ReferenceError:|^TypeError:/.test(detail) ? 'extension_script_failed'
      : /显示区域不完整|截图尺寸不符/.test(detail) ? 'airins_chart_clipped'
      : /尚无 Immediate-Media|照片尚未上传|司空媒体解析失败/.test(detail) ? 'media_not_ready'
      : /司空媒体无照片/.test(detail) ? 'media_no_photo'
      : /登录/.test(detail) ? 'login_required'
      : 'other',
    detail,
    windowSize: viewportSize(),
  };
}

export function installFrontendDiagnostics() {
  const onError = (event: ErrorEvent) => recordFrontendError('window.error', event.error ?? event.message,
    { filename: event.filename, line: event.lineno, column: event.colno });
  const onRejection = (event: PromiseRejectionEvent) => recordFrontendError('unhandledrejection', event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
