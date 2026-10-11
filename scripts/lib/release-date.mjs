import { execFileSync } from 'node:child_process';

export function validateReleaseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Release pub_date must be a single RFC 3339 timestamp');
  }
  return value;
}

export function releaseDate(version, cwd = process.cwd()) {
  let value;
  try {
    // Dereference annotated tags: git show on the tag also prints its message.
    value = execFileSync('git', ['log', '-1', '--format=%cI', `v${version}^{commit}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    value = new Date().toISOString();
  }
  return validateReleaseDate(value);
}
