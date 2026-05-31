import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, KEKKAI_BARRIERS_TABLE, ARAGAMI_TABLE } from '../lib/dynamodb';
import { isInsideAnyBarrier } from '../lib/geometry';
import { distanceMeters } from '../lib/distance';
import { deductJutsu } from '../lib/jutsuriyoku';
import type { YokaiDBItem } from '../types/youkai';
import { YOURYOKU_RANKS, JUTSU_COST, rankBeatsYouryoku } from '../types/skill';

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
  job?:       string;
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
      ProjectionExpression: '#r, omikuji_chukichi_until, #j, yamabushi_traversal_bonus, prayer_mod, prayer_mod_until, takusen_youkai_id, takusen_expires_at',
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
  const required = Math.max(1,
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

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
    success: true, sealed: true, progress: required, required, youryoku,
    rank_name: rankInfo.name, exp_gained: rankInfo.exp,
    kekkai_bonus: kekkaiBonus, nigitama_bonus: nigitamaBonus,
    chukichi_bonus: chukichiBonus, aragami_debuff: isAragami,
    yamabushi_bonus: yamabushiBonus > 0 ? yamabushiBonus : undefined,
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
