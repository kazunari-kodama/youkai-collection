import { randomUUID } from 'crypto';
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, SHOUJUTSU_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import { distanceMeters } from '../lib/distance';
import {
  JUTSU_COST,
  SHOUJUTSU_SPEED_MIN_PER_KM,
  SHOUJUTSU_RANGE_M_PER_OWN,
} from '../types/skill';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

interface LaunchRequest {
  deviceId:          string;
  summonedYoukaiId:  string;  // 自分が解除した妖怪
  targetYoukaiId:    string;  // 封印したい妖怪
  userLat:           number;
  userLon:           number;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: LaunchRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, summonedYoukaiId, targetYoukaiId, userLat, userLon } = body;
  if (!deviceId || !summonedYoukaiId || !targetYoukaiId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // 職業チェック
  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: '#j',
    ExpressionAttributeNames: { '#j': 'job' },
  }));
  if (profileRes.Item?.job !== 'yojutsushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Yojutsushi only' }) };
  }

  // 召喚する妖怪が自分の解除済みであることを確認
  const summonRes = await ddb.send(new GetCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId: summonedYoukaiId },
    ProjectionExpression: 'actionType',
  }));
  if (summonRes.Item?.actionType !== 'release') {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Summoned youkai must be your released one' }) };
  }

  // 既に飛行中の召喚術チェック（1体のみ同時許可）
  const flyingRes = await ddb.send(new QueryCommand({
    TableName: SHOUJUTSU_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: '#st = :flying',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':d': deviceId, ':flying': 'flying' },
    Select: 'COUNT',
  }));
  if ((flyingRes.Count ?? 0) > 0) {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Summon already in flight' }) };
  }

  // 所持妖怪数（seal + bond）を取得して射程計算
  const ownedRes = await ddb.send(new QueryCommand({
    TableName: CAPTURES_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: 'actionType IN (:s, :b)',
    ExpressionAttributeValues: { ':d': deviceId, ':s': 'seal', ':b': 'bond' },
    Select: 'COUNT',
  }));
  const ownedCount = ownedRes.Count ?? 0;
  const rangeM     = ownedCount * SHOUJUTSU_RANGE_M_PER_OWN;

  // 対象妖怪の座標取得
  const youkaiRes = await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE,
    Key: { yokai_id: targetYoukaiId },
    ProjectionExpression: 'yokai_id, latitude, longitude',
  }));
  if (!youkaiRes.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Target youkai not found' }) };
  }
  const targetLat = youkaiRes.Item.latitude as number;
  const targetLon = youkaiRes.Item.longitude as number;

  // 射程チェック
  const distM = distanceMeters(userLat, userLon, targetLat, targetLon);
  if (distM > rangeM) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({
      error: 'Out of range', distance_m: Math.round(distM), range_m: rangeM, owned_count: ownedCount,
    })};
  }

  // 術力消費
  const jutsu = await deductJutsu(deviceId, JUTSU_COST.skill_yojutsushi_shoujutsu, false);
  if (!jutsu.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.skill_yojutsushi_shoujutsu, max: jutsu.max,
    })};
  }

  const distKm     = distM / 1000;
  const flightMin  = Math.max(0.5, distKm * SHOUJUTSU_SPEED_MIN_PER_KM);
  const launchedAt = new Date();
  const arrivesAt  = new Date(launchedAt.getTime() + flightMin * 60 * 1000);
  const shoujutsuId = randomUUID();

  await ddb.send(new PutCommand({
    TableName: SHOUJUTSU_TABLE,
    Item: {
      deviceId,
      shoujutsu_id:      shoujutsuId,
      summoned_youkai_id: summonedYoukaiId,
      target_youkai_id:  targetYoukaiId,
      target_lat:        targetLat,
      target_lon:        targetLon,
      launched_at:       launchedAt.toISOString(),
      arrives_at:        arrivesAt.toISOString(),
      status:            'flying',
      ttl:               Math.floor(arrivesAt.getTime() / 1000) + 7 * 86400,
    },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      shoujutsu_id:  shoujutsuId,
      arrives_at:    arrivesAt.toISOString(),
      flight_minutes: Math.round(flightMin),
      distance_m:    Math.round(distM),
      target_lat:    targetLat,
      target_lon:    targetLon,
      jutsuriyoku:   jutsu.current, jutsuriyoku_max: jutsu.max,
    }),
  };
};
