import type { APIGatewayProxyHandler } from 'aws-lambda';
import { JUTSU_COST } from '../types/skill';
import { deductJutsu } from '../lib/jutsuriyoku';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { distanceMeters } from '../lib/distance';
import type { YokaiDBItem } from '../types/youkai';

const DOKAISHU_RANGE_M = 50;
const EXP_GAIN = 5;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; youkaiId?: string; userLat?: number; userLon?: number; debug?: boolean };
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deviceId, youkaiId, userLat, userLon } = body;
  if (!deviceId || !youkaiId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // ジョブ確認
  const profile = await ddb.send(new GetCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));
  if (profile.Item?.job !== 'onmyoji') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Job mismatch: onmyoji required' }) };
  }
  // 術力チェック
  const jutsuResult = await deductJutsu(deviceId, JUTSU_COST.skill_dokaishu, !!body.debug);
  if (!jutsuResult.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsuResult.current, required: JUTSU_COST.skill_dokaishu, max: jutsuResult.max,
    })};
  }


  // 既に封印/読解済みか確認
  const existing = await ddb.send(new GetCommand({ TableName: CAPTURES_TABLE, Key: { deviceId, youkaiId } }));
  if (existing.Item) {
    const at = existing.Item.actionType as string;
    if (at === 'read') {
      // 既読の場合もデータを返す（idempotent）
      const cached = existing.Item as Record<string, unknown>;
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ already_read: true, kana: cached.read_kana, category_tags: cached.read_category_tags, keywords: cached.read_keywords, name: cached.read_name }),
      };
    }
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Already captured' }) };
  }

  // 妖怪存在確認 + 距離検証
  const yokaiResult = await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE,
    Key: { yokai_id: youkaiId },
    ProjectionExpression: 'yokai_id, #n, kana, latitude, longitude, category_tags, keywords',
    ExpressionAttributeNames: { '#n': 'name' },
  }));

  if (!yokaiResult.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Youkai not found' }) };
  }

  const youkai = yokaiResult.Item as Pick<YokaiDBItem, 'yokai_id' | 'name' | 'kana' | 'latitude' | 'longitude' | 'category_tags' | 'keywords'>;
  const dist = distanceMeters(userLat, userLon, youkai.latitude, youkai.longitude);

  if (dist > DOKAISHU_RANGE_M) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Too far', distance: Math.round(dist), required: DOKAISHU_RANGE_M }),
    };
  }

  // 読解記録
  await ddb.send(new PutCommand({
    TableName: CAPTURES_TABLE,
    Item: {
      deviceId,
      youkaiId,
      actionType: 'read',
      capturedAt: new Date().toISOString(),
      userLat,
      userLon,
      read_name: youkai.name,
      read_kana: youkai.kana ?? '',
      read_category_tags: youkai.category_tags ?? [],
      read_keywords: youkai.keywords ?? [],
    },
  }));

  // EXP加算（fire-and-forget）
  ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'ADD exp :gain SET updated_at = :now',
    ExpressionAttributeValues: { ':gain': EXP_GAIN, ':now': new Date().toISOString() },
  })).catch((e) => console.error('exp update failed', e));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      name: youkai.name,
      kana: youkai.kana ?? '',
      category_tags: youkai.category_tags ?? [],
      keywords: youkai.keywords ?? [],
      exp_gained: EXP_GAIN,
    }),
  };
};
