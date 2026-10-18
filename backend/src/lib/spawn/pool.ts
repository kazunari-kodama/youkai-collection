/**
 * 計算配置の抽選対象と、/spawns で一緒に返す固定配置を DynamoDB から読み、
 * Lambda のインスタンス内で POOL_CACHE_MS の間キャッシュする。
 *
 * 抽選対象の条件:
 *   - youkai_core で game_visible = true
 *   - kodama_db にも存在する（ゲームの表示・詳細・図鑑は kodama_db を元にしているため。
 *     kodama_db に無い妖怪を出すと、詳細取得が 404 になり図鑑にも並ばない）
 *   - rally_key / require_qr / night_only を持たない（イベント・QR・夜限定は固定配置専用）
 *   - rarity の重みが 0 でない（現在は common のみ）
 *   - 妖力（youryoku）が MAX_YOURYOKU 以下（現在は迷霊のみ。1回で捕まえられる雑魚妖怪）
 */
import { SPAWN_CONFIG, type Rarity } from '../../config/spawn';
import { scanAll, YOUKAI_TABLE, CORE_TABLE } from '../dynamodb';
import type { YokaiDBItem } from '../../types/youkai';
import { buildTable, type SpawnCandidate, type TableFor, type WeightedEntry } from './engine';
import { prefectureOfGeohash, prefecturesOf } from './region';

const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'legendary'];

interface CoreItem {
  yokai_id: string;
  rarity?: string;
  regions?: string[];
  rally_key?: string;
  require_qr?: boolean;
  night_only?: boolean;
}

export interface SpawnPool {
  candidates: SpawnCandidate[];
  /** 固定配置（GET /youkai と同じ集合: rally_key を持たないもの） */
  fixed: YokaiDBItem[];
  tableFor: TableFor;
}

let cached: { pool: SpawnPool; loadedAt: number } | null = null;
let inflight: Promise<SpawnPool> | null = null;

export function toRarity(...values: unknown[]): Rarity {
  for (const v of values) if (typeof v === 'string' && (RARITIES as readonly string[]).includes(v)) return v as Rarity;
  return SPAWN_CONFIG.DEFAULT_RARITY;
}

/** DB の行から抽選対象を作る（I/O なし。テスト用に分けている） */
export function buildCandidates(coreItems: CoreItem[], kodamaItems: YokaiDBItem[]): SpawnCandidate[] {
  const kodama = new Map(kodamaItems.map((k) => [k.yokai_id, k]));
  const out: SpawnCandidate[] = [];
  for (const c of coreItems) {
    const k = kodama.get(c.yokai_id);
    if (!k) continue;
    if (c.rally_key || k.rally_key || c.require_qr || k.require_qr || c.night_only || k.night_only) continue;
    const rarity = toRarity(c.rarity, k.rarity);
    if ((SPAWN_CONFIG.RARITY_WEIGHTS[rarity] ?? 0) <= 0) continue;
    if ((k.youryoku ?? 1) > SPAWN_CONFIG.MAX_YOURYOKU) continue;
    out.push({
      yokai_id: c.yokai_id,
      rarity,
      prefectures: prefecturesOf(k.prefecture, [...(k.regions ?? []), ...(c.regions ?? [])]),
    });
  }
  return out;
}

/** 都道府県ごとに抽選表を作ってキャッシュする TableFor を返す */
export function makeTableFor(candidates: SpawnCandidate[]): TableFor {
  const tables = new Map<string, WeightedEntry[]>();
  return (geohash, hourWindow) => {
    const prefecture = prefectureOfGeohash(geohash);
    // 現状の補正は都道府県だけに依存する。時間帯・天気で変わる補正を足したらキーにも含めること
    const key = prefecture ?? '';
    let t = tables.get(key);
    if (!t) {
      t = buildTable(candidates, { prefecture, hourWindow });
      tables.set(key, t);
    }
    return t;
  };
}

async function load(): Promise<SpawnPool> {
  const [coreItems, kodamaItems] = await Promise.all([
    scanAll<CoreItem>({
      TableName: CORE_TABLE,
      FilterExpression: 'game_visible = :s OR game_visible = :b',
      ProjectionExpression: 'yokai_id, rarity, regions, rally_key, require_qr, night_only',
      ExpressionAttributeValues: { ':s': 'true', ':b': true },
    }),
    scanAll<YokaiDBItem>({
      TableName: YOUKAI_TABLE,
      ProjectionExpression: 'yokai_id, #n, latitude, longitude, images, night_only, require_qr, rally_key, prefecture, regions, rarity, youryoku',
      ExpressionAttributeNames: { '#n': 'name' },
    }),
  ]);
  const candidates = buildCandidates(coreItems, kodamaItems);
  if (!candidates.length) console.warn('[spawnPool] 抽選対象が0件です');
  return {
    candidates,
    fixed: kodamaItems.filter((k) => !k.rally_key),
    tableFor: makeTableFor(candidates),
  };
}

export async function getSpawnPool(nowMs = Date.now()): Promise<SpawnPool> {
  if (cached && nowMs - cached.loadedAt < SPAWN_CONFIG.POOL_CACHE_MS) return cached.pool;
  if (!inflight) {
    inflight = load()
      .then((pool) => { cached = { pool, loadedAt: Date.now() }; return pool; })
      .finally(() => { inflight = null; });
  }
  try {
    return await inflight;
  } catch (e) {
    // 再読込に失敗しても、古い一覧があればそれで出現を続ける
    if (cached) { console.error('[spawnPool] reload failed, using stale pool', e); return cached.pool; }
    throw e;
  }
}

