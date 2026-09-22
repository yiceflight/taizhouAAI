import test from 'node:test';
import assert from 'node:assert/strict';
import { machArchitectures, compareVersions } from '../scripts/lib/release-assets.mjs';
test('a single ARM binary is never published as Intel', () => {
  const binary = Buffer.alloc(32); binary.writeUInt32BE(0xcffaedfe); binary.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(machArchitectures(binary), ['darwin-aarch64']);
  binary.writeUInt32LE(0x01000007, 4); assert.deepEqual(machArchitectures(binary), ['darwin-x86_64']);
});
test('universal binaries expose their real architectures', () => {
  const binary = Buffer.alloc(48); binary.writeUInt32BE(0xcafebabe); binary.writeUInt32BE(2, 4); binary.writeUInt32BE(0x0100000c, 8); binary.writeUInt32BE(0x01000007, 28);
  assert.deepEqual(machArchitectures(binary), ['darwin-aarch64', 'darwin-x86_64']);
  assert.throws(() => machArchitectures(Buffer.alloc(8)));
});
test('versions compare numerically and reject malformed versions', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.invalid.1', '0.1.0'));
});
