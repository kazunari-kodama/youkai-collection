import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import { distanceMeters } from '../lib/distance';
import { JUTSU_COST } from '../types/skill';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const TAKUSEN_RADIUS_M   = 10_000;
const TAKUSEN_DURATION_H = 24;

interface TakusenRequest {
  deviceId: string;
  userLat:  number;
  userLon:  number;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: TakusenRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, userLat, userLon } = body;
  if (!deviceId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // 職業チェック＆既存託宣チェック
  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: '#j, takusen_youkai_id, takusen_expires_at',
    ExpressionAttributeNames: { '#j': 'job' },
  }));
  if (profileRes.Item?.job !== 'kitoshi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Kitoshi only' }) };
  }
  const now = new Date().toISOString();
  const existingExpiry = profileRes.Item?.takusen_expires_at as string | undefined;
  if (existingExpiry && existingExpiry > now) {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({
      error: 'Takusen already active', expires_at: existingExpiry,
    })};
  }

  // 術力消費
  const jutsu = await deductJutsu(deviceId, JUTSU_COST.skill_kitoshi_takusen, false);
  if (!jutsu.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.skill_kitoshi_takusen, max: jutsu.max,
    })};
  }

  // 封印済み妖怪IDを取得
  const capturesRes = await ddb.send(new QueryCommand({
    TableName: CAPTURES_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: 'actionType IN (:s, :b)',
    ExpressionAttributeValues: { ':d': deviceId, ':s': 'seal', ':b': 'bond' },
    ProjectionExpression: 'youkaiId',
  }));
  const capturedIds = new Set((capturesRes.Items ?? []).map((i) => i.youkaiId as string));

  // 全妖怪をスキャンして10km圏内・未封印のものを収集
  const youkaiRes = await ddb.send(new ScanCommand({
    TableName: YOUKAI_TABLE,
    ProjectionExpression: 'yokai_id, #n, latitude, longitude',
    ExpressionAttributeNames: { '#n': 'name' },
  }));

  const candidates = (youkaiRes.Items ?? []).filter((y) => {
    if (capturedIds.has(y.yokai_id as string)) return false;
    const d = distanceMeters(userLat, userLon, y.latitude as number, y.longitude as number);
    return d <= TAKUSEN_RADIUS_M;
  });

  if (candidates.length === 0) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'No youkai found in range' }) };
  }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const expiresAt = new Date(Date.now() + TAKUSEN_DURATION_H * 3600 * 1000).toISOString();

  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'SET takusen_youkai_id = :y, takusen_expires_at = :e',
    ExpressionAttributeValues: { ':y': chosen.yokai_id, ':e': expiresAt },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true,
      youkai_id:  chosen.yokai_id,
      youkai_name: chosen.name ?? '???',
      lat: chosen.latitude,
      lon: chosen.longitude,
      expires_at: expiresAt,
      jutsuriyoku: jutsu.current, jutsuriyoku_max: jutsu.max,
    }),
  };
};
