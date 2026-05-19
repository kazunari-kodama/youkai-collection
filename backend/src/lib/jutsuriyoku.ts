import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PLAYER_PROFILE_TABLE } from './dynamodb';
import {
  JUTSU_BASE_MAX,
  JUTSU_PER_RANK,
  JUTSU_RECOVERY_PER_MIN,
  JUTSU_RECOVERY_PER_50M,
  RANK_JUTSU_MAX,
} from '../types/skill';

export interface JutsuProfile {
  jutsuriyoku: number;
  jutsuriyoku_max: number;
  jutsu_updated_at: string;
  distance_walked_m: number;
  distance_at_last_jutsu_update: number;
  rank: string;
}

/** ランクから術力最大値を返す */
export function maxJutsu(rank: string): number {
  return RANK_JUTSU_MAX[rank] ?? JUTSU_BASE_MAX;
}

/** 保存値と現在時刻・距離から術力現在値を計算 */
export function calcCurrentJutsu(profile: Partial<JutsuProfile>): number {
  const max      = maxJutsu(profile.rank ?? 'C');
  // jutsuriyoku が未設定（初回）は満タン扱い
  const stored   = profile.jutsuriyoku !== undefined ? profile.jutsuriyoku : max;
  const lastAt   = profile.jutsu_updated_at ? new Date(profile.jutsu_updated_at).getTime() : Date.now();
  const distNow  = profile.distance_walked_m ?? 0;
  const distLast = profile.distance_at_last_jutsu_update ?? distNow;

  const elapsedMin    = (Date.now() - lastAt) / 60_000;
  const distSince     = Math.max(0, distNow - distLast);
  const timeRecovery  = Math.floor(elapsedMin * JUTSU_RECOVERY_PER_MIN);
  const distRecovery  = Math.floor(distSince / 50) * JUTSU_RECOVERY_PER_50M;

  return Math.min(max, stored + timeRecovery + distRecovery);
}

/** 術力を current に更新してコストを引き、DynamoDB に保存する。
 *  足りなければ false を返す（引かない）。debug=true のとき消費をスキップ。 */
export async function deductJutsu(
  deviceId: string,
  cost: number,
  debug = false,
): Promise<{ ok: boolean; current: number; max: number }> {
  const res = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
  }));
  const profile = (res.Item ?? {}) as Partial<JutsuProfile>;
  const current = calcCurrentJutsu(profile);
  const max     = maxJutsu(profile.rank ?? 'C');

  if (debug) return { ok: true, current, max };

  if (current < cost) return { ok: false, current, max };

  const newValue = current - cost;
  const now      = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression:
      'SET jutsuriyoku = :v, jutsu_updated_at = :now, distance_at_last_jutsu_update = :dist',
    ExpressionAttributeValues: {
      ':v':    newValue,
      ':now':  now,
      ':dist': profile.distance_walked_m ?? 0,
    },
  }));

  return { ok: true, current: newValue, max };
}

/** 歩行距離を加算し DynamoDB を更新する。術力の再計算は次回アクセス時に遅延計算。 */
export async function addWalkedDistance(deviceId: string, meters: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression:
      'SET distance_walked_m = if_not_exists(distance_walked_m, :zero) + :m',
    ExpressionAttributeValues: { ':m': Math.round(meters), ':zero': 0 },
  }));
}
