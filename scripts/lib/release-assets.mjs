import { execFileSync } from 'node:child_process';
export function machArchitectures(bytes) {
  if (bytes.length < 8) throw new Error('Invalid Mach-O binary');
  const magic = bytes.readUInt32BE(0);
  let types;
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = bytes.readUInt32BE(4), width = magic === 0xcafebabf ? 32 : 20;
    if (count < 1 || count > 8 || bytes.length < 8 + count * width) throw new Error('Invalid universal Mach-O header');
    types = Array.from({ length: count }, (_, i) => bytes.readUInt32BE(8 + i * width));
  } else if (magic === 0xcffaedfe) types = [bytes.readUInt32LE(4)];
  else if (magic === 0xfeedfacf) types = [bytes.readUInt32BE(4)];
  else throw new Error('Unsupported Mac executable format');
  return [...new Set(types.map(type => {
    if (type === 0x0100000c) return 'darwin-aarch64';
    if (type === 0x01000007) return 'darwin-x86_64';
    throw new Error('Unsupported Mac architecture');
  }))];
}
export function inspectMacArchive(file, version) {
  const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
  if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('Unsafe archive path');
  const infos = entries.filter(entry => /^[^/]+\.app\/Contents\/Info\.plist$/.test(entry.replace(/^\.\//, '')));
  if (infos.length !== 1) throw new Error('Mac archive must contain exactly one app');
  const plist = execFileSync('tar', ['-xOzf', file, infos[0]], { maxBuffer: 1024 * 1024 });
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: plist, encoding: 'utf8' }));
  if (info.CFBundleShortVersionString !== version || info.CFBundleIdentifier !== 'com.taizhou.aai') throw new Error('Mac bundle version or app identity does not match this release');
  if (!/^[^/\\]+$/.test(info.CFBundleExecutable)) throw new Error('Invalid executable name');
  const executable = infos[0].replace(/Info\.plist$/, `MacOS/${info.CFBundleExecutable}`);
  const bytes = execFileSync('tar', ['-xOzf', file, executable], { maxBuffer: 512 * 1024 * 1024 });
  return machArchitectures(bytes);
}
export function compareVersions(a, b) {
  if (![a, b].every(value => /^\d+\.\d+\.\d+$/.test(value.replace(/^v/, '')))) throw new Error('Invalid release version');
  const left = a.replace(/^v/, '').split('.').map(Number), right = b.replace(/^v/, '').split('.').map(Number);
  return left.reduce((result, value, index) => result || value - right[index], 0);
}
