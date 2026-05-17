import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!deviceId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'deviceId required' }) };
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: CAPTURES_TABLE,
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
      ProjectionExpression: 'deviceId, youkaiId',
    }),
  );

  const items = result.Items ?? [];
  if (!items.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ deleted: 0 }) };
  }

  // BatchWrite supports max 25 items per request
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [CAPTURES_TABLE]: chunk.map((item) => ({
            DeleteRequest: { Key: { deviceId: item.deviceId, youkaiId: item.youkaiId } },
          })),
        },
      }),
    );
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ deleted: items.length }) };
};
