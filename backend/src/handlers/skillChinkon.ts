import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, ARAGAMI_TABLE } from '../lib/dynamodb';
import { distanceMeters } from '../lib/distance';
import { deductJutsu } from '../lib/jutsuriyoku';
import { JUTSU_COST, YOURYOKU_RANKS, rankMeetsYouryoku } from '../types/skill';
import type { YokaiDBItem } from '../types/youkai';

const CAPTURE_RADIUS_M = 13;
const CHINKON_EXP      = 20;
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; youkaiId?: string; userLat?: number; userLon?: number };
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, youkaiId, userLat, userLon } = body;
  if (!deviceId || !youkaiId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // 神子ロール確認 + ランク取得
  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: 'job, #r',
    ExpressionAttributeNames: { '#r': 'rank' },
  }));
  if (profileRes.Item?.job !== 'miko') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Miko only' }) };
  }
  const playerRank = (profileRes.Item?.rank as string | undefined) ?? 'C';

  // 妖怪の位置・妖力を取得
  const yokaiRes = await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE,
    Key: { yokai_id: youkaiId },
    ProjectionExpression: 'latitude, longitude, youryoku, #n',
    ExpressionAttributeNames: { '#n': 'name' },
  }));
  if (!yokaiRes.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Youkai not found' }) };
  }
  const yokai    = yokaiRes.Item as Pick<YokaiDBItem, 'latitude' | 'longitude' | 'youryoku' | 'name'>;
  const youryoku = (yokai.youryoku as number | undefined) ?? 1;
  const rankInfo = YOURYOKU_RANKS[youryoku] ?? YOURYOKU_RANKS[1];

  // 位置チェック
  const dist = distanceMeters(userLat, userLon, yokai.latitude, yokai.longitude);
  if (dist > CAPTURE_RADIUS_M) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Too far', distance: Math.round(dist) }) };
  }

  // 荒魂化確認
  const now = new Date().toISOString();
  const aragamiRes = await ddb.send(new GetCommand({
    TableName: ARAGAMI_TABLE,
    Key: { youkaiId },
    ProjectionExpression: 'youryoku, expires_at',
  }));
  if (!aragamiRes.Item || (aragamiRes.Item.expires_at as string) <= now) {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Not aragami' }) };
  }

  // ランク条件チェック（神子ランク >= 妖力相当ランク）
  if (!rankMeetsYouryoku(playerRank, youryoku)) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({
      error: 'Rank too low',
      player_rank: playerRank,
      required_youryoku: youryoku,
      youryoku_name: rankInfo.name,
    })};
  }

  // 術力消費
  const jutsu = await deductJutsu(deviceId, JUTSU_COST.skill_chinkon);
  if (!jutsu.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.skill_chinkon, max: jutsu.max,
    })};
  }

  // 荒魂レコードを削除
  await ddb.send(new DeleteCommand({
    TableName: ARAGAMI_TABLE,
    Key: { youkaiId },
  }));

  // 和魂印を CAPTURES_TABLE に記録（封印時ボーナスに使用）
  await ddb.send(new UpdateCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId },
    UpdateExpression: 'SET nigitama_at = :now',
    ExpressionAttributeValues: { ':now': now },
  }));

  // EXP 付与
  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'ADD exp :gain',
    ExpressionAttributeValues: { ':gain': CHINKON_EXP },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success:    true,
      youkaiId,
      youkaiName: yokai.name,
      youryoku,
      exp_gained: CHINKON_EXP,
      jutsuriyoku:     jutsu.current,
      jutsuriyoku_max: jutsu.max,
    }),
  };
};
