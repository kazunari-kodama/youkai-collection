export type JobId = 'onmyoji' | 'jujutsushi' | 'miko' | 'yamabushi' | 'kitoshi' | 'yojutsushi';

export type SkillId =
  | 'dokaishu'        // 陰陽師: 読解術
  | 'shikigami'       // 陰陽師: 式神術
  | 'kekkai'          // 陰陽師: 結界術
  | 'hisho_shikigami' // 陰陽師: 飛翔式神
  | 'kotodama'        // 呪術師: 言霊術
  | 'tamafuri'        // 呪術師: 魂振
  | 'utsushidori'     // 呪術師: 写し取り
  | 'chinkon'         // 神子: 鎮魂術
  | 'omikuji'         // 神子: おみくじ
  | 'yamabushi_traversal' // 山伏: 踏破視覚化
  | 'yamabushi_stone'     // 山伏: 石積み
  | 'inori'               // 祈祷師: 祈り
  | 'takusen'             // 祈祷師: 託宣
  | 'noroi';              // 妖術師: 呪術

export const JOB_SKILLS: Partial<Record<JobId, SkillId[]>> = {
  onmyoji:    ['dokaishu', 'shikigami', 'kekkai', 'hisho_shikigami'],
  jujutsushi: ['kotodama', 'tamafuri', 'utsushidori'],
  miko:       ['chinkon', 'omikuji'],
  yamabushi:  ['yamabushi_traversal', 'yamabushi_stone'],
  kitoshi:    ['inori', 'takusen'],
  yojutsushi: ['noroi'],
};

export const SKILL_META: Record<SkillId, { name: string; desc: string; rangeM?: number }> = {
  dokaishu:           { name: '読解術',     desc: '未封印の妖の正体・属性を読み解く（50m圏内）', rangeM: 50 },
  shikigami:          { name: '式神術',     desc: '封印した妖怪を式神化し、使役する' },
  kekkai:             { name: '結界術',     desc: '3体以上の封印位置で結界を形成する' },
  hisho_shikigami:    { name: '飛翔式神',   desc: '術力を消費して式神を遠隔地へ飛ばし、妖怪を封じる' },
  kotodama:           { name: '言霊術',     desc: '契約した妖怪の真名を解き明かす' },
  tamafuri:           { name: '魂振',       desc: '解除した妖怪を荒魂化し、周囲の封印を乱す' },
  utsushidori:        { name: '写し取り',   desc: '契約した妖怪の力を己の内に写し取る' },
  chinkon:            { name: '鎮魂術',     desc: '荒魂化した妖怪を鎮め和魂へと変容させる', rangeM: 13 },
  omikuji:            { name: 'おみくじ',   desc: '神意を問い、術力や妖怪の状態に影響を与える' },
  yamabushi_traversal:{ name: '踏破視覚化', desc: '各地域の妖怪踏破率を確認し封印ボーナスを更新する' },
  yamabushi_stone:    { name: '石積み',     desc: '術力を消費して現在地に石を積む。踏破の目印となる', rangeM: 0 },
  inori:              { name: '祈祷',       desc: '術力を消費して現在地に祈りを捧げる。半径40m内を通った者に2時間の祈祷効果が宿る', rangeM: 40 },
  takusen:            { name: '託宣',       desc: '術力を消費して神意を問う。半径10km内の未封印妖怪1体がランダムに選ばれ、試行回数-2の加護が24時間宿る', rangeM: 10000 },
  noroi:              { name: '呪術',       desc: '術力を消費して解除済み妖怪に呪いを施す。封印した払い手ユーザーはスキル使用時に術力が全消費される（24時間）。祈祷・結界エリアで解呪' },
};

export const RANK_SHIKIGAMI_SLOTS: Record<string, number> = {
  C: 1, B: 2, A: 3, S: 4, SS: 5,
};

export const MAX_COPIED_POWERS = 3;

export const ARAGAMI_TTL_HOURS = 72;

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
  skill_kekkai_stone:      10,
  skill_kotodama:          15,
  skill_tamafuri:          20,
  skill_chinkon:           15,
  skill_utsushidori:       20,
  skill_yamabushi_stone:    5,
  skill_kitoshi_prayer:    10,
  skill_kitoshi_takusen:   20,
  skill_yojutsushi_noroi:  15,
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

// ---- 結界術定数 ----
export const KEKKAI_MIN_AREA_M2 = 1_000;

export const RANK_KEKKAI_MAX_AREA_M2: Record<string, number> = {
  C:  50_000,
  B:  200_000,
  A:  1_000_000,
  S:  5_000_000,
  SS: 20_000_000,
};

export const RANK_KEKKAI_STONE_LIMIT: Record<string, number> = {
  C: 3, B: 5, A: 7, S: 9, SS: 12,
};

export interface KekkaiStoneDBItem {
  deviceId:  string;
  stone_id:  string;
  lat:       number;
  lon:       number;
  placed_at: string;
}

export interface KekkaiBarrierDBItem {
  deviceId:   string;
  barrier_id: string;
  lats:       number[];
  lons:       number[];
  center_lat: number;
  center_lon: number;
  area_m2:    number;
  formed_at:  string;
  expires_at: string;
  ttl:        number;
}

/** AragamiTable の1レコード */
export interface AragamiDBItem {
  youkaiId:      string;
  activated_by:  string;
  activated_at:  string;
  youryoku:      number;
  expires_at:    string;
  ttl:           number;
}

// ---- 祈祷師定数 ----
export const PRAYER_RADIUS_M       = 40;
export const NOROI_DURATION_DAYS   = 7;
export const NOROI_EFFECT_HOURS    = 24;
export const PRAYER_DURATION_HOURS = 48;
export const PRAYER_EFFECT_HOURS   = 2;

export const RANK_KITOSHI_PRAYER_LIMIT: Record<string, number> = {
  C: 3, B: 4, A: 5, S: 6, SS: 8,
};

/** youryoku (1–5) をプレイヤーランクの序列値に変換 */
export const YOURYOKU_RANK_ORDER = [0, 0, 1, 2, 3, 4] as const;

/** プレイヤーランクの序列値 */
export const RANK_ORDER: Record<string, number> = { C: 0, B: 1, A: 2, S: 3, SS: 4 };

/** プレイヤーランクが荒魂の妖力より厳密に高いか判定（結界術の無効化免除用） */
export function rankBeatsYouryoku(rank: string, youryoku: number): boolean {
  return (RANK_ORDER[rank] ?? 0) > (YOURYOKU_RANK_ORDER[youryoku] ?? 0);
}

/** プレイヤーランクが妖力と同等以上か判定（鎮魂術の発動条件） */
export function rankMeetsYouryoku(rank: string, youryoku: number): boolean {
  return (RANK_ORDER[rank] ?? 0) >= (YOURYOKU_RANK_ORDER[youryoku] ?? 0);
}
