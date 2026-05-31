import { randomUUID } from 'crypto';
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PLAYER_PROFILE_TABLE, KITOSHI_PRAYERS_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import { JUTSU_COST, RANK_KITOSHI_PRAYER_LIMIT, PRAYER_DURATION_HOURS } from '../types/skill';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

interface PlacePrayerRequest {
  deviceId: string;
  userLat:  number;
  userLon:  number;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: PlacePrayerRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, userLat, userLon } = body;
  if (!deviceId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: '#j, #r',
    ExpressionAttributeNames: { '#j': 'job', '#r': 'rank' },
  }));
  if (profileRes.Item?.job !== 'kitoshi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Kitoshi only' }) };
  }

  const rank      = (profileRes.Item?.rank as string | undefined) ?? 'C';
  const maxPrayer = RANK_KITOSHI_PRAYER_LIMIT[rank] ?? 3;

  const existing = await ddb.send(new QueryCommand({
    TableName: KITOSHI_PRAYERS_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: 'expires_at > :now',
    ExpressionAttributeValues: { ':d': deviceId, ':now': new Date().toISOString() },
    Select: 'COUNT',
  }));
  if ((existing.Count ?? 0) >= maxPrayer) {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({
      error: 'Prayer limit reached', current: existing.Count, max: maxPrayer,
    })};
  }

  const jutsu = await deductJutsu(deviceId, JUTSU_COST.skill_kitoshi_prayer, false);
  if (!jutsu.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.skill_kitoshi_prayer, max: jutsu.max,
    })};
  }

  const prayerId = randomUUID();
  const now      = new Date();
  const expiresAt = new Date(now.getTime() + PRAYER_DURATION_HOURS * 60 * 60 * 1000);

  await ddb.send(new PutCommand({
    TableName: KITOSHI_PRAYERS_TABLE,
    Item: {
      deviceId,
      prayer_id:  prayerId,
      lat:        userLat,
      lon:        userLon,
      placed_at:  now.toISOString(),
      expires_at: expiresAt.toISOString(),
      ttl:        Math.floor(expiresAt.getTime() / 1000),
    },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true, prayer_id: prayerId,
      lat: userLat, lon: userLon,
      expires_at: expiresAt.toISOString(),
      jutsuriyoku: jutsu.current, jutsuriyoku_max: jutsu.max,
    }),
  };
};
