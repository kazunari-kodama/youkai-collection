import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!deviceId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: 'deviceId required' }),
    };
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: CAPTURES_TABLE,
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
      ProjectionExpression: 'youkaiId, actionType, capturedAt, faction, seal_progress, seal_required',
    }),
  );

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result.Items ?? []) };
};
