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

  const result = await ddb.send(
    new QueryCommand({
      TableName: CORE_TABLE,
      IndexName: 'published-updated_at-index',
      KeyConditionExpression: 'published = :pub',
      ExpressionAttributeValues: { ':pub': 'true' },
      Limit: limit,
      ScanIndexForward: false, // newest first
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
