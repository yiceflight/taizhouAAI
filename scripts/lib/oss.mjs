import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import OSS from 'ali-oss';

export async function readLocalEnv(file) {
  try { return parseEnv(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export async function ossConfig() {
  const env = { ...await readLocalEnv(process.env.OSS_ENV_FILE ?? '.env.oss.local'), ...process.env };
  for (const key of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_ENDPOINT', 'OSS_BUCKET', 'OSS_DOMAIN']) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  if (env.OSS_BUCKET !== 'taizhou-aai-updates') throw new Error('Refusing to write to another project bucket');
  const domain = env.OSS_DOMAIN.replace(/\/$/, '');
  if (domain !== 'https://taizhou-aai-updates.oss-cn-hangzhou.aliyuncs.com') throw new Error('Unexpected public OSS domain');
  return {
    bucket: env.OSS_BUCKET, domain,
    client: new OSS({ accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
      endpoint: env.OSS_ENDPOINT, bucket: env.OSS_BUCKET, secure: true, timeout: 120000 }),
  };
}

// SDK error objects may contain signed requests and credentials. Never print them.
export function safeError(error) {
  if (error?.res || error?.requestId || error?.status) {
    return `OSS request failed: ${String(error.code ?? 'unknown')} (HTTP ${error.status ?? 'unknown'})`;
  }
  return error instanceof Error ? error.message : 'Operation failed';
}

export async function headOrNull(client, key) {
  try { return await client.head(key); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

export async function publicAccessBlock(client, bucket, enabled) {
  const params = client._bucketRequestParams(enabled === undefined ? 'GET' : 'PUT', bucket, 'publicAccessBlock', { timeout: 30000 });
  params.successStatuses = [200];
  if (enabled === undefined) params.xmlResponse = true;
  else {
    params.mime = 'xml';
    params.content = `<?xml version="1.0" encoding="UTF-8"?><PublicAccessBlockConfiguration><BlockPublicAccess>${enabled}</BlockPublicAccess></PublicAccessBlockConfiguration>`;
  }
  const result = await client.request(params);
  return String(result.data?.BlockPublicAccess) === 'true';
}
