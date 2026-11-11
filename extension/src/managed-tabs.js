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
  const sessionKey = 'managed-tab-group';
  const localKey = 'managed-tab-group-id';
  const stores = [api.storage.session, api.storage.local].filter(Boolean);
  async function remember(id) {
    await Promise.all(stores.map(store => store.set({ [sessionKey]: id, [localKey]: id }).catch(() => {})));
  }
  async function savedGroupIds() {
    const values = await Promise.all(stores.map(store => store.get([sessionKey, localKey]).catch(() => ({}))));
    return values.flatMap(value => [value?.[sessionKey], value?.[localKey]])
      .filter(id => Number.isInteger(id));
  }
  async function matchingGroups() {
    // Querying by title has been inconsistent on some Windows Chrome builds.
    // Enumerating groups also lets us repair duplicate groups left by older clients.
    return (await api.tabGroups.query({})).filter(candidate => candidate.title === title);
  }
  async function mergeDuplicateGroups(canonical, groups) {
    for (const duplicate of groups) {
      if (duplicate.id === canonical.id) continue;
      const tabs = await api.tabs.query({ groupId: duplicate.id }).catch(() => []);
      for (const tab of tabs) {
        let current = tab;
        if (current.pinned) current = await api.tabs.update(current.id, { pinned: false });
        if (current.windowId !== canonical.windowId) {
          current = await api.tabs.move(current.id, { windowId: canonical.windowId, index: -1 });
        }
        await api.tabs.group({ tabIds: current.id, groupId: canonical.id });
      }
    }
  }
  async function group() {
    const groups = await matchingGroups();
    const savedIds = await savedGroupIds();
    const saved = savedIds.map(id => groups.find(candidate => candidate.id === id)).find(Boolean);
    // Prefer a previously selected group; otherwise keep the oldest matching
    // group so a restart does not create another same-named group.
    const target = saved || groups.slice().sort((a, b) => a.id - b.id)[0];
    if (!target) return null;
    await remember(target.id);
    await mergeDuplicateGroups(target, groups);
    return target;
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
    await remember(id);
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
