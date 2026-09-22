import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyDigest } from '../scripts/lib/verify-signature.mjs';
// Public test vector from minisign-verify (the verifier used by Tauri).
const publicKey = Buffer.from('untrusted comment: test key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3').toString('base64');
const signature = Buffer.from('untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==').toString('base64');
test('valid minisign prehash verifies and modified artifacts fail', () => {
  verifyDigest(createHash('blake2b512').update('test').digest(), signature, publicKey);
  assert.throws(() => verifyDigest(createHash('blake2b512').update('Test').digest(), signature, publicKey), /verification failed/);
  const altered = Buffer.from(Buffer.from(signature, 'base64').toString().replace('file:test', 'file:other')).toString('base64');
  assert.throws(() => verifyDigest(createHash('blake2b512').update('test').digest(), altered, publicKey), /verification failed/);
});
