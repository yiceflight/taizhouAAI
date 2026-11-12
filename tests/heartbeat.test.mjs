import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { evaluateBackgroundRead } from '../extension/src/background-read.js';
import { readOnlyJob, createReadScheduler } from '../extension/src/read-scheduler.js';
const source = await readFile(new URL('../extension/src/service-worker.js', import.meta.url), 'utf8');
const loop = source.slice(source.indexOf('async function bridgeTabs()'), source.indexOf('\nfunction start()'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(post, capture, now = Date.now) {
  const context = vm.createContext({
    chrome: { runtime: { getManifest: () => ({ version: '0.7.17' }) }, tabs: { query: async () => [] }, action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} } },
    SITE_PATTERNS: [], allowedUrl: () => true, debuggerSession: { maintain: async () => {} },
    createReadScheduler,
    prioritizeHealthJobs: jobs => jobs, post, capture, Date: { now },
  });
  vm.runInContext('let polling = false, rerunRequested = false, keepingAlive = false, keepAliveSupported = false, lastClientContact = 0;\n' + loop + '\nconst readScheduler = createReadScheduler(executeJob, () => void heartbeat());', context);
  return () => vm.runInContext('heartbeat()', context);
}

test('long-running work keeps renewing the lease without claiming or executing concurrent jobs', async () => {
  const entered = deferred(), release = deferred();
  let started = false, busyBeats = 0, captures = 0, elapsed = 0;
  const run = fixture(async (path, body) => {
    if (path !== 'heartbeat') return {};
    if (body.busy) { busyBeats++; return { jobs: [] }; }
    if (started) return { jobs: [] };
    started = true; return { keepAliveSupported: true, jobs: [{ id: 'one', type: 'capture', tabId: 1 }] };
  }, async () => { captures++; entered.resolve(); await release.promise; return {}; }, () => elapsed);
  const pending = run(); await entered.promise;
  for (let i = 0; i < 20; i++) { elapsed += 5000; await run(); }
  assert.equal(elapsed, 100000); assert.equal(busyBeats, 20); assert.equal(captures, 1);
  release.resolve(); await pending;
});

test('a rejected completion does not discard the remaining batch or replay the first task', async () => {
  const executed = [], completed = [];
  const run = fixture(async (path, body) => {
    if (path === 'heartbeat') return { jobs: [1, 2].map(id => ({ id, type: 'capture', tabId: id })) };
    completed.push(body.id);
    if (body.id === 1) throw new Error('404: expired receipt');
    return {};
  }, async id => { executed.push(id); return {}; });
  await run();
  assert.deepEqual(executed, [1, 2]); assert.deepEqual(completed, [1, 2]);
});

test('expired queued work is never executed', async () => {
  let calls = 0;
  const run = fixture(async () => ({ jobs: [{ id: 1, type: 'capture', tabId: 1, expiresAt: 100 }] }), async () => { calls++; }, () => 101);
  await run(); assert.equal(calls, 0);
});

test('an older server cannot accidentally deliver and lose jobs through a keepalive request', async () => {
  const entered = deferred(), release = deferred();
  let posts = 0;
  const run = fixture(async path => {
    if (path !== 'heartbeat') return {};
    posts++;
    return { jobs: posts === 1 ? [{ id: 1, type: 'capture', tabId: 1 }] : [] };
  }, async () => { entered.resolve(); await release.promise; return {}; });
  const pending = run(); await entered.promise;
  await run(); assert.equal(posts, 1);
  release.resolve(); await pending;
});

test('single-job protocol asks native scheduling again immediately after completion', async () => {
  const done = deferred();
  const executed = [], completed = [];
  let claims = 0;
  const run = fixture(async (path, body) => {
    if (path === 'heartbeat') {
      assert.equal(body.singleJob, true);
      claims++;
      if (claims > 2) { done.resolve(); return { singleJobSupported: true, jobs: [] }; }
      assert.equal(completed.length, claims - 1);
      return { singleJobSupported: true, jobs: [{ id: claims, type: 'capture', tabId: claims }] };
    }
    completed.push(body.id); return {};
  }, async id => { executed.push(id); return {}; });
  await run(); await done.promise;
  assert.deepEqual(executed, [1, 2]);
  assert.deepEqual(completed, [1, 2]);
});

test('a frozen background read expires while heartbeats continue, then the next probe can run', async () => {
  const entered = deferred(), drained = deferred();
  const completed = [], evaluated = [];
  let claims = 0, busyBeats = 0;
  const api = { sendCommand: async ({ tabId }, method) => {
    if (method !== 'Runtime.evaluate') return;
    evaluated.push(tabId);
    if (tabId === 1) { entered.resolve(); return new Promise(() => {}); }
    return { result: { value: { state: 'ready' } } };
  } };
  const run = fixture(async (path, body) => {
    if (path === 'complete') { completed.push(body); return {}; }
    if (body.busy) { busyBeats++; return { jobs: [] }; }
    claims++;
    if (claims > 2) { drained.resolve(); return { jobs: [] }; }
    return { keepAliveSupported: true, singleJobSupported: true, jobs: [{ id: claims, type: 'capture', tabId: claims }] };
  }, async tabId => (await evaluateBackgroundRead(api, tabId, { expression: 'probe()' }, 20)).result.value);
  const pending = run();
  await entered.promise;
  await run();
  await pending;
  await drained.promise;
  assert.equal(busyBeats, 1);
  assert.deepEqual(evaluated, [1, 2]);
  assert.match(completed[0].error, /后台页面读取超时/);
  assert.equal(completed[1].data.state, 'ready');
});


test('new protocol polls and completes bounded reads while a serial browser job is still running', async () => {
  const held = deferred(), entered = deferred();
  const completed = [], executed = [];
  let claims = 0;
  const run = fixture(async (path, body) => {
    if (path === 'complete') { completed.push(body.id); return {}; }
    assert.equal(body.parallelReads, true);
    claims++;
    if (claims === 1) return { parallelReadsSupported: true, jobs: [{ id: 'serial', type: 'flight-missions', tabId: 1 }] };
    assert.equal(body.busy, !completed.includes('serial'));
    return { parallelReadsSupported: true, jobs: claims === 2 ? Array.from({ length: 40 }, (_, i) => ({ id: i, tabId: i + 2, type: 'capture' })) : [] };
  }, async id => {
    executed.push(id);
    if (id === 1) { entered.resolve(); await held.promise; }
    return {};
  });
  await run(); await entered.promise;
  await run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executed.length, 4);
  assert.equal(completed.length, 3);
  held.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed.length, 4);
});
