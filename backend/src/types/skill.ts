export type JobId = 'onmyoji' | 'jujutsushi';

export type SkillId =
  | 'dokaishu'        // 陰陽師: 読解術
  | 'shikigami'       // 陰陽師: 式神術
  | 'kekkai'          // 陰陽師: 結界術
  | 'hisho_shikigami' // 陰陽師: 飛翔式神
  | 'kotodama'        // 呪術師: 言霊術
  | 'monyou'          // 呪術師: 紋様術
  | 'utsushidori';    // 呪術師: 写し取り

export const JOB_SKILLS: Record<JobId, SkillId[]> = {
  onmyoji:    ['dokaishu', 'shikigami', 'kekkai', 'hisho_shikigami'],
  jujutsushi: ['kotodama', 'monyou',   'utsushidori'],
};

export const SKILL_META: Record<SkillId, { name: string; desc: string; rangeM?: number }> = {
  dokaishu:        { name: '読解術',   desc: '未封印の妖の正体・属性を読み解く（50m圏内）', rangeM: 50 },
  shikigami:       { name: '式神術',   desc: '封印した妖怪を式神化し、使役する' },
  kekkai:          { name: '結界術',   desc: '3体以上の封印位置で結界を形成する' },
  hisho_shikigami: { name: '飛翔式神', desc: '術力を消費して式神を遠隔地へ飛ばし、妖怪を封じる' },
  kotodama:        { name: '言霊術',   desc: '契約した妖怪の真名を解き明かす' },
  monyou:          { name: '紋様術',   desc: '現在地に紋様を刻む（24時間有効、1日1回）' },
  utsushidori:     { name: '写し取り', desc: '契約した妖怪の力を己の内に写し取る' },
};

export const RANK_SHIKIGAMI_SLOTS: Record<string, number> = {
  C: 1, B: 2, A: 3, S: 4, SS: 5,
};

export const MAX_COPIED_POWERS = 3;
export const MONYOU_DAILY_LIMIT = 1;
export const MONYOU_MAX_ACTIVE  = 5;
export const MONYOU_TTL_HOURS   = 24;

// ---- 妖力ランク定義 ----
export const YOURYOKU_RANKS: Record<number, { name: string; trials: number; exp: number }> = {
  1: { name: '迷霊', trials: 1, exp: 10 },
  2: { name: '物怪', trials: 2, exp: 20 },
  3: { name: '精霊', trials: 3, exp: 35 },
  4: { name: '御魂', trials: 5, exp: 55 },
  5: { name: '権現', trials: 8, exp: 80 },
};

export const YOURYOKU_DISTRIBUTION = [
  { rank: 1, weight: 40 },
  { rank: 2, weight: 30 },
  { rank: 3, weight: 20 },
  { rank: 4, weight:  8 },
  { rank: 5, weight:  2 },
];

// ---- 術力定数 ----
export const JUTSU_BASE_MAX         = 100;
export const JUTSU_PER_RANK         = 20;   // ランクCより上、1段ごとに+20
export const JUTSU_RECOVERY_PER_MIN = 1;    // 1点/分
export const JUTSU_RECOVERY_PER_50M = 1;    // 1点/50m

export const JUTSU_COST = {
  bond:                    10,
  skill_dokaishu:          10,
  skill_shikigami:         20,
  skill_hisho_shikigami:   15,
  skill_kotodama:          15,
  skill_monyou:            25,
  skill_utsushidori:       20,
} as const;

export const RANK_JUTSU_MAX: Record<string, number> = {
  C: 100, B: 120, A: 140, S: 160, SS: 200,
};

// ---- 飛翔式神定数 ----
/** 1km あたりの飛行時間（分）。1km = 10min */
export const FLYING_SHIKIGAMI_SPEED_MIN_PER_KM = 10;

/** 真名を知っている妖怪への封印成功率 */
export const HISHO_SUCCESS_RATE_KNOWN   = 0.9;
/** 真名を知らない妖怪への封印成功率 */
export const HISHO_SUCCESS_RATE_UNKNOWN = 0.4;

export type FlyingShikigamiStatus = 'flying' | 'sealed' | 'failed';

/** FlyingShikigamiTable の1レコード */
export interface FlyingShikigamiDBItem {
  deviceId:         string;
  shikigami_id:     string;
  launch_lat:       number;
  launch_lon:       number;
  target_lat:       number;
  target_lon:       number;
  target_youkai_id: string;
  launched_at:      string;
  arrives_at:       string;
  status:           FlyingShikigamiStatus;
  result_at?:       string;
  ttl:              number;
}

/** PatternsTable の1レコード */
export interface PatternDBItem {
  pattern_id: string;
  deviceId:   string;
  lat:        number;
  lon:        number;
  created_at: string;
  expires_at: string;
}
