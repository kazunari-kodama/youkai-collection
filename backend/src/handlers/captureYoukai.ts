import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { distanceMeters } from '../lib/distance';
import type { YokaiDBItem } from '../types/youkai';

const CAPTURE_RADIUS_M = 13;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

type ActionType = 'seal' | 'release' | 'bond';
type Faction    = 'exorcist' | 'supernatural';

interface CaptureRequest {
  deviceId: string;
  youkaiId: string;
  userLat: number;
  userLon: number;
  rallyKey?: string;
  qrCode?: string;
  actionType?: ActionType;
  faction?: Faction;
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
    actionType: body.actionType ?? 'seal',
    faction:    body.faction    ?? 'exorcist',
  };
  if (body.rallyKey) captureItem.rally_key = body.rallyKey;

  await ddb.send(new PutCommand({ TableName: CAPTURES_TABLE, Item: captureItem }));

  updatePlayerProfile(deviceId, body.faction ?? 'exorcist').catch((e) =>
    console.error('profile update failed', e),
  );

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
};

function computeRank(exp: number): string {
  if (exp >= 2000) return 'S';
  if (exp >= 500)  return 'A';
  if (exp >= 100)  return 'B';
  return 'C';
}

async function updatePlayerProfile(deviceId: string, faction: Faction) {
  const job = faction === 'supernatural' ? 'jujutsushi' : 'onmyoji';

  const res = await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression:
      'SET #faction = if_not_exists(#faction, :f), #job = if_not_exists(#job, :j), updated_at = :now ADD exp :gain',
    ExpressionAttributeNames: { '#faction': 'faction', '#job': 'job' },
    ExpressionAttributeValues: {
      ':f': faction,
      ':j': job,
      ':now': new Date().toISOString(),
      ':gain': 10,
    },
    ReturnValues: 'ALL_NEW',
  }));

  const newExp = (res.Attributes?.exp as number) ?? 0;
  const newRank = computeRank(newExp);
  if (newRank !== res.Attributes?.rank) {
    await ddb.send(new UpdateCommand({
      TableName: PLAYER_PROFILE_TABLE,
      Key: { deviceId },
      UpdateExpression: 'SET #rank = :r',
      ExpressionAttributeNames: { '#rank': 'rank' },
      ExpressionAttributeValues: { ':r': newRank },
    }));
  }
}
