import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTaskTabManager, waitForTaskList } from '../extension/src/task-tab.js';
import { PLAN_URL } from '../extension/src/flight-plan.js';

function fixture() {
  const tabs = new Map(), saved = {}, created = [], updated = [];
  let time = 0;
  const chrome = {
    tabs: {
      get: async id => tabs.get(id) || null,
      create: async options => { created.push(options); const tab = { id: created.length, url: options.url, status: 'complete' }; tabs.set(tab.id, tab); return tab; },
      update: async (id, options) => { updated.push(id); Object.assign(tabs.get(id), options); return tabs.get(id); },
    },
    storage: { local: { get: async () => saved, set: async values => Object.assign(saved, values) } },
  };
  return { tabs, saved, created, updated, chrome, options: { now: () => time, pause: async () => { time += 200; } } };
}

test('concurrent calls share one background tab, reuse across manager restart, and recover after close', async () => {
  const f = fixture(), acquire = createTaskTabManager(f.chrome, f.options);
  const [a, b] = await Promise.all([acquire(), acquire()]);
  assert.equal(a.id, b.id); assert.equal(f.created.length, 1); assert.equal(f.created[0].active, false);
  assert.equal((await createTaskTabManager(f.chrome, f.options)()).id, a.id);
  f.tabs.delete(a.id);
  assert.notEqual((await acquire()).id, a.id); assert.equal(f.created.length, 2);
});

test('user navigation is preserved and a replacement task page is created once', async () => {
  const f = fixture(), acquire = createTaskTabManager(f.chrome, f.options);
  const tab = await acquire(); tab.url = PLAN_URL.replace('#/plan', '#/media');
  const replacement = await acquire(); await acquire();
  assert.notEqual(tab.id, replacement.id); assert.match(tab.url, /#\/media$/);
  assert.equal(f.updated.length, 0); assert.equal(f.created.length, 2);
});

test('loading timeout retains the owned tab for recovery', async () => {
  const f = fixture(), acquire = createTaskTabManager(f.chrome, f.options);
  const tab = await acquire(); tab.status = 'loading';
  await assert.rejects(acquire(), /加载超时/);
  tab.status = 'complete'; assert.equal((await acquire()).id, tab.id); assert.equal(f.created.length, 1);
});

test('login redirect retries the same tab and recovers after login elsewhere', async () => {
  const f = fixture(), acquire = createTaskTabManager(f.chrome, f.options);
  const tab = await acquire(); tab.url = 'https://fh.dji.com/#/login';
  const update = f.chrome.tabs.update;
  f.chrome.tabs.update = async () => tab;
  await assert.rejects(acquire(), /登录已失效/);
  await assert.rejects(acquire(), /登录已失效/);
  assert.equal(f.created.length, 1);
  f.chrome.tabs.update = update;
  assert.equal((await acquire()).id, tab.id); assert.equal(f.created.length, 1);
});

test('waits for SPA table loading and accepts a loaded empty list', async () => {
  let time = 0, loading = true;
  const context = vm.createContext({
    Date: { now: () => time }, location: { href: PLAN_URL }, localStorage: { getItem: () => 'test' },
    document: { querySelector: selector => selector.includes('spin') ? loading : {} },
    setTimeout: resolve => { time += 200; loading = false; resolve(); },
  });
  await vm.runInContext(`(${waitForTaskList.toString()})(${JSON.stringify(PLAN_URL)})`, context);
  assert.equal(time, 200);
  context.document.querySelector = () => null;
  await assert.rejects(vm.runInContext(`(${waitForTaskList.toString()})(${JSON.stringify(PLAN_URL)})`, context), /尚未加载完成/);
});

test('waits past keyed date separators until a real task row is rendered', async () => {
  let time = 0;
  const dateRow = { querySelector: () => null, querySelectorAll: () => [] };
  const taskRow = { querySelector: () => (time >= 200 ? {} : null), querySelectorAll: () => [] };
  const context = vm.createContext({
    Date: { now: () => time }, location: { href: PLAN_URL }, localStorage: { getItem: () => 'test' },
    document: {
      querySelector: selector => selector.includes('spin') ? null : null,
      querySelectorAll: () => time >= 200 ? [dateRow, taskRow] : [dateRow],
    },
    setTimeout: resolve => { time += 200; resolve(); },
  });
  await vm.runInContext(`(${waitForTaskList.toString()})(${JSON.stringify(PLAN_URL)})`, context);
  assert.equal(time, 200);
});
