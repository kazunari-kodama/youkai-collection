/**
 * 計算配置の捕獲リクエストの検証（I/O なし）。
 * 速度チェックと二重取り防止は DynamoDB が要るので handler 側で行う。
 */
import { SPAWN_CONFIG } from '../../config/spawn';
import { CAPTURE_RADIUS_M, distanceMeters } from '../distance';
import { computeSlot, hourWindowOf, parseSpawnId, spawnCount, windowEndSec, type ComputedSpawn, type TableFor } from './engine';

export type SpawnRejectCode =
  | 'INVALID_SPAWN'
  | 'EXPIRED'
  | 'TOO_FAR'
  | 'LOW_ACCURACY'
  | 'SPEED_ANOMALY'
  | 'ALREADY_CAPTURED';

export const REJECT_STATUS: Record<SpawnRejectCode, number> = {
  INVALID_SPAWN: 400,
  EXPIRED: 410,
  TOO_FAR: 403,
  LOW_ACCURACY: 422,
  SPEED_ANOMALY: 403,
  ALREADY_CAPTURED: 409,
};

export interface CaptureInput {
  spawnId: unknown;
  lat: unknown;
  lng: unknown;
  accuracy: unknown;
  /** クライアントが見ていた妖怪。指定されていて計算結果と違えば INVALID_SPAWN（一覧の更新を促す） */
  yokaiId?: unknown;
}

export type ValidateResult =
  | { ok: true; spawn: ComputedSpawn; distance: number }
  | { ok: false; code: SpawnRejectCode; distance?: number };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateComputedCapture(
  secret: string,
  input: CaptureInput,
  tableFor: TableFor,
  nowSec: number,
): ValidateResult {
  // 1. 形式
  const parsed = parseSpawnId(input.spawnId);
  if (!parsed || !isNum(input.lat) || !isNum(input.lng)
      || Math.abs(input.lat) > 90 || Math.abs(input.lng) > 180) {
    return { ok: false, code: 'INVALID_SPAWN' };
  }
  const { geohash, hourWindow, slot } = parsed;

  // 2. slot が実在するか（未来の時間枠も不正）
  if (hourWindow > hourWindowOf(nowSec) || slot >= spawnCount(secret, geohash, hourWindow)) {
    return { ok: false, code: 'INVALID_SPAWN' };
  }

  // 3. 時間枠（終了後 CAPTURE_GRACE_SECONDS まで）
  if (nowSec > windowEndSec(hourWindow) + SPAWN_CONFIG.CAPTURE_GRACE_SECONDS) {
    return { ok: false, code: 'EXPIRED' };
  }

  const spawn = computeSlot(secret, geohash, hourWindow, slot, tableFor);
  if (!spawn || (input.yokaiId != null && input.yokaiId !== spawn.yokai_id)) {
    return { ok: false, code: 'INVALID_SPAWN' };
  }

  // 4. 距離
  const distance = distanceMeters(input.lat, input.lng, spawn.lat, spawn.lng);
  if (distance > CAPTURE_RADIUS_M) return { ok: false, code: 'TOO_FAR', distance };

  // 5. 位置精度
  if (!isNum(input.accuracy) || input.accuracy < 0 || input.accuracy > SPAWN_CONFIG.MAX_ACCURACY_M) {
    return { ok: false, code: 'LOW_ACCURACY' };
  }

  return { ok: true, spawn, distance };
}
