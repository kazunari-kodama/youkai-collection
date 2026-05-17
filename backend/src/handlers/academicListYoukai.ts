import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CORE_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function isPremium(event: Parameters<APIGatewayProxyHandler>[0]): boolean {
  const claim = event.requestContext.authorizer?.claims?.['cognito:groups'] ?? '';
  return String(claim).includes('premium');
}

export const handler: APIGatewayProxyHandler = async (event) => {
  if (!isPremium(event)) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Premium subscription required' }) };
  }

  const limitParam = event.queryStringParameters?.limit;
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 500) : 200;

  const result = await ddb.send(
    new QueryCommand({
      TableName: CORE_TABLE,
      IndexName: 'published-updated_at-index',
      KeyConditionExpression: 'published = :pub',
      ExpressionAttributeValues: { ':pub': 'true' },
      Limit: limit,
      ScanIndexForward: false,
    }),
  );

  // 創作妖怪（is_original: true）は学術モードから除外
  const items = (result.Items ?? []).filter((i) => i.is_original !== true);

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      items,
      count: items.length,
      ...(result.LastEvaluatedKey ? { next_key: result.LastEvaluatedKey } : {}),
    }),
  };
};
