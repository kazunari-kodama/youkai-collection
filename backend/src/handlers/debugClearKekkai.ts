import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, KEKKAI_STONES_TABLE, KEKKAI_BARRIERS_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

async function deleteAll(table: string, deviceId: string, skAttr: string): Promise<number> {
  const result = await ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'deviceId = :d',
    ExpressionAttributeValues: { ':d': deviceId },
    ProjectionExpression: `deviceId, ${skAttr}`,
  }));
  const items = result.Items ?? [];
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [table]: chunk.map((item) => ({
          DeleteRequest: { Key: { deviceId: item.deviceId, [skAttr]: item[skAttr] } },
        })),
      },
    }));
  }
  return items.length;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!deviceId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'deviceId required' }) };
  }

  const [stonesDeleted, barriersDeleted] = await Promise.all([
    deleteAll(KEKKAI_STONES_TABLE,   deviceId, 'stone_id'),
    deleteAll(KEKKAI_BARRIERS_TABLE, deviceId, 'barrier_id'),
  ]);

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ stones_deleted: stonesDeleted, barriers_deleted: barriersDeleted }),
  };
};
