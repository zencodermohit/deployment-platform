/**
 * The one DynamoDB client, shared by every repository.
 *
 * Created lazily at module scope so Lambda reuses it across warm invocations —
 * a new client per request would pay TLS setup every time.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let cached: DynamoDBDocumentClient | undefined;

export function tableName(): string {
  const name = process.env['TABLE_NAME'];
  if (!name) throw new Error('TABLE_NAME is not set');
  return name;
}

export function documentClient(): DynamoDBDocumentClient {
  if (!cached) {
    cached = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        // LocalStack / DynamoDB Local set this; in Lambda it is absent.
        ...(process.env['DYNAMODB_ENDPOINT']
          ? { endpoint: process.env['DYNAMODB_ENDPOINT'] }
          : {}),
      }),
      {
        marshallOptions: {
          // An absent value should mean "no attribute", not an empty string —
          // otherwise sparse-index and attribute_not_exists checks misbehave.
          removeUndefinedValues: true,
          convertClassInstanceToMap: false,
        },
      },
    );
  }
  return cached;
}

/** Tests reset the memoised client between cases. */
export function resetClient(): void {
  cached = undefined;
}

/** DynamoDB signals a failed ConditionExpression with this specific name. */
export function isConditionalCheckFailure(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    (e).name === 'ConditionalCheckFailedException'
  );
}
