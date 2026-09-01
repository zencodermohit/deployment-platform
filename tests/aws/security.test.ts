/**
 * M5 — the security claims, made executable.
 *
 * docs/05-threat-model.md asserts that a fully compromised build container gets
 * "a shell in a throwaway sandbox with write access to one S3 prefix". This file
 * proves that against the DEPLOYED policies rather than the intended ones.
 *
 * It uses the IAM policy simulator, which evaluates real policies without
 * needing a hostile repository or an actual breach. That is a more direct proof
 * than routing an attack through a fixture: it asks IAM the exact question the
 * threat model claims an answer to.
 *
 * NOTE ON SESSION POLICIES: the simulator models them via
 * `PermissionsBoundaryPolicyInputList`, because both have INTERSECTION
 * semantics. `PolicyInputList` would be wrong — it ADDS policies, and an early
 * version of this file used it and reported a cross-tenant write as allowed
 * when it was not.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  IAMClient,
  SimulatePrincipalPolicyCommand,
  type EvaluationResult,
} from '@aws-sdk/client-iam';
import { DescribeTaskDefinitionCommand, ECSClient } from '@aws-sdk/client-ecs';
import { CloudFrontClient, ListKeyValueStoresCommand } from '@aws-sdk/client-cloudfront';

const ACCOUNT = '220438080921';
const REGION = 'ap-south-1';
const PROJECT = 'deployment-platform';

const ARTIFACTS = `arn:aws:s3:::${PROJECT}-artifacts-${ACCOUNT}`;
const SOURCES = `arn:aws:s3:::${PROJECT}-sources-${ACCOUNT}`;
const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${PROJECT}`;
const QUEUE = `arn:aws:sqs:${REGION}:${ACCOUNT}:${PROJECT}-builds`;

const role = (name: string): string => `arn:aws:iam::${ACCOUNT}:role/${PROJECT}-${name}`;

const BUILD_WRITER = role('build-artifacts');
const DISPATCHER = role('dispatcher');
const API = role('api');
const SWEEPER = role('sweeper');

/** The session policy the dispatcher attaches when minting build credentials. */
const MINE = 'projects/prj_MINE/deployments/dep_MINE';
const SESSION_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: 's3:PutObject',
      Resource: [`${ARTIFACTS}/${MINE}/*`, `${ARTIFACTS}/${MINE}.manifest.json`],
    },
  ],
});

const iam = new IAMClient({ region: REGION });
const ecs = new ECSClient({ region: REGION });

type Decision = 'allowed' | 'denied';

interface Context {
  key: string;
  value: string;
}

async function decide(
  principal: string,
  action: string,
  resource: string,
  sessionPolicy?: string,
  context: Context[] = [],
): Promise<Decision> {
  const result = await iam.send(
    new SimulatePrincipalPolicyCommand({
      PolicySourceArn: principal,
      ActionNames: [action],
      ResourceArns: [resource],
      ...(sessionPolicy ? { PermissionsBoundaryPolicyInputList: [sessionPolicy] } : {}),
      ...(context.length > 0
        ? {
            ContextEntries: context.map((entry) => ({
              ContextKeyName: entry.key,
              ContextKeyType: 'string' as const,
              ContextKeyValues: [entry.value],
            })),
          }
        : {}),
    }),
  );
  const evaluation = result.EvaluationResults?.[0] as EvaluationResult | undefined;
  return evaluation?.EvalDecision === 'allowed' ? 'allowed' : 'denied';
}

/**
 * Resolved from live infrastructure rather than hardcoded.
 *
 * Both are needed because the policies are scoped to exact ARNs — simulating
 * against `*` reports "denied" for an action that is in fact allowed on its
 * real resource, which is how the first version of this file produced two
 * false failures.
 */
let TASK_DEF_ARN = '';
let CLUSTER_ARN = '';
let KVS_ARN = '';

beforeAll(async () => {
  expect(ACCOUNT).toMatch(/^\d{12}$/);

  const taskDef = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: `${PROJECT}-builder` }),
  );
  TASK_DEF_ARN = taskDef.taskDefinition?.taskDefinitionArn ?? '';
  CLUSTER_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${PROJECT}`;

  const stores = await new CloudFrontClient({ region: 'us-east-1' }).send(
    new ListKeyValueStoresCommand({}),
  );
  KVS_ARN =
    stores.KeyValueStoreList?.Items?.find((item) => item.Name === `${PROJECT}-routes`)?.ARN ?? '';

  expect(TASK_DEF_ARN).toMatch(/^arn:aws:ecs:/);
  expect(KVS_ARN).toMatch(/^arn:aws:cloudfront:/);
});

describe('T3/T4 — what a compromised build container can actually do', () => {
  it('has no AWS identity of its own: the task definition sets no task role', async () => {
    const result = await ecs.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: `${PROJECT}-builder` }),
    );
    // With no task role there is nothing to steal from the ECS credential
    // metadata endpoint. The container's only credentials are the scoped,
    // one-hour ones the dispatcher hands it.
    expect(result.taskDefinition?.taskRoleArn).toBeUndefined();
  });

  it('can write its own prefix', async () => {
    expect(await decide(BUILD_WRITER, 's3:PutObject', `${ARTIFACTS}/${MINE}/index.html`, SESSION_POLICY)).toBe('allowed');
    expect(await decide(BUILD_WRITER, 's3:PutObject', `${ARTIFACTS}/${MINE}/assets/app.js`, SESSION_POLICY)).toBe('allowed');
    expect(await decide(BUILD_WRITER, 's3:PutObject', `${ARTIFACTS}/${MINE}.manifest.json`, SESSION_POLICY)).toBe('allowed');
  });

  it('CANNOT write into another project', async () => {
    // The finding that prompted vended credentials: with a shared task role
    // this was allowed, which made the prefix-scoping claim in T4 untrue.
    expect(
      await decide(BUILD_WRITER, 's3:PutObject', `${ARTIFACTS}/projects/prj_OTHER/deployments/dep_X/evil.html`, SESSION_POLICY),
    ).toBe('denied');
  });

  it('CANNOT write into a sibling deployment of the same project', async () => {
    expect(
      await decide(BUILD_WRITER, 's3:PutObject', `${ARTIFACTS}/projects/prj_MINE/deployments/dep_SIBLING/evil.html`, SESSION_POLICY),
    ).toBe('denied');
  });

  it('CANNOT overwrite the shared 404 page at the bucket root', async () => {
    expect(await decide(BUILD_WRITER, 's3:PutObject', `${ARTIFACTS}/404.html`, SESSION_POLICY)).toBe('denied');
  });

  it('CANNOT read any artifact, including its own', async () => {
    // Write-only. Reading would let one tenant exfiltrate another's site.
    expect(await decide(BUILD_WRITER, 's3:GetObject', `${ARTIFACTS}/${MINE}/index.html`, SESSION_POLICY)).toBe('denied');
    expect(await decide(BUILD_WRITER, 's3:GetObject', `${ARTIFACTS}/projects/prj_OTHER/deployments/dep_X/index.html`, SESSION_POLICY)).toBe('denied');
  });

  it('CANNOT delete anything', async () => {
    expect(await decide(BUILD_WRITER, 's3:DeleteObject', `${ARTIFACTS}/${MINE}/index.html`, SESSION_POLICY)).toBe('denied');
  });

  it('CANNOT touch source archives', async () => {
    expect(await decide(BUILD_WRITER, 's3:GetObject', `${SOURCES}/sources/dep_MINE.tar.gz`, SESSION_POLICY)).toBe('denied');
    expect(await decide(BUILD_WRITER, 's3:PutObject', `${SOURCES}/sources/evil.tar.gz`, SESSION_POLICY)).toBe('denied');
  });

  it('CANNOT reach deployment state', async () => {
    for (const action of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan']) {
      expect(await decide(BUILD_WRITER, action, TABLE, SESSION_POLICY), action).toBe('denied');
    }
  });

  it('CANNOT reach the queue, secrets, or the edge routing table', async () => {
    expect(await decide(BUILD_WRITER, 'sqs:SendMessage', QUEUE, SESSION_POLICY)).toBe('denied');
    expect(await decide(BUILD_WRITER, 'secretsmanager:GetSecretValue', '*', SESSION_POLICY)).toBe('denied');
    expect(await decide(BUILD_WRITER, 'ssm:GetParameter', '*', SESSION_POLICY)).toBe('denied');
    // Writing here would let a build point any hostname at any prefix.
    expect(await decide(BUILD_WRITER, 'cloudfront-keyvaluestore:PutKey', '*', SESSION_POLICY)).toBe('denied');
  });

  it('CANNOT start more builds or escalate privileges', async () => {
    for (const action of ['ecs:RunTask', 'iam:PassRole', 'iam:CreateRole', 'iam:AttachRolePolicy', 'sts:AssumeRole']) {
      expect(await decide(BUILD_WRITER, action, '*', SESSION_POLICY), action).toBe('denied');
    }
  });

  it('even WITHOUT the session policy, the role ceiling stays narrow', async () => {
    // Defence in depth: if the dispatcher ever forgot the session policy, the
    // blast radius would widen to the projects namespace — but no further.
    expect(await decide(BUILD_WRITER, 's3:GetObject', `${ARTIFACTS}/${MINE}/index.html`)).toBe('denied');
    expect(await decide(BUILD_WRITER, 'dynamodb:GetItem', TABLE)).toBe('denied');
    expect(await decide(BUILD_WRITER, 'ecs:RunTask', '*')).toBe('denied');
  });
});

describe('worker roles are scoped to their own job', () => {
  it('only the dispatcher may start builds', async () => {
    // RunTask is scoped to this task definition AND conditioned on the cluster,
    // so the simulation has to supply both or it reports a false denial.
    const inCluster = [{ key: 'ecs:cluster', value: CLUSTER_ARN }];

    expect(await decide(DISPATCHER, 'ecs:RunTask', TASK_DEF_ARN, undefined, inCluster)).toBe('allowed');
    expect(await decide(SWEEPER, 'ecs:RunTask', TASK_DEF_ARN, undefined, inCluster)).toBe('denied');
    expect(await decide(API, 'ecs:RunTask', TASK_DEF_ARN, undefined, inCluster)).toBe('denied');
  });

  it('the dispatcher cannot run a task in some other cluster', async () => {
    const elsewhere = [{ key: 'ecs:cluster', value: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/other` }];
    expect(await decide(DISPATCHER, 'ecs:RunTask', TASK_DEF_ARN, undefined, elsewhere)).toBe('denied');
  });

  it('the dispatcher can mint build credentials; nothing else can', async () => {
    expect(await decide(DISPATCHER, 'sts:AssumeRole', BUILD_WRITER)).toBe('allowed');
    expect(await decide(SWEEPER, 'sts:AssumeRole', BUILD_WRITER)).toBe('denied');
    expect(await decide(API, 'sts:AssumeRole', BUILD_WRITER)).toBe('denied');
  });

  it('no role can delete deployment records or the table', async () => {
    for (const principal of [DISPATCHER, API, SWEEPER]) {
      expect(await decide(principal, 'dynamodb:DeleteItem', TABLE), principal).toBe('denied');
      expect(await decide(principal, 'dynamodb:DeleteTable', TABLE), principal).toBe('denied');
    }
  });

  it('no role may Scan the table — every access pattern is a Query (ADR-0008)', async () => {
    for (const principal of [DISPATCHER, API, SWEEPER]) {
      expect(await decide(principal, 'dynamodb:Scan', TABLE), principal).toBe('denied');
    }
  });

  it('only the API writes the edge routing table', async () => {
    expect(await decide(API, 'cloudfront-keyvaluestore:PutKey', KVS_ARN)).toBe('allowed');
    expect(await decide(DISPATCHER, 'cloudfront-keyvaluestore:PutKey', KVS_ARN)).toBe('denied');
    expect(await decide(SWEEPER, 'cloudfront-keyvaluestore:PutKey', KVS_ARN)).toBe('denied');
  });

  it('the API cannot read or write artifacts directly', async () => {
    expect(await decide(API, 's3:PutObject', `${ARTIFACTS}/${MINE}/index.html`)).toBe('denied');
    expect(await decide(API, 's3:GetObject', `${ARTIFACTS}/${MINE}/index.html`)).toBe('denied');
  });

  it('no role can tamper with its own permissions', async () => {
    for (const principal of [DISPATCHER, API, SWEEPER, BUILD_WRITER]) {
      for (const action of ['iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:CreateRole']) {
        expect(await decide(principal, action, '*'), `${principal} ${action}`).toBe('denied');
      }
    }
  });
});

describe('the artifact bucket is reachable only through CloudFront', () => {
  it('refuses a direct request', async () => {
    const response = await fetch(
      `https://${PROJECT}-artifacts-${ACCOUNT}.s3.${REGION}.amazonaws.com/projects/prj_local/deployments/dep_m2demo/index.html`,
    );
    // The same object is served happily through the distribution.
    expect(response.status).toBe(403);
  });

  it('refuses to list the bucket', async () => {
    const response = await fetch(`https://${PROJECT}-artifacts-${ACCOUNT}.s3.${REGION}.amazonaws.com/`);
    expect(response.status).toBe(403);
  });
});
