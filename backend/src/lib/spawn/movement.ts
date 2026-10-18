/**
 * 移動速度チェック。ユーザーごとに「最後に信用した位置と時刻」を player-profile に持ち、
 * そこからの速度が上限を超える位置は拒否する。
 *
 * 拒否したときは位置を更新しない。瞬間移動した直後に何度試しても通らず、
 * 実際に移動できるだけの時間が経てば自然に通るようになる（冷却時間の役割）。
 */
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PLAYER_PROFILE_TABLE } from '../dynamodb';
import { distanceMeters } from '../distance';
import { SPAWN_CONFIG } from '../../config/spawn';

export interface LastPosition {
  lat: number;
  lng: number;
  atMs: number;
}

/** 前回位置からの速度（km/h）。GPS の揺らぎ分は距離から差し引く */
export function speedKmh(prev: LastPosition, lat: number, lng: number, nowMs: number): number {
  const d = Math.max(0, distanceMeters(prev.lat, prev.lng, lat, lng) - SPAWN_CONFIG.SPEED_GPS_TOLERANCE_M);
  if (d === 0) return 0;
  const hours = Math.max(nowMs - prev.atMs, 1000) / 3_600_000;
  return d / 1000 / hours;
}

export async function checkAndRecordMovement(
  deviceId: string,
  lat: number,
  lng: number,
  nowMs = Date.now(),
): Promise<{ ok: true } | { ok: false; speedKmh: number }> {
  const res = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: 'spawn_last_lat, spawn_last_lng, spawn_last_at',
  }));
  const it = res.Item;
  if (it && typeof it.spawn_last_lat === 'number' && typeof it.spawn_last_at === 'number') {
    const v = speedKmh({ lat: it.spawn_last_lat, lng: it.spawn_last_lng, atMs: it.spawn_last_at }, lat, lng, nowMs);
    if (v > SPAWN_CONFIG.MAX_SPEED_KMH) return { ok: false, speedKmh: v };
  }
  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'SET spawn_last_lat = :lat, spawn_last_lng = :lng, spawn_last_at = :at',
    ExpressionAttributeValues: { ':lat': lat, ':lng': lng, ':at': nowMs },
  }));
  return { ok: true };
}
