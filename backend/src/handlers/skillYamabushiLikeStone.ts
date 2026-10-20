import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YAMABUSHI_STONES_TABLE } from '../lib/dynamodb';
import { isValidDeviceId } from '../lib/deviceId';
import { decodeOwnerRef } from '../lib/ownerRef';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

interface LikeRequest {
  deviceId:        string;
  /** 石の持ち主の不透明な参照（GET /skill/yamabushi/stones の owner_ref） */
  owner_ref:       string;
  stone_id:        string;
  action:          'like' | 'unlike';
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: LikeRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, stone_id, action } = body;
  if (!isValidDeviceId(deviceId) || !body.owner_ref || !stone_id || !action) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }
  const owner_device_id = await decodeOwnerRef(body.owner_ref);
  if (!owner_device_id) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Stone not found' }) };
  }
  if (action !== 'like' && action !== 'unlike') {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid action' }) };
  }

  const stoneRes = await ddb.send(new GetCommand({
    TableName: YAMABUSHI_STONES_TABLE,
    Key: { deviceId: owner_device_id, stone_id },
    ProjectionExpression: 'stone_id',
  }));
  if (!stoneRes.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Stone not found' }) };
  }

  const updateExpr = action === 'like'
    ? 'ADD liked_by :ids'
    : 'DELETE liked_by :ids';

  await ddb.send(new UpdateCommand({
    TableName: YAMABUSHI_STONES_TABLE,
    Key: { deviceId: owner_device_id, stone_id },
    UpdateExpression: updateExpr,
    ExpressionAttributeValues: { ':ids': new Set([deviceId]) },
  }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) };
};
