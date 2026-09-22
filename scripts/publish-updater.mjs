#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ossConfig, headOrNull, safeError } from './lib/oss.mjs';
import { compareVersions, inspectMacArchive } from './lib/release-assets.mjs';
import { verifyArtifactSignature } from './lib/verify-signature.mjs';

const stagingDirectory = path.resolve(process.argv[2] ?? 'staging');
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const version = (process.argv[3] ?? packageVersion).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version must use X.Y.Z format');

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
function publicUrl(domain, key) { return `${domain}/${key.split('/').map(encodeURIComponent).join('/')}`; }
function notes() {
  try {
    const tag = `v${version}`;
    const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
    const previous = tags.find(item => item !== tag && compareVersions(item, version) < 0);
    const log = execFileSync('git', ['log', '--format=- %s', previous ? `${previous}..${tag}` : tag], { encoding: 'utf8' }).trim();
    if (log) return log;
  } catch { /* a clean checkout may not have tags */ }
  return `- 泰州市监测中心智能监测系统 ${version} 更新`;
}
function releaseDate() {
  try { return execFileSync('git', ['show', '-s', '--format=%cI', `v${version}`], { encoding: 'utf8' }).trim(); }
  catch { return new Date().toISOString(); }
}

let releaseLock;
try {
  await access(stagingDirectory);
  const entries = await readdir(stagingDirectory);
  const files = [];
  for (const name of entries) {
    if (name.endsWith('.sig') || name === 'latest.json' || name === 'SHA256SUMS.txt') continue;
    const filePath = path.join(stagingDirectory, name);
    const metadata = await stat(filePath);
    if (metadata.isFile() && metadata.size > 0) files.push({ name, filePath, size: metadata.size, sha256: await sha256(filePath) });
  }
  const candidates = files.filter(item => item.name.endsWith('.exe') || item.name.endsWith('.tar.gz'));
  if (candidates.length === 0) throw new Error('Staging must contain a Windows .exe or macOS .tar.gz updater artifact');
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  const claimedPlatforms = new Set();
  for (const asset of candidates) {
    if (asset.name.endsWith('.tar.gz')) asset.platforms = inspectMacArchive(asset.filePath, version);
    else {
      // The NSIS stub architecture is not the installed app architecture. Require an explicit target in its build filename.
      const match = asset.name.match(/_(x64|arm64|x86)-setup\.exe$/);
      if (!match || !asset.name.includes(`_${version}_`)) throw new Error('Windows installer needs a versioned Tauri filename with an explicit target architecture');
      asset.platforms = [`windows-${{ x64: 'x86_64', arm64: 'aarch64', x86: 'i686' }[match[1]]}`];
    }
    for (const platform of asset.platforms) {
      if (claimedPlatforms.has(platform)) throw new Error(`Duplicate artifact for ${platform}`);
      claimedPlatforms.add(platform);
    }
    const signaturePath = `${asset.filePath}.sig`;
    await access(signaturePath);
    asset.signature = (await readFile(signaturePath, 'utf8')).trim();
    if (!asset.signature) throw new Error(`${asset.name}.sig is empty`);
    await verifyArtifactSignature(asset.filePath, asset.signature, config.plugins.updater.pubkey);
  }
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ version, assets: candidates.map(({ name, platforms, sha256 }) => ({ name, platforms, sha256 })) }));
    process.exit(0);
  }

  const { client, bucket, domain } = await ossConfig();
  const versioning = await client.getBucketVersioning(bucket);
  if (versioning.versionStatus) throw new Error('Publishing lock requires an unversioned bucket; refusing unsafe concurrent publication');
  const lockKey = 'client/publish.lock';
  await client.put(lockKey, Buffer.from(JSON.stringify({ version, owner: randomUUID(), startedAt: new Date().toISOString() })), { headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private' } });
  releaseLock = { client, key: lockKey };
  const prefix = `client/v${version}`;
  const urls = {};
  const current = await headOrNull(client, 'client/latest.json');
  if (current) {
    const response = await fetch(publicUrl(domain, 'client/latest.json'), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Existing latest.json is not publicly readable');
    const currentManifest = await response.json();
    if (typeof currentManifest.version !== 'string' || compareVersions(currentManifest.version, version) >= 0) throw new Error(`Refusing to replace same or newer release ${currentManifest.version}`);
  }
  for (const asset of candidates) {
    const key = `${prefix}/${asset.name}`;
    const existing = await headOrNull(client, key);
    if (existing) {
      const remoteSize = Number(existing.res.headers['content-length'] ?? 0);
      const remoteSha256 = existing.res.headers['x-oss-meta-sha256'];
      if (remoteSize !== asset.size || remoteSha256 !== asset.sha256) throw new Error(`Refusing to overwrite immutable object ${key}`);
    } else {
      await client.put(key, asset.filePath, { timeout: 120000, headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': `attachment; filename="${asset.name.replace(/[^a-zA-Z0-9._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
        'Content-Type': asset.name.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable' : 'application/gzip',
        'x-oss-meta-sha256': asset.sha256,
        'x-oss-object-acl': 'public-read',
        'x-oss-forbid-overwrite': 'true',
      }});
    }
    await client.putACL(key, 'public-read');
    const url = publicUrl(domain, key);
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
    if (!head.ok || Number(head.headers.get('content-length')) !== asset.size) throw new Error(`Anonymous HEAD verification failed for ${asset.name}`);
    urls[asset.name] = url;
  }

  const platforms = {};
  for (const asset of candidates) for (const platform of asset.platforms) platforms[platform] = { url: urls[asset.name], signature: asset.signature };
  const manifest = { version, notes: notes(), pub_date: releaseDate(), platforms };
  const contents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const latestKey = 'client/latest.json';
  await client.put(latestKey, contents, { timeout: 30000, headers: {
    'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    'Content-Type': 'application/json; charset=utf-8',
    'x-oss-meta-sha256': createHash('sha256').update(contents).digest('hex'),
    'x-oss-object-acl': 'public-read',
  }});
  await client.putACL(latestKey, 'public-read');
  const check = await fetch(`${publicUrl(domain, latestKey)}?verify=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
  if (!check.ok || JSON.stringify(await check.json()) !== JSON.stringify(manifest)) throw new Error('Published manifest verification failed');
  console.log(JSON.stringify({ bucket, version, manifest: publicUrl(domain, latestKey), platforms: Object.keys(platforms) }));
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  if (releaseLock) {
    try { await releaseLock.client.delete(releaseLock.key); }
    catch (error) { console.error('Release lock cleanup failed: ' + safeError(error)); process.exitCode = 1; }
  }
}
