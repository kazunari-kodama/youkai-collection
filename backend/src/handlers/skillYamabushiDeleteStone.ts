import type { APIGatewayProxyHandler } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, YAMABUSHI_STONES_TABLE } from '../lib/dynamodb';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

interface DeleteStoneRequest {
  deviceId: string;
  stone_id: string;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: DeleteStoneRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, stone_id } = body;
  if (!deviceId || !stone_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  try {
    await ddb.send(new DeleteCommand({
      TableName: YAMABUSHI_STONES_TABLE,
      Key: { deviceId, stone_id },
      ConditionExpression: 'attribute_exists(stone_id)',
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Stone not found' }) };
    }
    throw err;
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) };
};
