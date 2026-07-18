import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CORE_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const limitParam = event.queryStringParameters?.limit;
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 200) : 100;

  const cursorParam = event.queryStringParameters?.cursor;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (cursorParam) {
    try {
      exclusiveStartKey = JSON.parse(decodeURIComponent(cursorParam));
    } catch {
      // 不正なカーソルは無視して先頭から取得
    }
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: CORE_TABLE,
      IndexName: 'published-updated_at-index',
      KeyConditionExpression: 'published = :pub',
      ExpressionAttributeValues: { ':pub': 'true' },
      Limit: limit,
      ScanIndexForward: false, // newest first
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }),
  );

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      items: result.Items ?? [],
      count: result.Count ?? 0,
      ...(result.LastEvaluatedKey ? { next_key: result.LastEvaluatedKey } : {}),
    }),
  };
};
