// All automation uses this facade; discovery never includes personal platform tabs.
export function createManagedChrome(api) {
  const title = api.runtime.getManifest().name.includes('开发版')
    ? '泰州监测 · App 托管（开发版）' : '泰州监测 · App 托管';
  let queue = Promise.resolve();
  const serial = action => {
    const result = queue.catch(() => {}).then(action);
    queue = result;
    return result;
  };
  const key = 'managed-tab-group';
  async function group() {
    const saved = (await api.storage.session.get(key))[key];
    if (Number.isInteger(saved)) {
      const existing = await api.tabGroups.get(saved).catch(() => null);
      if (existing) return existing;
    }
    const groups = await api.tabGroups.query({ title });
    if (groups[0]) await api.storage.session.set({ [key]: groups[0].id });
    return groups[0] || null;
  }
  async function ensure(tab) {
    const target = await group();
    if (target && tab.groupId === target.id) return tab;
    if (tab.pinned) tab = await api.tabs.update(tab.id, { pinned: false });
    if (target && tab.windowId !== target.windowId) {
      tab = await api.tabs.move(tab.id, { windowId: target.windowId, index: -1 });
    }
    const id = await api.tabs.group({ tabIds: tab.id, ...(target ? { groupId: target.id } : {}) });
    await api.tabGroups.update(id, { title, color: 'blue' });
    await api.storage.session.set({ [key]: id });
    return api.tabs.get(tab.id);
  }
  const tabs = {
    ...api.tabs,
    get: id => serial(async () => ensure(await api.tabs.get(id))),
    create: options => serial(async () => {
      const target = await group();
      const tab = await api.tabs.create({ ...options, ...(target ? { windowId: target.windowId } : {}) });
      try { return await ensure(tab); }
      catch (error) {
        await api.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
    }),
    query: options => serial(async () => {
      const target = await group();
      return target ? api.tabs.query({ ...options, groupId: target.id }) : [];
    }),
    update: (id, options) => serial(async () => {
      await ensure(await api.tabs.get(id));
      return api.tabs.update(id, options);
    }),
  };
  return { ...api, tabs };
}
