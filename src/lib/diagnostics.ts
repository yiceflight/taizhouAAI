import { invoke } from '@tauri-apps/api/core';

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack,
      cause: 'cause' in error ? String(error.cause) : undefined };
  }
  try { return { value: JSON.parse(JSON.stringify(error)) }; }
  catch { return { value: String(error) }; }
}

export function recordFrontendError(kind: string, error: unknown, extra: Record<string, unknown> = {}) {
  // A diagnostic IPC failure must not itself create an unhandled rejection loop.
  void invoke('record_frontend_error', { kind, details: {
    ...describe(error), ...extra, url: location.href, userAgent: navigator.userAgent,
    at: Date.now(),
  } }).catch(() => {});
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
