import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedChrome } from '../extension/src/managed-tabs.js';

function fixture() {
  const tabs = new Map([[1, { id: 1, url: 'https://fh.dji.com/', windowId: 1, groupId: -1 }]]);
  const groups = new Map(), saved = {}, localSaved = {};
  let nextTab = 2, nextGroup = 1, fail = false;
  const api = {
    runtime: { getManifest: () => ({ name: '浏览器桥接' }) },
    storage: {
      session: { get: async () => saved, set: async value => Object.assign(saved, value) },
      local: { get: async () => localSaved, set: async value => Object.assign(localSaved, value) },
    },
    tabGroups: {
      query: async ({ title, groupId } = {}) => {
        if (Number.isInteger(groupId)) return [...tabs.values()].filter(t => t.groupId === groupId);
        return [...groups.values()].filter(g => title === undefined || g.title === title);
      },
      get: async id => { if (!groups.has(id)) throw Error('closed'); return groups.get(id); },
      update: async (id, value) => Object.assign(groups.get(id), value),
    },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw Error('closed'); return { ...tabs.get(id) }; },
      create: async opts => { const tab = { id: nextTab++, groupId: -1, windowId: 2, ...opts }; tabs.set(tab.id, tab); return { ...tab }; },
      query: async opts => [...tabs.values()].filter(t => t.groupId === opts.groupId),
      update: async (id, opts) => Object.assign(tabs.get(id), opts),
      move: async (id, opts) => Object.assign(tabs.get(id), opts),
      remove: async id => { tabs.delete(id); },
      group: async ({ tabIds, groupId }) => {
        if (fail) throw Error('group failed');
        const tab = tabs.get(tabIds), id = groupId ?? nextGroup++;
        if (groupId !== undefined) assert.equal(groups.get(id).windowId, tab.windowId);
        else groups.set(id, { id, windowId: tab.windowId });
        tab.groupId = id; return id;
      },
    },
  };
  return { api, tabs, groups, saved, localSaved, setFailure: () => { fail = true; } };
}

test('concurrent creation uses one group and excludes personal platform pages', async () => {
  const f = fixture(), chrome = createManagedChrome(f.api);
  assert.deepEqual(await chrome.tabs.query({}), []);
  const created = await Promise.all(Array.from({ length: 5 }, () => chrome.tabs.create({ url: 'https://fh.dji.com/', active: false })));
  assert.equal(f.groups.size, 1);
  assert.equal(new Set(created.map(t => t.groupId)).size, 1);
  assert.equal(f.tabs.get(1).groupId, -1);
  assert.equal((await chrome.tabs.query({})).length, 5);
  assert.ok(created.every(t => t.active === false));
});

test('worker restart reuses group, existing owned tab moves across windows, group closure recovers', async () => {
  const f = fixture();
  const first = await createManagedChrome(f.api).tabs.create({ url: 'https://fh.dji.com/' });
  for (const key of Object.keys(f.saved)) delete f.saved[key];
  const chrome = createManagedChrome(f.api);
  f.tabs.set(20, { id: 20, windowId: 9, groupId: -1, pinned: true });
  const moved = await chrome.tabs.get(20);
  assert.equal(moved.windowId, first.windowId);
  assert.equal(moved.groupId, first.groupId);
  assert.equal(moved.pinned, false);
  assert.equal(f.groups.size, 1);
  f.groups.clear(); f.tabs.delete(first.id); f.tabs.delete(20);
  const replacement = await chrome.tabs.create({ active: false });
  assert.notEqual(replacement.groupId, first.groupId);
  assert.equal(f.tabs.get(1).groupId, -1);
});

test('grouping failure closes only the newly created page and fails the operation', async () => {
  const f = fixture(); f.setFailure();
  await assert.rejects(createManagedChrome(f.api).tabs.create({}), /group failed/);
  assert.deepEqual([...f.tabs.keys()], [1]);
});

test('reuses and merges duplicate same-named groups after a worker restart', async () => {
  const f = fixture();
  f.groups.set(10, { id: 10, windowId: 1, title: '泰州监测 · App 托管' });
  f.groups.set(11, { id: 11, windowId: 2, title: '泰州监测 · App 托管' });
  f.tabs.set(20, { id: 20, windowId: 2, groupId: 11, pinned: false });
  const chrome = createManagedChrome(f.api);
  const tab = await chrome.tabs.create({ url: 'https://fh.dji.com/', active: false });
  assert.equal(tab.groupId, 10);
  assert.equal(f.tabs.get(20).groupId, 10);
  assert.equal(f.tabs.get(20).windowId, 1);
  assert.equal(f.groups.size, 2);
});
