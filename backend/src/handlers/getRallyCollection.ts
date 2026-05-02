import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const { deviceId, key } = event.queryStringParameters ?? {};
  if (!deviceId || !key) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'deviceId and key required' }) };
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: CAPTURES_TABLE,
      KeyConditionExpression: 'deviceId = :d',
      FilterExpression: 'rally_key = :k',
      ExpressionAttributeValues: { ':d': deviceId, ':k': key },
    }),
  );

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result.Items ?? []) };
};
