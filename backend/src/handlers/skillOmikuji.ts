import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { calcCurrentJutsu, maxJutsu, type JutsuProfile } from '../lib/jutsuriyoku';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const OMIKUJI_COOLDOWN_HOURS = 24;
const CHUKICHI_DURATION_MS   = 60 * 60 * 1000; // 1時間

// 重み付きくじ。大凶・大吉は各5%でレア
const OMIKUJI_TABLE = [
  { result: 'daikyo',   weight:  5 },  // 大凶 5%
  { result: 'kyo',      weight: 25 },  // 凶 25%
  { result: 'kichi',    weight: 45 },  // 吉 45%
  { result: 'chukichi', weight: 20 },  // 中吉 20%
  { result: 'daikichi', weight:  5 },  // 大吉 5%
] as const;
const TOTAL_WEIGHT = OMIKUJI_TABLE.reduce((s, o) => s + o.weight, 0);

type OmikujiResult = typeof OMIKUJI_TABLE[number]['result'];

function roll(): OmikujiResult {
  const r = Math.random() * TOTAL_WEIGHT;
  let acc = 0;
  for (const o of OMIKUJI_TABLE) {
    acc += o.weight;
    if (r < acc) return o.result;
  }
  return 'kichi';
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string };
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId } = body;
  if (!deviceId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing deviceId' }) };
  }

  // プロフィール取得（神子確認・術力計算・クールダウン確認）
  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
  }));
  const profile = (profileRes.Item ?? {}) as Partial<JutsuProfile> & {
    job?: string;
    last_omikuji_at?: string;
    omikuji_chukichi_until?: string;
  };

  if (profile.job !== 'miko') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Miko only' }) };
  }

  // 24時間クールダウン
  const now = new Date();
  const nowIso = now.toISOString();
  if (profile.last_omikuji_at) {
    const nextAvailable = new Date(
      new Date(profile.last_omikuji_at).getTime() + OMIKUJI_COOLDOWN_HOURS * 3600 * 1000
    );
    if (now < nextAvailable) {
      return { statusCode: 429, headers: HEADERS, body: JSON.stringify({
        error: 'Cooldown',
        next_available: nextAvailable.toISOString(),
      })};
    }
  }

  const result = roll();
  const currentJutsu = calcCurrentJutsu(profile);
  const jutsuMax     = maxJutsu(profile.rank ?? 'C');

  let effectPayload: Record<string, unknown> = {};

  // ---- 大凶: 解除した妖怪一体が封印前に戻る ----
  if (result === 'daikyo') {
    const capturesRes = await ddb.send(new QueryCommand({
      TableName: CAPTURES_TABLE,
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
      ProjectionExpression: 'youkaiId, actionType, faction, capturedAt, userLat, userLon',
    }));
    const released = (capturesRes.Items ?? []).filter((c) => c.actionType === 'release');
    if (released.length > 0) {
      const target = pickRandom(released);
      await ddb.send(new PutCommand({
        TableName: CAPTURES_TABLE,
        Item: {
          ...target,
          actionType: 'seal',
          capturedAt: nowIso,
        },
      }));
      effectPayload = { affected_youkai_id: target.youkaiId as string };
    }
  }

  // ---- 凶: 術力-20 ----
  else if (result === 'kyo') {
    const newJutsu = Math.max(0, currentJutsu - 20);
    await ddb.send(new UpdateCommand({
      TableName: PLAYER_PROFILE_TABLE,
      Key: { deviceId },
      UpdateExpression: 'SET jutsuriyoku = :v, jutsu_updated_at = :now, distance_at_last_jutsu_update = :dist',
      ExpressionAttributeValues: {
        ':v':    newJutsu,
        ':now':  nowIso,
        ':dist': (profile.distance_walked_m ?? 0),
      },
    }));
    effectPayload = { jutsu_delta: -20, jutsuriyoku: newJutsu, jutsuriyoku_max: jutsuMax };
  }

  // ---- 吉: 術力+20 ----
  else if (result === 'kichi') {
    const newJutsu = Math.min(jutsuMax, currentJutsu + 20);
    await ddb.send(new UpdateCommand({
      TableName: PLAYER_PROFILE_TABLE,
      Key: { deviceId },
      UpdateExpression: 'SET jutsuriyoku = :v, jutsu_updated_at = :now, distance_at_last_jutsu_update = :dist',
      ExpressionAttributeValues: {
        ':v':    newJutsu,
        ':now':  nowIso,
        ':dist': (profile.distance_walked_m ?? 0),
      },
    }));
    effectPayload = { jutsu_delta: +20, jutsuriyoku: newJutsu, jutsuriyoku_max: jutsuMax };
  }

  // ---- 中吉: 1時間 試行回数-1 ----
  else if (result === 'chukichi') {
    const bonusUntil = new Date(now.getTime() + CHUKICHI_DURATION_MS).toISOString();
    await ddb.send(new UpdateCommand({
      TableName: PLAYER_PROFILE_TABLE,
      Key: { deviceId },
      UpdateExpression: 'SET omikuji_chukichi_until = :u',
      ExpressionAttributeValues: { ':u': bonusUntil },
    }));
    effectPayload = { bonus_until: bonusUntil };
  }

  // ---- 大吉: ランダム妖怪一体を解除 ----
  else if (result === 'daikichi') {
    const capturesRes = await ddb.send(new QueryCommand({
      TableName: CAPTURES_TABLE,
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
      ProjectionExpression: 'youkaiId, actionType, faction, capturedAt, userLat, userLon',
    }));
    const sealed = (capturesRes.Items ?? []).filter(
      (c) => c.actionType === 'seal' || c.actionType === 'bond',
    );
    if (sealed.length > 0) {
      const target = pickRandom(sealed);
      await ddb.send(new PutCommand({
        TableName: CAPTURES_TABLE,
        Item: {
          ...target,
          actionType: 'release',
          capturedAt: nowIso,
        },
      }));
      effectPayload = { affected_youkai_id: target.youkaiId as string };
    }
  }

  // クールダウン更新
  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'SET last_omikuji_at = :now',
    ExpressionAttributeValues: { ':now': nowIso },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ success: true, result, ...effectPayload }),
  };
};
