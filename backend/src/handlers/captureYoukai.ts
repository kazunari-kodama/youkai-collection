import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { distanceMeters } from '../lib/distance';
import { deductJutsu } from '../lib/jutsuriyoku';
import type { YokaiDBItem } from '../types/youkai';
import { YOURYOKU_RANKS, JUTSU_COST } from '../types/skill';

const CAPTURE_RADIUS_M = 13;
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

type ActionType = 'seal' | 'release' | 'bond';
type Faction    = 'exorcist' | 'supernatural';

interface CaptureRequest {
  deviceId:   string;
  youkaiId:   string;
  userLat:    number;
  userLon:    number;
  actionType?: ActionType;
  faction?:   Faction;
  rallyKey?:  string;
  qrCode?:    string;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: CaptureRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, youkaiId, userLat, userLon } = body;
  if (!deviceId || !youkaiId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  const yokaiResult = await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE,
    Key: { yokai_id: youkaiId },
    ProjectionExpression: 'yokai_id, latitude, longitude, youryoku, #rq',
    ExpressionAttributeNames: { '#rq': 'require_qr' },
  }));
  if (!yokaiResult.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Youkai not found' }) };
  }

  const youkai = yokaiResult.Item as Pick<YokaiDBItem, 'yokai_id' | 'latitude' | 'longitude' | 'require_qr' | 'youryoku'>;
  const dist   = distanceMeters(userLat, userLon, youkai.latitude, youkai.longitude);
  if (dist > CAPTURE_RADIUS_M) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Too far', distance: Math.round(dist) }) };
  }
  if (youkai.require_qr && body.qrCode !== youkaiId) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'QR code required' }) };
  }

  const actionType = body.actionType ?? 'seal';
  const faction    = body.faction    ?? 'exorcist';

  const existingRes = await ddb.send(new GetCommand({ TableName: CAPTURES_TABLE, Key: { deviceId, youkaiId } }));
  const existing    = existingRes.Item;

  // ---- 解放 ----
  if (actionType === 'release') {
    if (!existing || (existing.actionType !== 'seal' && existing.actionType !== 'bond')) {
      return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Not captured' }) };
    }
    await ddb.send(new PutCommand({
      TableName: CAPTURES_TABLE,
      Item: { ...existing, actionType: 'release', capturedAt: new Date().toISOString() },
    }));
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, actionType: 'release' }) };
  }

  // ---- 契約（bond） — 術力10必要、多段階あり ----
  if (actionType === 'bond') {
    if (existing?.actionType === 'bond') {
      return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Already bonded' }) };
    }
    const youryoku  = (youkai.youryoku ?? 1) as number;
    const rankInfo  = YOURYOKU_RANKS[youryoku] ?? YOURYOKU_RANKS[1];
    const required  = rankInfo.trials;
    const prevProg  = (existing?.seal_progress as number | undefined) ?? 0;
    const newProg   = prevProg + 1;
    const now       = new Date().toISOString();

    const jutsu = await deductJutsu(deviceId, JUTSU_COST.bond);
    if (!jutsu.ok) {
      return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
        error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.bond, max: jutsu.max,
      })};
    }

    if (newProg < required) {
      await ddb.send(new PutCommand({
        TableName: CAPTURES_TABLE,
        Item: {
          deviceId, youkaiId, actionType: 'in_progress', faction,
          seal_progress: newProg, seal_required: required,
          capturedAt: existing?.capturedAt ?? now, lastTriedAt: now,
          userLat, userLon,
          ...(body.rallyKey ? { rally_key: body.rallyKey } : {}),
        },
      }));
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
        success: true, sealed: false, progress: newProg, required, youryoku, rank_name: rankInfo.name,
        jutsuriyoku: jutsu.current, jutsuriyoku_max: jutsu.max,
      })};
    }

    const bondItem: Record<string, unknown> = {
      deviceId, youkaiId, actionType: 'bond', faction,
      capturedAt: now, userLat, userLon,
      seal_progress: required, seal_required: required,
    };
    if (body.rallyKey) bondItem.rally_key = body.rallyKey;
    await ddb.send(new PutCommand({ TableName: CAPTURES_TABLE, Item: bondItem }));
    updatePlayerProfile(deviceId, faction, rankInfo.exp).catch(e => console.error('profile update failed', e));
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      success: true, sealed: true, actionType: 'bond', youryoku,
      rank_name: rankInfo.name, exp_gained: rankInfo.exp,
      jutsuriyoku: jutsu.current, jutsuriyoku_max: jutsu.max,
    })};
  }

  // ---- 封印（seal） — 術力消費なし ----
  if (existing?.actionType === 'seal' || existing?.actionType === 'bond') {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Already captured' }) };
  }

  const youryoku  = (youkai.youryoku ?? 1) as number;
  const rankInfo  = YOURYOKU_RANKS[youryoku] ?? YOURYOKU_RANKS[1];
  const required  = rankInfo.trials;
  const prevProg  = (existing?.seal_progress as number | undefined) ?? 0;
  const newProg   = prevProg + 1;
  const now       = new Date().toISOString();

  if (newProg < required) {
    await ddb.send(new PutCommand({
      TableName: CAPTURES_TABLE,
      Item: {
        deviceId, youkaiId, actionType: 'in_progress', faction,
        seal_progress: newProg, seal_required: required,
        capturedAt: existing?.capturedAt ?? now, lastTriedAt: now,
        userLat, userLon,
        ...(body.rallyKey ? { rally_key: body.rallyKey } : {}),
      },
    }));
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      success: true, sealed: false, progress: newProg, required, youryoku, rank_name: rankInfo.name,
    })};
  }

  // 封印完了
  const sealItem: Record<string, unknown> = {
    deviceId, youkaiId, actionType: 'seal', faction,
    capturedAt: now, userLat, userLon,
    seal_progress: required, seal_required: required,
  };
  if (body.rallyKey) sealItem.rally_key = body.rallyKey;

  await ddb.send(new PutCommand({ TableName: CAPTURES_TABLE, Item: sealItem }));
  updatePlayerProfile(deviceId, faction, rankInfo.exp).catch(e => console.error('profile update failed', e));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
    success: true, sealed: true, progress: required, required, youryoku,
    rank_name: rankInfo.name, exp_gained: rankInfo.exp,
  })};
};

function computeRank(exp: number): string {
  if (exp >= 2000) return 'S';
  if (exp >= 500)  return 'A';
  if (exp >= 100)  return 'B';
  return 'C';
}

async function updatePlayerProfile(deviceId: string, faction: Faction, expGain: number) {
  const job = faction === 'supernatural' ? 'jujutsushi' : 'onmyoji';
  const res = await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression:
      'SET #faction = if_not_exists(#faction, :f), #job = if_not_exists(#job, :j),' +
      ' updated_at = :now,' +
      ' jutsuriyoku = if_not_exists(jutsuriyoku, :jmax),' +
      ' jutsu_updated_at = if_not_exists(jutsu_updated_at, :now)' +
      ' ADD exp :gain',
    ExpressionAttributeNames: { '#faction': 'faction', '#job': 'job' },
    ExpressionAttributeValues: { ':f': faction, ':j': job, ':now': new Date().toISOString(), ':gain': expGain, ':jmax': 100 },
    ReturnValues: 'ALL_NEW',
  }));
  const newExp  = (res.Attributes?.exp as number) ?? 0;
  const newRank = computeRank(newExp);
  if (newRank !== res.Attributes?.rank) {
    await ddb.send(new UpdateCommand({
      TableName: PLAYER_PROFILE_TABLE,
      Key: { deviceId },
      UpdateExpression: 'SET #rank = :r',
      ExpressionAttributeNames: { '#rank': 'rank' },
      ExpressionAttributeValues: { ':r': newRank },
    }));
  }
}
