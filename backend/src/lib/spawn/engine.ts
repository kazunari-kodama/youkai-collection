/**
 * 計算配置（computed spawns）の決定ロジック。
 *
 * マス（geohash）× 時間枠 × 秘密の値 から HMAC-SHA256 で乱数を作り、
 * 体数・座標・妖怪を決める。DB を見ずに、同じ入力なら誰が計算しても同じ結果になる。
 * サーバー専用。秘密の値をクライアントへ渡さないこと。
 *
 * このファイルは純粋関数のみ（I/O なし）。テストは test/spawnEngine.test.ts。
 */
import crypto from 'node:crypto';
import ngeohash from 'ngeohash';
import { SPAWN_CONFIG, type Rarity } from '../../config/spawn';

const { GEOHASH_PRECISION, WINDOW_SECONDS, COUNT_THRESHOLDS, CELL_EDGE_MARGIN } = SPAWN_CONFIG;

// ---- 乱数 -----------------------------------------------------------------

export function hmac(secret: string, key: string): Buffer {
  return crypto.createHmac('sha256', secret).update(key).digest();
}

/** seed の offset から 4バイト読み、[0, 1) の一様乱数にする */
function unit32(seed: Buffer, offset: number): number {
  return seed.readUInt32BE(offset) / 0x1_0000_0000;
}

/**
 * 1つの seed（32バイト）から取り出す乱数のバイト範囲。
 * 座標と抽選で同じ値を使い回さないよう、重ならない範囲に分けている。
 * 天気・暦などで乱数を足すときは 12 以降の空き範囲を使うこと。
 */
const SEED_OFFSET = { LAT: 0, LNG: 4, PICK: 8 } as const;

// ---- 時間枠 ---------------------------------------------------------------

export function hourWindowOf(unixSec: number): number {
  return Math.floor(unixSec / WINDOW_SECONDS);
}

/** 時間枠の終了時刻（unix 秒） */
export function windowEndSec(hourWindow: number): number {
  return (hourWindow + 1) * WINDOW_SECONDS;
}

// ---- 体数・座標 -----------------------------------------------------------

export function spawnCount(secret: string, geohash: string, hourWindow: number): number {
  const r = hmac(secret, `${geohash}:${hourWindow}`).readUInt16BE(0) / 65536;
  return r < COUNT_THRESHOLDS[0] ? 0 : r < COUNT_THRESHOLDS[1] ? 1 : 2;
}

/** マス内の座標。外周 CELL_EDGE_MARGIN を避ける */
export function pointInCell(geohash: string, seed: Buffer): { lat: number; lng: number } {
  const [minLat, minLng, maxLat, maxLng] = ngeohash.decode_bbox(geohash);
  const span = 1 - CELL_EDGE_MARGIN * 2;
  const fy = CELL_EDGE_MARGIN + unit32(seed, SEED_OFFSET.LAT) * span;
  const fx = CELL_EDGE_MARGIN + unit32(seed, SEED_OFFSET.LNG) * span;
  return {
    lat: minLat + (maxLat - minLat) * fy,
    lng: minLng + (maxLng - minLng) * fx,
  };
}

// ---- 抽選 -----------------------------------------------------------------

/** 抽選対象の妖怪（妖怪一覧から作る。DB の形に依存しない） */
export interface SpawnCandidate {
  yokai_id: string;
  rarity: Rarity;
  /** 地域の重み付けに使う都道府県名（例: "福島県"） */
  prefectures: string[];
}

export interface WeightedEntry {
  yokai_id: string;
  weight: number;
}

/** 抽選表を作るときの条件。天気・暦などを足すときはここに項目を増やす */
export interface SpawnContext {
  prefecture: string | null;
  hourWindow: number;
}

/** 重みの補正。基礎重み（レア度）に掛ける倍率を返す。0 を返すとその妖怪は出ない */
export type WeightModifier = (c: SpawnCandidate, ctx: SpawnContext) => number;

export const regionModifier: WeightModifier = (c, ctx) =>
  ctx.prefecture && c.prefectures.includes(ctx.prefecture) ? SPAWN_CONFIG.REGION_MATCH_MULTIPLIER : 1;

export const DEFAULT_MODIFIERS: WeightModifier[] = [regionModifier];

/**
 * 抽選表を作る。候補は yokai_id 順に並べるので、
 * 同じ候補集合なら Lambda のインスタンスが違っても同じ表になる。
 */
export function buildTable(
  candidates: SpawnCandidate[],
  ctx: SpawnContext,
  modifiers: WeightModifier[] = DEFAULT_MODIFIERS,
): WeightedEntry[] {
  const table: WeightedEntry[] = [];
  for (const c of [...candidates].sort((a, b) => (a.yokai_id < b.yokai_id ? -1 : a.yokai_id > b.yokai_id ? 1 : 0))) {
    let w: number = SPAWN_CONFIG.RARITY_WEIGHTS[c.rarity] ?? 0;
    for (const m of modifiers) {
      if (w <= 0) break;
      w *= m(c, ctx);
    }
    if (w > 0) table.push({ yokai_id: c.yokai_id, weight: w });
  }
  return table;
}

export function weightedPick(table: WeightedEntry[], seed: Buffer): string | null {
  if (!table.length) return null;
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = unit32(seed, SEED_OFFSET.PICK) * total;
  for (const e of table) {
    r -= e.weight;
    if (r < 0) return e.yokai_id;
  }
  return table[table.length - 1].yokai_id;
}

// ---- 出現 -----------------------------------------------------------------

export interface ComputedSpawn {
  spawn_id: string;
  geohash: string;
  hourWindow: number;
  slot: number;
  yokai_id: string;
  lat: number;
  lng: number;
  /** 時間枠の終了時刻（unix 秒） */
  expiresAtSec: number;
}

/** 抽選表の引き方。マスの都道府県ごとに表を作ってキャッシュするのは呼び出し側の仕事 */
export type TableFor = (geohash: string, hourWindow: number) => WeightedEntry[];

export function computeSlot(
  secret: string,
  geohash: string,
  hourWindow: number,
  slot: number,
  tableFor: TableFor,
): ComputedSpawn | null {
  const spawnId = `${geohash}:${hourWindow}:${slot}`;
  const seed = hmac(secret, spawnId);
  const yokaiId = weightedPick(tableFor(geohash, hourWindow), seed);
  if (!yokaiId) return null;
  const { lat, lng } = pointInCell(geohash, seed);
  return {
    spawn_id: spawnId, geohash, hourWindow, slot,
    yokai_id: yokaiId, lat, lng,
    expiresAtSec: windowEndSec(hourWindow),
  };
}

export function computeCell(
  secret: string,
  geohash: string,
  hourWindow: number,
  tableFor: TableFor,
): ComputedSpawn[] {
  const out: ComputedSpawn[] = [];
  const count = spawnCount(secret, geohash, hourWindow);
  for (let slot = 0; slot < count; slot++) {
    const s = computeSlot(secret, geohash, hourWindow, slot, tableFor);
    if (s) out.push(s);
  }
  return out;
}

/** 現在地のマスと周囲8マス */
export function cellsAround(lat: number, lng: number): string[] {
  const center = ngeohash.encode(lat, lng, GEOHASH_PRECISION);
  return [center, ...ngeohash.neighbors(center)];
}

// ---- spawn_id -------------------------------------------------------------

const SPAWN_ID_RE = new RegExp(`^([0-9b-hjkmnp-z]{${GEOHASH_PRECISION}}):(\\d{1,10}):(\\d)$`);

export function parseSpawnId(spawnId: unknown): { geohash: string; hourWindow: number; slot: number } | null {
  if (typeof spawnId !== 'string') return null;
  const m = SPAWN_ID_RE.exec(spawnId);
  if (!m) return null;
  return { geohash: m[1], hourWindow: Number(m[2]), slot: Number(m[3]) };
}
