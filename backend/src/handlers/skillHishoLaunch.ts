import type { APIGatewayProxyHandler } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, FLYING_SHIKIGAMI_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import { distanceMeters } from '../lib/distance';
import {
  RANK_SHIKIGAMI_SLOTS,
  JUTSU_COST,
  FLYING_SHIKIGAMI_SPEED_MIN_PER_KM,
  FlyingShikigamiDBItem,
} from '../types/skill';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: {
    deviceId?: string;
    targetYoukaiId?: string;
    userLat?: number;
    userLon?: number;
    debug?: boolean;
  };
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deviceId, targetYoukaiId, userLat, userLon } = body;
  if (!deviceId || !targetYoukaiId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // ランク取得（プロファイル未作成でも C 扱い）
  const profileRes = await ddb.send(new GetCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));
  const profile = profileRes.Item;
  const rank = (profile?.rank as string) ?? 'C';
  const maxSlots = RANK_SHIKIGAMI_SLOTS[rank] ?? 1;

  // 飛行中スロット数チェック
  const flyingRes = await ddb.send(new QueryCommand({
    TableName: FLYING_SHIKIGAMI_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: '#st = :flying',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':d': deviceId, ':flying': 'flying' },
    ProjectionExpression: 'shikigami_id',
  }));
  const flyingCount = (flyingRes.Items ?? []).length;
  if (flyingCount >= maxSlots) {
    return {
      statusCode: 409,
      headers: HEADERS,
      body: JSON.stringify({ error: 'All shikigami slots are in flight', flying: flyingCount, max: maxSlots }),
    };
  }

  // 目標妖怪の座標取得
  const youkaiRes = await ddb.send(new GetCommand({ TableName: YOUKAI_TABLE, Key: { yokai_id: targetYoukaiId } }));
  const youkai = youkaiRes.Item;
  if (!youkai) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Youkai not found' }) };
  }
  const targetLat: number = youkai.latitude;
  const targetLon: number = youkai.longitude;

  // 飛行時間計算
  const distanceKm = distanceMeters(userLat, userLon, targetLat, targetLon) / 1000;
  const flightMinutes = distanceKm * FLYING_SHIKIGAMI_SPEED_MIN_PER_KM;
  const launchedAt = new Date();
  const arrivesAt  = new Date(launchedAt.getTime() + flightMinutes * 60 * 1000);

  // 術力消費
  const jutsuResult = await deductJutsu(deviceId, JUTSU_COST.skill_hisho_shikigami, !!body.debug);
  if (!jutsuResult.ok) {
    return {
      statusCode: 402,
      headers: HEADERS,
      body: JSON.stringify({
        error: 'Insufficient jutsuriyoku',
        current: jutsuResult.current,
        required: JUTSU_COST.skill_hisho_shikigami,
        max: jutsuResult.max,
      }),
    };
  }

  // レコード作成
  const shikigamiId = randomUUID();
  const ttl = Math.floor(arrivesAt.getTime() / 1000) + 7 * 24 * 60 * 60; // 到達後7日でTTL
  const item: FlyingShikigamiDBItem = {
    deviceId,
    shikigami_id:     shikigamiId,
    launch_lat:       userLat,
    launch_lon:       userLon,
    target_lat:       targetLat,
    target_lon:       targetLon,
    target_youkai_id: targetYoukaiId,
    launched_at:      launchedAt.toISOString(),
    arrives_at:       arrivesAt.toISOString(),
    status:           'flying',
    ttl,
  };
  await ddb.send(new PutCommand({ TableName: FLYING_SHIKIGAMI_TABLE, Item: item }));

  // 真名既知チェック（過去に封印済みか）
  const captureRes = await ddb.send(new GetCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId: targetYoukaiId },
  }));
  const shinmeiKnown = captureRes.Item?.actionType === 'seal';

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      shikigami_id:   shikigamiId,
      launched_at:    launchedAt.toISOString(),
      arrives_at:     arrivesAt.toISOString(),
      flight_minutes: Math.round(flightMinutes),
      distance_km:    Math.round(distanceKm * 10) / 10,
      launch_lat:     userLat,
      launch_lon:     userLon,
      target_lat:     targetLat,
      target_lon:     targetLon,
      target_youkai_id: targetYoukaiId,
      shinmei_known:  shinmeiKnown,
      flying_count:   flyingCount + 1,
      max_slots:      maxSlots,
      jutsu_remaining: jutsuResult.current,
    }),
  };
};
