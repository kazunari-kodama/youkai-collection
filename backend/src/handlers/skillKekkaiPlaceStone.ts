import type { APIGatewayProxyHandler } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, KEKKAI_STONES_TABLE, KEKKAI_BARRIERS_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import {
  JUTSU_COST,
  KEKKAI_MIN_AREA_M2,
  RANK_KEKKAI_MAX_AREA_M2,
  RANK_KEKKAI_STONE_LIMIT,
  KekkaiStoneDBItem,
  KekkaiBarrierDBItem,
} from '../types/skill';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function triangleAreaM2(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  c: { lat: number; lon: number },
): number {
  const latM = 111_320;
  const lonM = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lon * lonM, ay = a.lat * latM;
  const bx = b.lon * lonM, by = b.lat * latM;
  const cx = c.lon * lonM, cy = c.lat * latM;
  return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; userLat?: number; userLon?: number };
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deviceId, userLat, userLon } = body;
  if (!deviceId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // ランク取得
  const profileRes = await ddb.send(new GetCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));
  const rank = (profileRes.Item?.rank as string) ?? 'C';
  const maxStones = RANK_KEKKAI_STONE_LIMIT[rank] ?? 3;
  const maxArea   = RANK_KEKKAI_MAX_AREA_M2[rank] ?? RANK_KEKKAI_MAX_AREA_M2['C'];

  // アクティブな石の数チェック
  const stonesRes = await ddb.send(new QueryCommand({
    TableName: KEKKAI_STONES_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    ExpressionAttributeValues: { ':d': deviceId },
  }));
  const activeStones = (stonesRes.Items ?? []) as KekkaiStoneDBItem[];

  if (activeStones.length >= maxStones) {
    return {
      statusCode: 409,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Stone limit reached', current: activeStones.length, max: maxStones }),
    };
  }

  // 術力消費
  const jutsuResult = await deductJutsu(deviceId, JUTSU_COST.skill_kekkai_stone, false);
  if (!jutsuResult.ok) {
    return {
      statusCode: 402,
      headers: HEADERS,
      body: JSON.stringify({
        error: 'Insufficient jutsuriyoku',
        current: jutsuResult.current,
        required: JUTSU_COST.skill_kekkai_stone,
        max: jutsuResult.max,
      }),
    };
  }

  // 石を配置
  const stoneId = randomUUID();
  const now = new Date().toISOString();
  const newStone: KekkaiStoneDBItem = {
    deviceId,
    stone_id:  stoneId,
    lat:       userLat,
    lon:       userLon,
    placed_at: now,
  };
  await ddb.send(new PutCommand({ TableName: KEKKAI_STONES_TABLE, Item: newStone }));

  // 三角形チェック（新しい石を含む全triplet）
  const allStones = [...activeStones, newStone];
  let barrierFormed: KekkaiBarrierDBItem | null = null;
  let consumedStoneIds: string[] = [];

  outer: for (let i = 0; i < allStones.length - 2; i++) {
    for (let j = i + 1; j < allStones.length - 1; j++) {
      for (let k = j + 1; k < allStones.length; k++) {
        const a = allStones[i], b = allStones[j], c = allStones[k];
        const area = triangleAreaM2(a, b, c);
        if (area >= KEKKAI_MIN_AREA_M2 && area <= maxArea) {
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          barrierFormed = {
            deviceId,
            barrier_id: randomUUID(),
            lats:       [a.lat, b.lat, c.lat],
            lons:       [a.lon, b.lon, c.lon],
            center_lat: (a.lat + b.lat + c.lat) / 3,
            center_lon: (a.lon + b.lon + c.lon) / 3,
            area_m2:    Math.round(area),
            formed_at:  now,
            expires_at: expiresAt.toISOString(),
            ttl:        Math.floor(expiresAt.getTime() / 1000),
          };
          consumedStoneIds = [a.stone_id, b.stone_id, c.stone_id];
          break outer;
        }
      }
    }
  }

  if (barrierFormed) {
    await ddb.send(new PutCommand({ TableName: KEKKAI_BARRIERS_TABLE, Item: barrierFormed }));
    await Promise.all(
      consumedStoneIds.map((sid) =>
        ddb.send(new DeleteCommand({ TableName: KEKKAI_STONES_TABLE, Key: { deviceId, stone_id: sid } }))
      )
    );
  }

  const remainingCount = barrierFormed
    ? allStones.length - 3
    : allStones.length;

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      stone_placed:    true,
      stone_id:        stoneId,
      barrier_formed:  !!barrierFormed,
      barrier: barrierFormed
        ? {
            barrier_id: barrierFormed.barrier_id,
            lats:        barrierFormed.lats,
            lons:        barrierFormed.lons,
            center:      { lat: barrierFormed.center_lat, lon: barrierFormed.center_lon },
            area_m2:     barrierFormed.area_m2,
            expires_at:  barrierFormed.expires_at,
          }
        : null,
      stones_count:    remainingCount,
      max_stones:      maxStones,
      jutsu_remaining: jutsuResult.current,
    }),
  };
};
