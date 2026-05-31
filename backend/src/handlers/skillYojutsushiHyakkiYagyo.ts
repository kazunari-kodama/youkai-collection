import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import { distanceMeters } from '../lib/distance';
import {
  JUTSU_COST,
  YOURYOKU_RANKS,
  HYAKKI_RANGE_M_PER_RELEASE,
  HYAKKI_MAX_TARGETS,
} from '../types/skill';
import type { YokaiDBItem } from '../types/youkai';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; userLat?: number; userLon?: number };
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, userLat, userLon } = body;
  if (!deviceId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // SSランクチェック
  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: '#r, #j',
    ExpressionAttributeNames: { '#r': 'rank', '#j': 'job' },
  }));
  if (profileRes.Item?.job !== 'yojutsushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Yojutsushi only' }) };
  }
  if (profileRes.Item?.rank !== 'SS') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'SS rank required' }) };
  }

  // 解除数カウント（射程計算用）
  const releasedRes = await ddb.send(new QueryCommand({
    TableName: CAPTURES_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: 'actionType = :r',
    ExpressionAttributeValues: { ':d': deviceId, ':r': 'release' },
    Select: 'COUNT',
  }));
  const releasedCount = releasedRes.Count ?? 0;
  const rangeM        = releasedCount * HYAKKI_RANGE_M_PER_RELEASE;

  if (rangeM === 0) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No released youkai — range is 0' }) };
  }

  // 術力消費
  const jutsu = await deductJutsu(deviceId, JUTSU_COST.skill_yojutsushi_hyakki, false);
  if (!jutsu.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.skill_yojutsushi_hyakki, max: jutsu.max,
    })};
  }

  // 自分が既に封印・試行中の妖怪IDを取得（対象外にする）
  const ownCaptures = await ddb.send(new QueryCommand({
    TableName: CAPTURES_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    ExpressionAttributeValues: { ':d': deviceId },
    ProjectionExpression: 'youkaiId, actionType',
  }));
  const alreadyCaptured = new Set(
    (ownCaptures.Items ?? [])
      .filter((c) => c.actionType === 'seal' || c.actionType === 'bond')
      .map((c) => c.youkaiId as string)
  );

  // 射程内の全妖怪スキャン
  const youkaiRes = await ddb.send(new ScanCommand({
    TableName: YOUKAI_TABLE,
    ProjectionExpression: 'yokai_id, latitude, longitude, youryoku',
  }));

  const candidates = (youkaiRes.Items ?? [])
    .filter((y) => {
      if (alreadyCaptured.has(y.yokai_id as string)) return false;
      const d = distanceMeters(userLat, userLon, y.latitude as number, y.longitude as number);
      return d <= rangeM;
    })
    .slice(0, HYAKKI_MAX_TARGETS);

  const now      = new Date().toISOString();
  const results: Array<{ youkai_id: string; progress: number; required: number; sealed: boolean }> = [];

  for (const y of candidates) {
    const youkaiId  = y.yokai_id as string;
    const youryoku  = (y.youryoku ?? 1) as number;
    const rankInfo  = YOURYOKU_RANKS[youryoku] ?? YOURYOKU_RANKS[1];
    const required  = rankInfo.trials;

    const capRes = await ddb.send(new GetCommand({
      TableName: CAPTURES_TABLE,
      Key: { deviceId, youkaiId },
      ProjectionExpression: 'actionType, seal_progress, capturedAt',
    }));
    const existing = capRes.Item;
    if (existing?.actionType === 'seal' || existing?.actionType === 'bond') continue;

    const prevProg = (existing?.seal_progress as number | undefined) ?? 0;
    const newProg  = prevProg + 1;
    const sealed   = newProg >= required;

    await ddb.send(new PutCommand({
      TableName: CAPTURES_TABLE,
      Item: {
        deviceId, youkaiId,
        actionType:    sealed ? 'seal' : 'in_progress',
        faction:       'supernatural',
        seal_progress: newProg,
        seal_required: required,
        capturedAt:    existing?.capturedAt ?? now,
        lastTriedAt:   now,
        userLat, userLon,
        via_hyakki:    true,
      },
    }));
    results.push({ youkai_id: youkaiId, progress: newProg, required, sealed });
  }

  // EXP加算
  const expGain = results.reduce((acc, r) => acc + (r.sealed ? 15 : 5), 0);
  if (expGain > 0) {
    await ddb.send(new UpdateCommand({
      TableName: PLAYER_PROFILE_TABLE,
      Key: { deviceId },
      UpdateExpression: 'ADD exp :g SET updated_at = :now',
      ExpressionAttributeValues: { ':g': expGain, ':now': now },
    }));
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true,
      range_m:       rangeM,
      released_count: releasedCount,
      affected:      results.length,
      sealed_count:  results.filter((r) => r.sealed).length,
      results,
      exp_gained:    expGain,
      jutsuriyoku:   jutsu.current, jutsuriyoku_max: jutsu.max,
    }),
  };
};
