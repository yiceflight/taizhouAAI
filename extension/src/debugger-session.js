export function createDebuggerSession(api, allowedUrl) {
  const attached = new Set();
  let anchor = null;
  let suspended = false;

  async function acquire(tabId) {
    if (suspended) throw new Error('Chrome 调试已取消，请点击浏览器桥接插件图标后重试');
    if (attached.has(tabId)) return false;
    await api.attach({ tabId }, '1.3');
    attached.add(tabId);
    return true;
  }

  async function release(tabId, acquired) {
    if (!acquired || anchor === tabId) return;
    attached.delete(tabId);
    await api.detach({ tabId }).catch(() => {});
  }

  async function maintain(tabs) {
    if (anchor !== null && !tabs.some(tab => tab.id === anchor && allowedUrl(tab.url))) {
      const old = anchor;
      anchor = null;
      await release(old, true);
    }
    if (anchor !== null || suspended) return;
    const candidate = tabs.filter(tab => tab.status === 'complete' && allowedUrl(tab.url))
      .sort((a, b) => Number(b.url.startsWith('https://aai.airins.cn/sniff')) - Number(a.url.startsWith('https://aai.airins.cn/sniff')))[0];
    if (!candidate) return;
    try {
      await acquire(candidate.id);
      anchor = candidate.id;
    } catch {
      // DevTools or another debugger may own this tab. A later heartbeat can retry.
    }
  }

  function detached(tabId, reason) {
    attached.delete(tabId);
    if (anchor === tabId) anchor = null;
    if (reason === 'canceled_by_user') suspended = true;
  }

  return { acquire, release, maintain, detached, resume: () => { suspended = false; } };
}
