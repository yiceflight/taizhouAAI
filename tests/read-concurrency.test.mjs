import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadScheduler, readOnlyJob } from '../extension/src/read-scheduler.js';
import { createDebuggerSession } from '../extension/src/debugger-session.js';
import { evaluateBackgroundRead } from '../extension/src/background-read.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('background reads stay bounded while serial work is blocked', async () => {
  const gate = deferred(), started = [], done = [];
  const scheduler = createReadScheduler(async job => {
    started.push(job.id);
    if (job.type === 'dji-status' || job.id === 'slow') await gate.promise;
    done.push(job.id);
  }, () => {});
  scheduler.dispatch([{ id: 'serial', type: 'dji-status' }, { id: 'slow', type: 'site-health' }]);
  await tick();
  const jobs = Array.from({ length: 40 }, (_, id) => ({ id, type: 'site-health' }));
  scheduler.dispatch(jobs); scheduler.dispatch(jobs);
  await tick();
  assert.equal(started.length, 4);
  assert.equal(done.length, 2);
  assert.equal(scheduler.busy(), true);
  gate.resolve(); await tick();
  assert.equal(scheduler.active(), false);
  for (const type of ['dji-prepare', 'dji-submit', 'dji-status', 'dji-weather', 'dji-tasks']) assert.equal(readOnlyJob({ type }), false);
});
test('concurrent readers attach once and the last reader owns detach, including stale leases', async () => {
  const calls = [];
  const session = createDebuggerSession({ attach: async () => calls.push('attach'), detach: async () => calls.push('detach') }, () => true);
  const leases = await Promise.all(Array.from({ length: 40 }, () => session.acquire(7)));
  assert.deepEqual(calls, ['attach']);
  await Promise.all(leases.slice(1).map(lease => session.release(7, lease)));
  assert.deepEqual(calls, ['attach']);
  session.detached(7, 'target_closed');
  const fresh = await session.acquire(7);
  await session.release(7, leases[0]);
  assert.deepEqual(calls, ['attach', 'attach']);
  await session.release(7, fresh);
  assert.deepEqual(calls, ['attach', 'attach', 'detach']);
});
test('one read finishing cannot restore background throttling while another read uses the same page', async () => {
  const gates = [deferred(), deferred()], focus = [];
  const api = { sendCommand: async (_, method, args) => {
    if (method !== 'Runtime.evaluate') { focus.push(args.enabled); return; }
    return gates[Number(args.expression)].promise;
  } };
  const one = evaluateBackgroundRead(api, 7, { expression: '0' });
  const two = evaluateBackgroundRead(api, 7, { expression: '1' });
  await tick(); assert.deepEqual(focus, [true]);
  gates[0].resolve('first'); await one; assert.deepEqual(focus, [true]);
  gates[1].resolve('second'); await two; assert.deepEqual(focus, [true, false]);
});
