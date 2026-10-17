/**
 * 計算配置（computed spawns）の調整値。
 *
 * 出現の「数」と「座標」は秘密の値とマス・時間枠だけで決まる。
 * ここの値のうち GEOHASH_PRECISION / WINDOW_SECONDS / COUNT_THRESHOLDS / CELL_EDGE_MARGIN を
 * 変えると全国の出現が入れ替わる（秘密の値を変えたときと同じ）。
 * 重みや倍率は抽選される妖怪だけが変わる。
 */

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export const SPAWN_CONFIG = {
  /** マスの粒度。7桁 ≒ 150m 四方 */
  GEOHASH_PRECISION: 7,
  /** 時間枠の長さ（秒） */
  WINDOW_SECONDS: 3600,
  /** 時間枠の終了後、捕獲を受け付ける猶予（秒） */
  CAPTURE_GRACE_SECONDS: 120,

  /** 1マスの体数: r < [0] → 0体, r < [1] → 1体, それ以外 → 2体（0体25% / 1体50% / 2体25%） */
  COUNT_THRESHOLDS: [0.25, 0.75] as const,
  /** マス外周のうち出現させない幅（マス一辺に対する割合） */
  CELL_EDGE_MARGIN: 0.1,

  /** レア度ごとの抽選の重み。0 は計算配置に出さない */
  RARITY_WEIGHTS: {
    common: 60,
    uncommon: 28,
    rare: 12,
    legendary: 0,
  } satisfies Record<Rarity, number>,
  /** rarity 項目が無い妖怪の扱い */
  DEFAULT_RARITY: 'common' as Rarity,
  /** マスの都道府県が妖怪の地域情報に含まれるときの重み倍率 */
  REGION_MATCH_MULTIPLIER: 5,

  /** 妖怪一覧のキャッシュ時間（ミリ秒） */
  POOL_CACHE_MS: 10 * 60 * 1000,

  /** 捕獲時に許す位置精度（m）。これを超えると LOW_ACCURACY */
  MAX_ACCURACY_M: 50,
  /** 前回位置からの移動速度の上限（km/h）。超えると SPEED_ANOMALY */
  MAX_SPEED_KMH: 250,
  /** 速度判定で差し引く GPS の揺らぎ（m）。静止中の飛びで誤判定しないため */
  SPEED_GPS_TOLERANCE_M: 100,

  /** 捕獲記録（ユーザー × spawn_id）の保持期間（秒）。二重取り防止には時間枠+猶予あれば足りる */
  CAPTURE_RECORD_TTL_SECONDS: 7 * 24 * 3600,

  /** SSM Parameter Store の秘密の値 */
  SECRET_PARAM: '/youkai/spawn-secret',
} as const;
