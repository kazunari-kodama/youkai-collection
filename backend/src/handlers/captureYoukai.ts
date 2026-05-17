import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE } from '../lib/dynamodb';
import { distanceMeters } from '../lib/distance';
import type { YokaiDBItem } from '../types/youkai';

const CAPTURE_RADIUS_M = 13;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

interface CaptureRequest {
  deviceId: string;
  youkaiId: string;
  userLat: number;
  userLon: number;
  rallyKey?: string;
  qrCode?: string;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: CaptureRequest;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deviceId, youkaiId, userLat, userLon } = body;
  if (!deviceId || !youkaiId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  const yokaiResult = await ddb.send(
    new GetCommand({
      TableName: YOUKAI_TABLE,
      Key: { yokai_id: youkaiId },
      ProjectionExpression: 'yokai_id, latitude, longitude, #rq',
      ExpressionAttributeNames: { '#rq': 'require_qr' },
    }),
  );

  if (!yokaiResult.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Youkai not found' }) };
  }

  const youkai = yokaiResult.Item as Pick<YokaiDBItem, 'yokai_id' | 'latitude' | 'longitude' | 'require_qr'>;
  const dist = distanceMeters(userLat, userLon, youkai.latitude, youkai.longitude);

  if (dist > CAPTURE_RADIUS_M) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Too far', distance: Math.round(dist) }),
    };
  }

  if (youkai.require_qr && body.qrCode !== youkaiId) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ error: 'QR code required' }),
    };
  }

  const captureItem: Record<string, unknown> = {
    deviceId,
    youkaiId,
    capturedAt: new Date().toISOString(),
    userLat,
    userLon,
  };
  if (body.rallyKey) captureItem.rally_key = body.rallyKey;

  await ddb.send(new PutCommand({ TableName: CAPTURES_TABLE, Item: captureItem }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
};
