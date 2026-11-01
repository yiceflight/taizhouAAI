export function createDebuggerSession(api, allowedUrl) {
  const attached = new Map();
  const locks = new Map();
  let anchor = null;
  let anchorLease = null;
  let maintenance = null;
  let suspended = false;
  async function locked(tabId, action) {
    const previous = locks.get(tabId) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(tabId, next);
    try { return await next; }
    finally { if (locks.get(tabId) === next) locks.delete(tabId); }
  }
  async function acquire(tabId) {
    return locked(tabId, async () => {
      if (suspended) throw new Error('Chrome 调试已取消，请点击浏览器桥接插件图标后重试');
      let lease = attached.get(tabId);
      if (!lease) {
        await api.attach({ tabId }, '1.3');
        lease = { users: 0 };
        attached.set(tabId, lease);
      }
      lease.users++;
      return lease;
    });
  }
  async function release(tabId, lease) {
    if (!lease) return;
    return locked(tabId, async () => {
      // A receipt from a detached generation cannot release a new connection.
      if (attached.get(tabId) !== lease) return;
      if (--lease.users > 0) return;
      attached.delete(tabId);
      await api.detach({ tabId }).catch(() => {});
    });
  }
  async function maintain(tabs) {
    if (maintenance) return maintenance;
    maintenance = (async () => {
      if (anchor !== null && !tabs.some(tab => tab.id === anchor && allowedUrl(tab.url))) {
        const old = anchor, lease = anchorLease;
        anchor = null; anchorLease = null;
        await release(old, lease);
      }
      if (anchor !== null || suspended) return;
      const candidate = tabs.filter(tab => tab.status === 'complete' && allowedUrl(tab.url))
        .sort((a, b) => Number(b.url.startsWith('https://aai.airins.cn/sniff')) - Number(a.url.startsWith('https://aai.airins.cn/sniff')))[0];
      if (!candidate) return;
      try {
        anchorLease = await acquire(candidate.id);
        anchor = candidate.id;
      } catch { /* DevTools may own this tab; retry on a later heartbeat. */ }
    })();
    try { await maintenance; } finally { maintenance = null; }
  }
  function detached(tabId, reason) {
    attached.delete(tabId);
    if (anchor === tabId) { anchor = null; anchorLease = null; }
    if (reason === 'canceled_by_user') suspended = true;
  }
  return { acquire, release, maintain, detached, resume: () => { suspended = false; } };
}
