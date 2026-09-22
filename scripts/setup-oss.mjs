import { ossConfig, publicAccessBlock, safeError } from './lib/oss.mjs';

try {
  const { client, bucket } = await ossConfig();
  const listed = await client.listBuckets({ prefix: bucket });
  const exists = (listed.buckets ?? []).some(item => item.name === bucket);
  if (!exists) await client.putBucket(bucket, { acl: 'private', StorageClass: 'Standard' });
  await client.putBucketACL(bucket, 'private');
  // Only individual, explicitly published release objects are public-readable.
  if (await publicAccessBlock(client, bucket)) await publicAccessBlock(client, bucket, false);
  if (await publicAccessBlock(client, bucket)) throw new Error('Bucket still blocks public release objects');
  const acl = await client.getBucketACL(bucket);
  const info = await client.getBucketInfo(bucket);
  if (acl.acl !== 'private') throw new Error('Bucket ACL verification failed');
  console.log(JSON.stringify({ bucket, created: !exists, acl: acl.acl, region: info.bucket?.Location ?? 'oss-cn-hangzhou', storage: info.bucket?.StorageClass ?? 'Standard' }));
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
