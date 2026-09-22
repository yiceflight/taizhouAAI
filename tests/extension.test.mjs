import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedUrl, evaluationValue } from '../extension/src/bridge-core.js';
test('only authorized business origins are capturable', () => {
  for (const url of ['https://fh.dji.com/organization/a', 'https://aai.airins.cn/sniff/HistoryCloud', 'http://61.155.4.60:18080/#/home/map']) assert.equal(allowedUrl(url), true);
  for (const url of ['https://fh.dji.com.evil.test/', 'http://fh.dji.com/', 'https://fh.dji.com:444/', 'https://user@fh.dji.com/', 'file:///tmp/a', 'chrome://settings']) assert.equal(allowedUrl(url), false);
});
test('CDP values use the actual protocol shape and exceptions fail', () => {
  assert.deepEqual(evaluationValue({ result: { type: 'object', value: { text: 'actual page' } } }), { text: 'actual page' });
  assert.equal(evaluationValue({ result: { value: 0 } }), 0);
  assert.throws(() => evaluationValue({ exceptionDetails: { text: 'Execution failed' } }), /Execution failed/);
  assert.throws(() => evaluationValue({ result: { type: 'undefined' } }), /未返回/);
});
test('packaged extension identity matches the server origin allowlist', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map(x => String.fromCharCode(97 + parseInt(x, 16))).join('');
  const server = await readFile(new URL('../src-tauri/src/bridge.rs', import.meta.url), 'utf8');
  assert.ok(server.includes(`chrome-extension://${id}`));
});

test('snapshot stops on unauthorized navigation before touching the DOM', async () => {
  const { runInNewContext } = await import('node:vm');
  const { pageSnapshot } = await import('../extension/src/bridge-core.js');
  assert.throws(() => runInNewContext(`(${pageSnapshot.toString()})()`, { location: new URL('https://evil.test'), get document() { throw new Error('DOM must not be read'); } }), /离开授权网站/);
});
test('large table captures are bounded and explicitly marked truncated', async () => {
  const { runInNewContext } = await import('node:vm');
  const { pageSnapshot } = await import('../extension/src/bridge-core.js');
  const visible = { getClientRects: () => [1] };
  const cell = { innerText: '监'.repeat(2000) };
  const row = { ...visible, cells: Array(31).fill(cell) };
  const table = { ...visible, rows: Array(201).fill(row) };
  const result = runInNewContext(`(${pageSnapshot.toString()})()`, {
    location: new URL('https://fh.dji.com/'), getComputedStyle: () => ({ visibility: 'visible' }),
    document: { title: 'large page', body: { innerText: 'Page' }, querySelectorAll: () => [table] },
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1500000);
  assert.ok(result.tables.flat(2).join('').length <= 200000);
});
