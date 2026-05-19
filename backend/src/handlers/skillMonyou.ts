import type { APIGatewayProxyHandler } from 'aws-lambda';
import { deductJutsu } from '../lib/jutsuriyoku';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PATTERNS_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { distanceMeters } from '../lib/distance';
import type { PatternDBItem } from '../types/skill';
import { MONYOU_DAILY_LIMIT, MONYOU_MAX_ACTIVE, MONYOU_TTL_HOURS, JUTSU_COST } from '../types/skill';

const EXP_GAIN = 8;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  // GET /skill/monyou/nearby
  if (event.httpMethod === 'GET') {
    return handleNearby(event);
  }
  // POST /skill/monyou
  return handleCreate(event);
};

async function handleCreate(event: Parameters<APIGatewayProxyHandler>[0]) {
  let body: { deviceId?: string; userLat?: number; userLon?: number; debug?: boolean };
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deviceId, userLat, userLon } = body;
  if (!deviceId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // ジョブ確認
  const profileResult = await ddb.send(new GetCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));
  if (profileResult.Item?.job !== 'jujutsushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Job mismatch: jujutsushi required' }) };
  }
  // 術力チェック
  const jutsuResult = await deductJutsu(deviceId, JUTSU_COST.skill_monyou, !!body.debug);
  if (!jutsuResult.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsuResult.current, required: JUTSU_COST.skill_monyou, max: jutsuResult.max,
    })};
  }


  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  if (!body.debug) {
    // 1日制限チェック（deviceId GSIで今日作成分を数える）
    const todayPatterns = await ddb.send(new QueryCommand({
      TableName: PATTERNS_TABLE,
      IndexName: 'deviceId-expires_at-index',
      KeyConditionExpression: 'deviceId = :d AND expires_at > :start',
      FilterExpression: 'created_at >= :today',
      ExpressionAttributeValues: {
        ':d': deviceId,
        ':start': now.toISOString(),
        ':today': todayStart.toISOString(),
      },
      Select: 'COUNT',
    }));
    if ((todayPatterns.Count ?? 0) >= MONYOU_DAILY_LIMIT) {
      return { statusCode: 429, headers: HEADERS, body: JSON.stringify({ error: 'Daily limit reached', limit: MONYOU_DAILY_LIMIT }) };
    }

    // 有効紋様数チェック
    const activePatterns = await ddb.send(new QueryCommand({
      TableName: PATTERNS_TABLE,
      IndexName: 'deviceId-expires_at-index',
      KeyConditionExpression: 'deviceId = :d AND expires_at > :now',
      ExpressionAttributeValues: { ':d': deviceId, ':now': now.toISOString() },
      Select: 'COUNT',
    }));
    if ((activePatterns.Count ?? 0) >= MONYOU_MAX_ACTIVE) {
      return { statusCode: 429, headers: HEADERS, body: JSON.stringify({ error: 'Max active patterns reached', max: MONYOU_MAX_ACTIVE }) };
    }
  }

  const patternId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + MONYOU_TTL_HOURS * 3600 * 1000);
  const ttlEpoch = Math.floor(expiresAt.getTime() / 1000);

  const item: PatternDBItem & { ttl: number } = {
    pattern_id: patternId,
    deviceId,
    lat: userLat,
    lon: userLon,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    ttl: ttlEpoch,
  };

  await ddb.send(new PutCommand({ TableName: PATTERNS_TABLE, Item: item }));

  // EXP加算
  ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'ADD exp :gain SET updated_at = :now',
    ExpressionAttributeValues: { ':gain': EXP_GAIN, ':now': now.toISOString() },
  })).catch((e) => console.error('exp update failed', e));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ pattern_id: patternId, expires_at: expiresAt.toISOString(), exp_gained: EXP_GAIN }),
  };
}

async function handleNearby(event: Parameters<APIGatewayProxyHandler>[0]) {
  const qs = event.queryStringParameters ?? {};
  const lat = parseFloat(qs.lat ?? '');
  const lon = parseFloat(qs.lon ?? '');
  const radius = Math.min(parseFloat(qs.r ?? '500'), 2000);

  if (isNaN(lat) || isNaN(lon)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing lat/lon' }) };
  }

  const now = new Date().toISOString();

  // Scan + クライアントフィルタ（MVP規模では許容）
  const result = await ddb.send(new ScanCommand({
    TableName: PATTERNS_TABLE,
    FilterExpression: 'expires_at > :now',
    ExpressionAttributeValues: { ':now': now },
    ProjectionExpression: 'pattern_id, deviceId, lat, #ln, expires_at',
    ExpressionAttributeNames: { '#ln': 'lon' },
  }));

  const nearby = (result.Items ?? [])
    .filter((item) => distanceMeters(lat, lon, item.lat as number, item.lon as number) <= radius)
    .map((item) => ({
      pattern_id: item.pattern_id,
      // deviceIdは最初の4文字のみ（部分匿名化）
      author: (item.deviceId as string).slice(0, 4) + '…',
      lat: item.lat,
      lon: item.lon,
      expires_at: item.expires_at,
    }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ patterns: nearby }) };
}
