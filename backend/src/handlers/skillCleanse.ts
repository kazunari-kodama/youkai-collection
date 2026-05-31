import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PLAYER_PROFILE_TABLE, KITOSHI_PRAYERS_TABLE, KEKKAI_BARRIERS_TABLE } from '../lib/dynamodb';
import { distanceMeters } from '../lib/distance';
import { isInsideAnyBarrier } from '../lib/geometry';
import { PRAYER_RADIUS_M } from '../types/skill';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

interface CleanseRequest {
  deviceId: string;
  userLat:  number;
  userLon:  number;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: CleanseRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, userLat, userLon } = body;
  if (!deviceId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // 呪い有効チェック
  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: 'curse_expires_at',
  }));
  const curseExpiry = profileRes.Item?.curse_expires_at as string | undefined;
  const now = new Date().toISOString();
  if (!curseExpiry || curseExpiry <= now) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, already_clean: true }) };
  }

  // 祈祷エリア判定
  const prayersRes = await ddb.send(new ScanCommand({
    TableName: KITOSHI_PRAYERS_TABLE,
    FilterExpression: 'expires_at > :now',
    ExpressionAttributeValues: { ':now': now },
    ProjectionExpression: 'lat, lon',
  }));
  const inPrayerZone = (prayersRes.Items ?? []).some(
    (p) => distanceMeters(userLat, userLon, p.lat as number, p.lon as number) <= PRAYER_RADIUS_M
  );

  // 結界エリア判定
  let inBarrier = false;
  if (!inPrayerZone) {
    const barriersRes = await ddb.send(new ScanCommand({
      TableName: KEKKAI_BARRIERS_TABLE,
      FilterExpression: 'expires_at > :now',
      ExpressionAttributeValues: { ':now': now },
      ProjectionExpression: 'lats, lons, expires_at',
    }));
    const barriers = (barriersRes.Items ?? []) as Array<{ lats: number[]; lons: number[]; expires_at: string }>;
    inBarrier = isInsideAnyBarrier(userLat, userLon, barriers);
  }

  if (!inPrayerZone && !inBarrier) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Not in cleansing zone' }) };
  }

  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'REMOVE curse_expires_at',
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ ok: true, cleansed: true }),
  };
};
