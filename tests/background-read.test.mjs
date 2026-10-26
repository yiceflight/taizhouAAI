import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBackgroundRead } from '../extension/src/background-read.js';

test('hidden-page reads run with emulated visibility and always restore it', async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const api = { sendCommand: async (target, method, parameters) => {
      calls.push({ target, method, parameters });
      if (method === 'Runtime.evaluate') {
        assert.equal(calls[0].parameters.enabled, true);
        if (fail) throw new Error('page navigated');
        return { result: { value: 'authenticated result' } };
      }
    } };
    const read = evaluateBackgroundRead(api, 9, { expression: 'read()', awaitPromise: true });
    if (fail) await assert.rejects(read, /page navigated/);
    else assert.equal((await read).result.value, 'authenticated result');
    assert.deepEqual(calls.map(c => c.method), ['Emulation.setFocusEmulationEnabled', 'Runtime.evaluate', 'Emulation.setFocusEmulationEnabled']);
    assert.equal(calls.at(-1).parameters.enabled, false);
    assert.ok(calls.every(c => c.target.tabId === 9));
  }
});

test('a frozen page cannot hold the worker queue and its late receipt is ignored', async () => {
  let late;
  let reads = 0;
  const focus = [];
  const api = { sendCommand: async (_target, method, parameters) => {
    if (method === 'Emulation.setFocusEmulationEnabled') { focus.push(parameters.enabled); return; }
    reads++;
    if (reads === 1) return new Promise(resolve => { late = resolve; });
    return { result: { value: 'next health check' } };
  } };
  await assert.rejects(evaluateBackgroundRead(api, 1, { expression: 'frozen()' }, 10), /后台页面读取超时/);
  const next = await evaluateBackgroundRead(api, 2, { expression: 'health()' });
  late({ result: { value: 'expired' } });
  assert.equal(next.result.value, 'next health check');
  assert.equal(reads, 2, 'never replay the expired read');
  assert.deepEqual(focus, [true, false, true, false]);
});

test('focus setup failure does not execute the read and still restores visibility', async () => {
  const calls = [];
  const api = { sendCommand: async (_target, method, parameters) => {
    calls.push([method, parameters.enabled]);
    if (parameters.enabled) throw new Error('debugger detached');
  } };
  await assert.rejects(evaluateBackgroundRead(api, 1, {}), /debugger detached/);
  assert.deepEqual(calls, [['Emulation.setFocusEmulationEnabled', true], ['Emulation.setFocusEmulationEnabled', false]]);
});
