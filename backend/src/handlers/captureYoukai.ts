import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, KEKKAI_BARRIERS_TABLE, ARAGAMI_TABLE, NOROI_CURSES_TABLE, SPAWN_CAPTURES_TABLE } from '../lib/dynamodb';
import { isInsideAnyBarrier } from '../lib/geometry';
import { CAPTURE_RADIUS_M, distanceMeters } from '../lib/distance';
import { deductJutsu } from '../lib/jutsuriyoku';
import { getSpawnSecret } from '../lib/spawn/secret';
import { getSpawnPool } from '../lib/spawn/pool';
import { checkAndRecordMovement } from '../lib/spawn/movement';
import { validateComputedCapture, REJECT_STATUS, type SpawnRejectCode } from '../lib/spawn/validate';
import { SPAWN_CONFIG } from '../config/spawn';
import type { YokaiDBItem } from '../types/youkai';
import { YOURYOKU_RANKS, JUTSU_COST, rankBeatsYouryoku, NOROI_EFFECT_HOURS } from '../types/skill';
import { isValidDeviceId } from '../lib/deviceId';

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
  job?:       string;
  rallyKey?:  string;
  qrCode?:    string;
  debug?:     boolean;
  // ---- 計算配置（spawn_id があるときはこちらの経路） ----
  spawn_id?:  string;
  lat?:       number;
  lng?:       number;
  accuracy?:  number;
}

/** 封印・契約の本体に渡す値。固定配置と計算配置で共通 */
interface CaptureContext {
  deviceId:   string;
  youkaiId:   string;
  /** 結界判定に使う妖怪の位置（計算配置では出現座標） */
  youkai:     Pick<YokaiDBItem, 'latitude' | 'longitude' | 'youryoku'>;
  userLat:    number;
  userLon:    number;
  actionType: ActionType;
  faction:    Faction;
  job?:       string;
  rallyKey?:  string;
  debug?:     boolean;
  /** true なら補正に関係なく1回で封印・契約が成立する（計算配置） */
  singleAttempt?: boolean;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: CaptureRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (body.spawn_id !== undefined) return captureComputed(body);

  const { deviceId, youkaiId, userLat, userLon } = body;
  if (!isValidDeviceId(deviceId) || !youkaiId || userLat == null || userLon == null) {
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

  return applyCapture({
    deviceId, youkaiId, youkai, userLat, userLon,
    actionType: body.actionType ?? 'seal',
    faction:    body.faction    ?? 'exorcist',
    job:        body.job,
    rallyKey:   body.rallyKey,
    debug:      body.debug,
  });
};

// ---- 計算配置の捕獲 --------------------------------------------------------

function reject(code: SpawnRejectCode, extra: Record<string, unknown> = {}): APIGatewayProxyResult {
  return { statusCode: REJECT_STATUS[code], headers: HEADERS, body: JSON.stringify({ error: code, code, ...extra }) };
}

/**
 * spawn_id をサーバー側で計算し直して検証し、通ったら固定配置と同じ applyCapture で図鑑に反映する。
 * 二重取りは「ユーザー × spawn_id」の条件付き書き込みで防ぐ。
 */
async function captureComputed(body: CaptureRequest): Promise<APIGatewayProxyResult> {
  const { deviceId } = body;
  const actionType = body.actionType ?? 'seal';
  if (!isValidDeviceId(deviceId)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }
  if (actionType !== 'seal' && actionType !== 'bond') {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unsupported actionType' }) };
  }

  const nowMs = Date.now();
  const [secret, pool] = await Promise.all([getSpawnSecret(), getSpawnPool(nowMs)]);

  // 1〜5: 形式・slot の実在・時間枠・距離・位置精度
  const v = validateComputedCapture(
    secret,
    { spawnId: body.spawn_id, lat: body.lat, lng: body.lng, accuracy: body.accuracy, yokaiId: body.youkaiId },
    pool.tableFor,
    nowMs / 1000,
  );
  if (!v.ok) return reject(v.code, v.distance != null ? { distance: Math.round(v.distance) } : {});
  const { spawn } = v;
  const lat = body.lat as number;
  const lng = body.lng as number;

  // 6: 移動速度
  const mv = await checkAndRecordMovement(deviceId, lat, lng, nowMs);
  if (!mv.ok) {
    console.warn(JSON.stringify({
      event: 'SPEED_ANOMALY', deviceId, spawn_id: spawn.spawn_id,
      speed_kmh: Math.round(mv.speedKmh), lat, lng,
    }));
    return reject('SPEED_ANOMALY');
  }

  // 二重取り防止（ユーザー × spawn_id）
  const recordKey = { deviceId, spawn_id: spawn.spawn_id };
  try {
    await ddb.send(new PutCommand({
      TableName: SPAWN_CAPTURES_TABLE,
      Item: {
        ...recordKey,
        yokai_id: spawn.yokai_id,
        captured_at: new Date(nowMs).toISOString(),
        userLat: lat, userLon: lng, accuracy: body.accuracy,
        ttl: Math.floor(nowMs / 1000) + SPAWN_CONFIG.CAPTURE_RECORD_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(spawn_id)',
    }));
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return reject('ALREADY_CAPTURED');
    throw e;
  }
  const rollback = () => ddb.send(new DeleteCommand({ TableName: SPAWN_CAPTURES_TABLE, Key: recordKey }))
    .catch((e) => console.error('spawn capture rollback failed', e));

  let result: APIGatewayProxyResult;
  try {
    const yRes = await ddb.send(new GetCommand({
      TableName: YOUKAI_TABLE,
      Key: { yokai_id: spawn.yokai_id },
      ProjectionExpression: 'youryoku',
    }));
    if (!yRes.Item) { await rollback(); return reject('INVALID_SPAWN'); }

    result = await applyCapture({
      deviceId,
      youkaiId: spawn.yokai_id,
      youkai: { latitude: spawn.lat, longitude: spawn.lng, youryoku: yRes.Item.youryoku },
      userLat: lat, userLon: lng,
      actionType,
      faction: body.faction ?? 'exorcist',
      job: body.job,
      debug: body.debug,
      singleAttempt: SPAWN_CONFIG.SINGLE_ATTEMPT,
    });
  } catch (e) {
    await rollback();
    throw e;
  }

  const resBody = JSON.parse(result.body) as Record<string, unknown>;
  // 図鑑に既に在る妖怪（封印済み・契約済み）: 計算配置は経験値稼ぎの場なので、
  // 図鑑は変えずに経験値だけ与える（術力は消費しない）
  if (result.statusCode === 409) {
    const exp = SPAWN_CONFIG.REENCOUNTER_EXP;
    await updatePlayerProfile(deviceId, body.faction ?? 'exorcist', exp, body.job);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      success: true, already_in_zukan: true, exp_gained: exp,
      spawn_id: spawn.spawn_id, youkaiId: spawn.yokai_id,
    })};
  }
  // 術力不足などで図鑑に反映できなかったときは、出現を消費しない
  if (result.statusCode !== 200) {
    await rollback();
    return result;
  }
  return { ...result, body: JSON.stringify({ ...resBody, spawn_id: spawn.spawn_id, youkaiId: spawn.yokai_id }) };
}

// ---- 封印・契約・解放（固定配置・計算配置で共通） ------------------------------

async function applyCapture(ctx: CaptureContext): Promise<APIGatewayProxyResult> {
  const { deviceId, youkaiId, youkai, userLat, userLon, actionType, faction } = ctx;
  const body = { job: ctx.job, rallyKey: ctx.rallyKey, debug: ctx.debug };

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
    const required  = ctx.singleAttempt ? 1 : rankInfo.trials;
    const prevProg  = (existing?.seal_progress as number | undefined) ?? 0;
    const newProg   = prevProg + 1;
    const now       = new Date().toISOString();

    const jutsu = await deductJutsu(deviceId, JUTSU_COST.bond, !!body.debug);
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
    updatePlayerProfile(deviceId, faction, rankInfo.exp, body.job).catch(e => console.error('profile update failed', e));
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
  const prevProg  = (existing?.seal_progress as number | undefined) ?? 0;
  const now       = new Date().toISOString();

  // 結界ボーナス・荒魂チェックを並列取得
  const [barriersRes, playerRes, aragamiRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: KEKKAI_BARRIERS_TABLE,
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
      ProjectionExpression: 'lats, lons, expires_at',
    })),
    ddb.send(new GetCommand({
      TableName: PLAYER_PROFILE_TABLE,
      Key: { deviceId },
      ProjectionExpression: '#r, omikuji_chukichi_until, #j, yamabushi_traversal_bonus, prayer_mod, prayer_mod_until, takusen_youkai_id, takusen_expires_at, takusen_lat, takusen_lon',
      ExpressionAttributeNames: { '#r': 'rank', '#j': 'job' },
    })),
    ddb.send(new GetCommand({
      TableName: ARAGAMI_TABLE,
      Key: { youkaiId },
      ProjectionExpression: 'youryoku, expires_at',
    })),
  ]);

  const barriers              = (barriersRes.Items ?? []) as Array<{ lats: number[]; lons: number[]; expires_at: string }>;
  const playerRank            = (playerRes.Item?.rank as string | undefined) ?? 'C';
  const playerJob             = (playerRes.Item?.job as string | undefined) ?? '';
  const yamabushiBonus        = playerJob === 'yamabushi'
    ? ((playerRes.Item?.yamabushi_traversal_bonus as number | undefined) ?? 0)
    : 0;
  const aragamiItem = aragamiRes.Item;
  const isAragami   = !!(aragamiItem && (aragamiItem.expires_at as string) > now);
  const aragamiYouryoku = isAragami ? (aragamiItem!.youryoku as number) : 0;

  // 和魂印ボーナス: 神子が鎮魂術を使った妖怪は封印試行回数-1
  const nigitamaBonus = !!(existing?.nigitama_at);

  // 中吉ボーナス: おみくじ中吉が有効期間内なら試行回数-1
  const chukichiUntil = playerRes.Item?.omikuji_chukichi_until as string | undefined;
  const chukichiBonus = !!(chukichiUntil && chukichiUntil > now);

  // 祈祷師の祈り効果: 払い手-1 / 招き手+1
  const prayerMod      = (playerRes.Item?.prayer_mod      as number | undefined) ?? 0;
  const prayerModUntil = (playerRes.Item?.prayer_mod_until as string | undefined) ?? '';
  const prayerBonus    = (prayerModUntil > now) ? prayerMod : 0;

  // 託宣ボーナス: 指定された妖怪のみ-2
  const takusenYoukaiId  = (playerRes.Item?.takusen_youkai_id  as string | undefined) ?? '';
  const takusenExpiresAt = (playerRes.Item?.takusen_expires_at as string | undefined) ?? '';
  const takusenBonus     = (takusenYoukaiId === youkaiId && takusenExpiresAt > now) ? 2 : 0;

  // 結界ボーナス判定
  // 荒魂化された妖怪が結界内にいる場合は結界無効（ただし陰陽師ランクが妖力より高ければ有効）
  const insideBarrier = isInsideAnyBarrier(youkai.latitude, youkai.longitude, barriers);
  const kekkaiBonus = insideBarrier && (!isAragami || rankBeatsYouryoku(playerRank, aragamiYouryoku));

  // 荒魂デバフ: 封印試行回数+1
  const aragamiPenalty = isAragami ? 1 : 0;
  const required = ctx.singleAttempt ? 1 : Math.max(1,
    rankInfo.trials
    - (kekkaiBonus   ? 1 : 0)
    - (nigitamaBonus ? 1 : 0)
    - (chukichiBonus ? 1 : 0)
    - yamabushiBonus
    - takusenBonus     // 託宣: 指定妖怪-2
    + prayerBonus      // 祈り: 払い手-1 / 招き手+1
    + aragamiPenalty
  );

  const newProg = prevProg + 1;

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
      success: true, sealed: false, progress: newProg, required, youryoku,
      rank_name: rankInfo.name,
      kekkai_bonus: kekkaiBonus, nigitama_bonus: nigitamaBonus,
      chukichi_bonus: chukichiBonus, aragami_debuff: isAragami,
      yamabushi_bonus: yamabushiBonus > 0 ? yamabushiBonus : undefined,
      prayer_bonus: prayerBonus !== 0 ? prayerBonus : undefined,
      takusen_bonus: takusenBonus > 0 ? takusenBonus : undefined,
    })};
  }

  // 封印完了 — 和魂印をクリア
  const sealItem: Record<string, unknown> = {
    deviceId, youkaiId, actionType: 'seal', faction,
    capturedAt: now, userLat, userLon,
    seal_progress: required, seal_required: required,
  };
  if (body.rallyKey) sealItem.rally_key = body.rallyKey;

  await ddb.send(new PutCommand({ TableName: CAPTURES_TABLE, Item: sealItem }));
  updatePlayerProfile(deviceId, faction, rankInfo.exp, body.job).catch(e => console.error('profile update failed', e));

  // 呪い判定: 払い手が呪われた妖怪を封印した場合
  let curseApplied = false;
  if (faction === 'exorcist') {
    const noroiRes = await ddb.send(new GetCommand({
      TableName: NOROI_CURSES_TABLE,
      Key: { youkai_id: youkaiId },
      ProjectionExpression: 'expires_at',
    }));
    if (noroiRes.Item && (noroiRes.Item.expires_at as string) > now) {
      const curseUntil = new Date(Date.now() + NOROI_EFFECT_HOURS * 3600 * 1000).toISOString();
      await ddb.send(new UpdateCommand({
        TableName: PLAYER_PROFILE_TABLE,
        Key: { deviceId },
        UpdateExpression: 'SET curse_expires_at = :c',
        ExpressionAttributeValues: { ':c': curseUntil },
      }));
      curseApplied = true;
    }
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
    success: true, sealed: true, progress: required, required, youryoku,
    rank_name: rankInfo.name, exp_gained: rankInfo.exp,
    kekkai_bonus: kekkaiBonus, nigitama_bonus: nigitamaBonus,
    chukichi_bonus: chukichiBonus, aragami_debuff: isAragami,
    yamabushi_bonus: yamabushiBonus > 0 ? yamabushiBonus : undefined,
    curse_applied: curseApplied || undefined,
  })};
};

function computeRank(exp: number): string {
  if (exp >= 2000) return 'S';
  if (exp >= 500)  return 'A';
  if (exp >= 100)  return 'B';
  return 'C';
}

async function updatePlayerProfile(deviceId: string, faction: Faction, expGain: number, jobOverride?: string) {
  const job = jobOverride ?? (faction === 'supernatural' ? 'jujutsushi' : 'onmyoji');
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
