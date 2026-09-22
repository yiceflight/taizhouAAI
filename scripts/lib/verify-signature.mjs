import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
// Tauri's base64-wrapped minisign format. Verify both the prehashed file and trusted comment.
export function verifyDigest(digest, encodedSignature, encodedPublicKey) {
  const keyLines = Buffer.from(encodedPublicKey, 'base64').toString('utf8').trim().split(/\r?\n/);
  const lines = Buffer.from(encodedSignature, 'base64').toString('utf8').trim().split(/\r?\n/);
  if (keyLines.length !== 2 || lines.length !== 4 || !lines[2].startsWith('trusted comment: ')) throw new Error('Invalid updater signature encoding');
  const key = Buffer.from(keyLines[1], 'base64'), packet = Buffer.from(lines[1], 'base64'), global = Buffer.from(lines[3], 'base64');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || packet.length !== 74 || packet.subarray(0, 2).toString() !== 'ED' || global.length !== 64 || !packet.subarray(2, 10).equals(key.subarray(2, 10))) throw new Error('Updater signature key or algorithm mismatch');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const signature = packet.subarray(10);
  if (!verify(null, digest, publicKey, signature) || !verify(null, Buffer.concat([signature, Buffer.from(lines[2].slice(17))]), publicKey, global)) throw new Error('Updater signature verification failed');
}
export async function verifyArtifactSignature(file, signature, publicKey) {
  const hash = createHash('blake2b512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  verifyDigest(hash.digest(), signature, publicKey);
}
