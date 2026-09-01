/**
 * Writing the edge routing table.
 *
 * DynamoDB is the source of truth; the CloudFront KeyValueStore is a
 * materialized read replica the edge function can actually read, since a
 * CloudFront Function cannot make network calls at all.
 *
 * Written by the CONTROL PLANE, never by the build container. The container has
 * no CloudFront permissions — if it could write here it could point any
 * hostname at any prefix, which is the whole tenancy boundary.
 */

import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';

let client: CloudFrontKeyValueStoreClient | undefined;

function kvs(): CloudFrontKeyValueStoreClient {
  // The key-value store API is global and signed against us-east-1.
  client ??= new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });
  return client;
}

export interface EdgeRoute {
  /** Hostname, or a deployment id when using CloudFront path mode. */
  key: string;
  prefix: string;
  spa?: boolean;
}

/**
 * Point a key at an artifact prefix.
 *
 * Every write needs the store's current ETag, which is CloudFront's optimistic
 * concurrency check: if something else wrote in between, this fails rather than
 * silently clobbering. Read-then-write, so a concurrent promote loses instead
 * of interleaving.
 */
export async function putRoute(route: EdgeRoute): Promise<void> {
  const arn = process.env['KVS_ARN'];
  if (!arn) {
    // Not configured — the deployment still succeeds, it is just not routable.
    // Better than failing a finished build over a missing environment variable.
    throw new Error('KVS_ARN is not set');
  }

  const described = await kvs().send(new DescribeKeyValueStoreCommand({ KvsARN: arn }));

  await kvs().send(
    new PutKeyCommand({
      KvsARN: arn,
      Key: route.key,
      Value: JSON.stringify({ p: route.prefix, spa: route.spa === true }),
      IfMatch: described.ETag,
    }),
  );
}
