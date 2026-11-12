import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createTabJanitor, backgroundPage, LIMITS } from '../extension/src/tab-janitor.js';
import { PLAN_URL } from '../extension/src/flight-plan.js';
import { WEATHER_URL } from '../extension/src/dji-weather.js';

const DRAFT = `${PLAN_URL}/create-plan`;
const MEDIA = PLAN_URL.replace('#/plan', '#/media?page=1&size=50');
const CHART = 'https://aai.airins.cn/sniff/HistoryCloud?missionId=7';
const event = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const MINUTE = 60000;

// `grouped` is what the managed facade lists; `outside` exists in Chrome but
// was moved out of the App group by the user.
function fixture({ tabs = [], outside = [], stored = {}, busy = false } = {}) {
  const state = { time: 1_000_000_000, closed: [], reloaded: [], busy, online: true };
  const grouped = new Map(tabs.map(tab => [tab.id, { ...tab }]));
  const elsewhere = new Set(outside);
  const chrome = {
    storage: { local: {
      get: async key => key == null ? { ...stored } : { [key]: stored[key] },
      set: async values => { Object.assign(stored, values); },
      remove: async keys => { for (const key of [].concat(keys)) delete stored[key]; },
    } },
    tabs: {
      query: async () => [...grouped.values()],
      get: async id => { if (!grouped.has(id)) throw new Error('No tab'); return grouped.get(id); },
      remove: async id => { if (!grouped.delete(id)) throw new Error('No tab'); state.closed.push(id); },
      reload: async id => { state.reloaded.push(id); },
    },
  };
  const transient = new Set();
  const janitor = createTabJanitor(chrome, {
    now: () => state.time, busy: () => state.busy, transient: () => [...transient],
    exists: async id => grouped.has(id) || elsewhere.has(id), connected: () => state.online,
  });
  return { state, grouped, stored, transient, janitor, advance: ms => { state.time += ms; } };
}

test('a submitted flight page is closed after the grace period while its claim survives', async () => {
  const id = event(1);
  const f = fixture({
    tabs: [{ id: 5, url: PLAN_URL }, { id: 6, url: PLAN_URL }],
    stored: { [`flight-${id}`]: 5, [`flight-review-${id}`]: { tabId: 5 }, 'flight-task-sync-tab': 6 },
  });
  f.stored[`flight-submit-${id}`] = { attemptedAt: f.state.time };
  assert.deepEqual((await f.janitor.sweep()).closed, []);
  f.advance(LIMITS.submittedGrace);
  assert.deepEqual((await f.janitor.sweep()).closed, [5]);
  assert.deepEqual(Object.keys(f.stored).sort(), ['flight-submit-' + id, 'flight-task-sync-tab']);
  assert.ok(f.grouped.has(6));
});

test('the page the operator is looking at stays until the flight is long over', async () => {
  const id = event(2);
  const f = fixture({ tabs: [{ id: 5, url: PLAN_URL, active: true }], stored: { [`flight-${id}`]: 5 } });
  f.stored[`flight-submit-${id}`] = { attemptedAt: f.state.time };
  f.advance(LIMITS.flightIdle - 1);
  assert.deepEqual((await f.janitor.sweep()).closed, []);
  f.advance(1);
  assert.deepEqual((await f.janitor.sweep()).closed, [5]);
});

test('an unsubmitted draft the client still polls is never closed', async () => {
  const id = event(3);
  const f = fixture({ tabs: [{ id: 5, url: DRAFT }], stored: { [`flight-${id}`]: 5 } });
  for (let elapsed = 0; elapsed < LIMITS.draftIdle * 2; elapsed += 20000) {
    f.advance(20000);
    await f.janitor.touchFlight(id);
    if (elapsed % (5 * MINUTE) === 0) assert.deepEqual((await f.janitor.sweep()).closed, []);
  }
  f.advance(LIMITS.draftIdle - MINUTE);
  assert.deepEqual((await f.janitor.sweep()).closed, []);
  f.advance(2 * MINUTE);
  assert.deepEqual((await f.janitor.sweep()).closed, [5]);
  assert.deepEqual(f.stored, {});
});

test('time without the client does not count against a waiting draft', async () => {
  const id = event(11);
  const f = fixture({ tabs: [{ id: 5, url: DRAFT }, { id: 6, url: PLAN_URL }], stored: { [`flight-${id}`]: 5, 'flight-monitor-tab': 6 } });
  await f.janitor.sweep();
  f.state.online = false;
  for (let i = 0; i < 40; i++) { f.advance(5 * MINUTE); assert.deepEqual((await f.janitor.sweep()).closed, []); }
  f.state.online = true;
  f.advance(LIMITS.monitorIdle);
  assert.deepEqual((await f.janitor.sweep()).closed, [6]);
  f.advance(LIMITS.draftIdle - LIMITS.monitorIdle);
  assert.deepEqual((await f.janitor.sweep()).closed, [5]);
});

test('a page from an older extension gets a fresh clock instead of closing a live draft', async () => {
  const live = event(4), failed = event(5);
  const f = fixture({
    tabs: [{ id: 5, url: DRAFT }, { id: 6, url: DRAFT }],
    stored: { [`flight-${live}`]: 5, [`flight-${failed}`]: 6, [`flight-submit-${failed}`]: { attemptedAt: 1 } },
  });
  assert.deepEqual((await f.janitor.sweep({ startup: true })).closed, []);
  assert.equal(f.stored[`flight-seen-${live}`], f.state.time);
  // A failed submission keeps its draft so the platform's reason can be read,
  // but only while the client still asks about that event.
  f.advance(LIMITS.flightIdle);
  await f.janitor.touchFlight(live);
  assert.deepEqual((await f.janitor.sweep()).closed, [6]);
  assert.ok(f.stored[`flight-submit-${failed}`]);
});

test('records of closed pages are removed and activity is not recorded for them', async () => {
  const id = event(6);
  const f = fixture({ stored: { [`flight-${id}`]: 5, [`flight-review-${id}`]: {}, [`flight-seen-${id}`]: 1, [`flight-seen-${event(7)}`]: 1 } });
  await f.janitor.sweep();
  assert.deepEqual(f.stored, {});
  await f.janitor.touchFlight(id);
  assert.deepEqual(f.stored, {});
});

test('a saved ID outside the App group or on another site is never closed', async () => {
  const moved = event(8), reused = event(9);
  const f = fixture({
    tabs: [{ id: 6, url: 'https://aai.airins.cn/sniff/HistoryCloud' }], outside: [5],
    stored: { [`flight-${moved}`]: 5, [`flight-${reused}`]: 6, [`flight-seen-${moved}`]: 1, [`flight-seen-${reused}`]: 1 },
  });
  assert.deepEqual((await f.janitor.sweep()).closed, []);
  assert.equal(f.stored[`flight-${moved}`], 5);
  assert.equal(f.stored[`flight-${reused}`], undefined);
  assert.ok(f.grouped.has(6));
});

test('leftover background pages close after ten idle minutes; other pages are untouched', async () => {
  const f = fixture({
    tabs: [
      { id: 1, url: PLAN_URL }, { id: 2, url: PLAN_URL }, { id: 3, url: MEDIA }, { id: 4, url: CHART },
      { id: 5, url: WEATHER_URL }, { id: 6, url: DRAFT }, { id: 7, url: 'https://aai.airins.cn/sniff/HistoryCloud' },
      { id: 8, url: 'http://61.155.4.60:18080/#/home/map' }, { id: 9, url: PLAN_URL, active: true },
      { id: 10, url: MEDIA }, { id: 11, url: CHART }, { id: 12, url: PLAN_URL },
    ],
    stored: { 'flight-task-sync-tab': 1, 'flight-report-tab:a': { tabId: 10, lastUsedAt: 1 } },
  });
  f.transient.add(11);
  assert.deepEqual((await f.janitor.sweep()).closed, []);
  f.grouped.get(12).lastAccessed = f.state.time + MINUTE;
  f.advance(LIMITS.unownedIdle);
  assert.deepEqual((await f.janitor.sweep()).closed, [2, 3, 4, 5]);
  assert.deepEqual([...f.grouped.keys()], [1, 6, 7, 8, 9, 10, 11, 12]);
  f.advance(MINUTE);
  assert.deepEqual((await f.janitor.sweep()).closed, [12]);
});

test('worker start closes leftovers at once, including abandoned drafts', async () => {
  const f = fixture({
    tabs: [{ id: 1, url: PLAN_URL }, { id: 2, url: PLAN_URL }, { id: 3, url: DRAFT }, { id: 4, url: MEDIA, active: true }],
    stored: { weatherTabId: 1 },
  });
  assert.deepEqual((await f.janitor.sweep({ startup: true })).closed, [2, 3]);
});

test('one plan list is left for site health until a dedicated page exists', async () => {
  const f = fixture({ tabs: [{ id: 3, url: PLAN_URL }, { id: 2, url: PLAN_URL }, { id: 4, url: PLAN_URL }] });
  assert.deepEqual((await f.janitor.sweep({ startup: true })).closed, [3, 4]);
  f.stored['flight-task-sync-tab'] = 9;
  f.grouped.set(9, { id: 9, url: PLAN_URL });
  assert.deepEqual((await f.janitor.sweep({ startup: true })).closed, [2]);
});

test('the status page closes once no flight has been polled for half an hour', async () => {
  const f = fixture({ tabs: [{ id: 3, url: PLAN_URL }], stored: { 'flight-monitor-tab': 3 } });
  await f.janitor.touchMonitor();
  f.advance(LIMITS.monitorIdle - 1);
  assert.deepEqual((await f.janitor.sweep()).closed, []);
  f.advance(1);
  assert.deepEqual((await f.janitor.sweep()).closed, [3]);
  assert.deepEqual(f.stored, {});
});

test('nothing is closed while a flight plan or chart job is running', async () => {
  const id = event(10);
  const f = fixture({ tabs: [{ id: 5, url: PLAN_URL }, { id: 6, url: MEDIA }], stored: { [`flight-${id}`]: 5, [`flight-submit-${id}`]: { attemptedAt: 1 } }, busy: true });
  assert.deepEqual(await f.janitor.sweep({ startup: true }), { skipped: true, closed: [] });
  assert.equal(f.grouped.size, 2);
});

test('a failed read reloads only the dedicated plan list, once per cooldown', async () => {
  const f = fixture({ tabs: [{ id: 3, url: PLAN_URL }, { id: 4, url: MEDIA }], stored: { 'flight-task-sync-tab': 3, 'flight-monitor-tab': 4 } });
  assert.equal(await f.janitor.recover('dji-tasks', '司空登录已失效，请在 Chrome 完成登录后刷新任务'), false);
  assert.equal(await f.janitor.recover('dji-tasks', '司空任务列表尚未加载完成，请稍后刷新任务'), true);
  assert.equal(await f.janitor.recover('dji-tasks', '后台页面读取超时，请检查网站或网络后重试'), false);
  f.advance(LIMITS.reloadCooldown);
  assert.equal(await f.janitor.recover('dji-tasks', '后台页面读取超时，请检查网站或网络后重试'), true);
  // The status page was navigated away from the plan list: leave it alone.
  assert.equal(await f.janitor.recover('dji-status', '司空状态查询未完成，请稍后重试；未推断任务结束'), false);
  assert.equal(await f.janitor.recover('dji-weather', '后台页面读取超时'), false);
  assert.deepEqual(f.state.reloaded, [3, 3]);
});

test('user drafts are only treated as leftovers at worker start', () => {
  assert.equal(backgroundPage(DRAFT), false);
  assert.equal(backgroundPage(DRAFT, { drafts: true }), true);
  assert.equal(backgroundPage('https://fh.dji.com/login'), false);
  assert.equal(backgroundPage('https://aai.airins.cn/sniff/Realtime'), false);
});

const worker = readFileSync(new URL('../extension/src/service-worker.js', import.meta.url), 'utf8');
const opener = worker.slice(worker.indexOf('async function openBusinessSite(url)'), worker.indexOf('async function bridgeTabs()'));
test('opening a site reuses and refreshes the managed page instead of adding another', async () => {
  for (const capturing of [false, true]) {
    const calls = [];
    const tabs = [{ id: 1, url: MEDIA }, { id: 2, url: PLAN_URL }, { id: 3, url: PLAN_URL }];
    const context = {
      capturing, SITE_PATTERNS: [], allowedUrl: url => url.startsWith('https://fh.dji.com/'),
      transientTabs: new Set(), reportTabs: new Map([['a', 2]]),
      chrome: {
        tabs: {
          query: async () => tabs,
          update: async (id, options) => { calls.push(['update', id, options]); return { id, windowId: 8 }; },
          reload: async id => { calls.push(['reload', id]); },
          create: async options => { calls.push(['create', options.url]); return { id: 9, windowId: 8 }; },
        },
        windows: { update: async (id, options) => { calls.push(['focus', id, options]); } },
      },
    };
    await vm.runInNewContext(`${opener}; openBusinessSite(${JSON.stringify(PLAN_URL)})`, context);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['update', 3, { active: true }], ...(capturing ? [] : [['reload', 3]]), ['focus', 8, { focused: true }]]);
    calls.length = 0;
    await vm.runInNewContext(`${opener}; openBusinessSite('https://fh.dji.com/other')`, context);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['create', 'https://fh.dji.com/other'], ['focus', 8, { focused: true }]]);
    await assert.rejects(vm.runInNewContext(`${opener}; openBusinessSite('https://example.test/')`, context), /不支持/);
  }
});
