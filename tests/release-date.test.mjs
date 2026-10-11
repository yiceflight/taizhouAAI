import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseDate, validateReleaseDate } from '../scripts/lib/release-date.mjs';

test('annotated and lightweight tags produce only the commit timestamp', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'taizhou-release-date-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init');
    git('config', 'user.name', 'Release test');
    git('config', 'user.email', 'release@example.invalid');
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'release');
    git('-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.2.3', '-m', 'Release notes\nExtra tag text');
    git('-c', 'tag.gpgsign=false', 'tag', 'v1.2.4');
    const expected = git('log', '-1', '--format=%cI').trim();
    assert.equal(releaseDate('1.2.3', cwd), expected);
    assert.equal(releaseDate('1.2.4', cwd), expected);
    assert.throws(() => validateReleaseDate(git('show', '-s', '--format=%cI', 'v1.2.3').trim()), /RFC 3339/);
    assert.doesNotThrow(() => validateReleaseDate(releaseDate('9.9.9', cwd)));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('reject invalid or multiline release dates before publication', () => {
  for (const value of ['', 'invalid', '2026-13-23T10:56:33+08:00', '2026-09-23', 'tag v0.2.2\n2026-09-23T10:56:33+08:00']) {
    assert.throws(() => validateReleaseDate(value), /RFC 3339/);
  }
  assert.equal(validateReleaseDate('2026-09-23T10:56:33+08:00'), '2026-09-23T10:56:33+08:00');
});
