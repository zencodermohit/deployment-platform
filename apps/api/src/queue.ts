/**
 * Handing a deployment to the build queue.
 *
 * The message carries only a deployment id. Everything else is read from
 * DynamoDB by the dispatcher, so the message can never disagree with the
 * record — and a stale or replayed message resolves to whatever the current
 * state is, where the conditional claim decides whether anything happens.
 */

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

let client: SQSClient | undefined;

function sqs(): SQSClient {
  client ??= new SQSClient({});
  return client;
}

export async function enqueueDeployment(deploymentId: string): Promise<void> {
  const queueUrl = process.env['QUEUE_URL'];
  if (!queueUrl) throw new Error('QUEUE_URL is not set');

  await sqs().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ deploymentId }),
    }),
  );
}
