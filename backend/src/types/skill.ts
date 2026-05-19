export type JobId = 'onmyoji' | 'jujutsushi';

export type SkillId =
  | 'dokaishu'      // 陰陽師: 読解術
  | 'shikigami'     // 陰陽師: 式神術
  | 'kekkai'        // 陰陽師: 結界術
  | 'kotodama'      // 呪術師: 言霊術
  | 'monyou'        // 呪術師: 紋様術
  | 'utsushidori';  // 呪術師: 写し取り

export const JOB_SKILLS: Record<JobId, SkillId[]> = {
  onmyoji:    ['dokaishu', 'shikigami', 'kekkai'],
  jujutsushi: ['kotodama', 'monyou',   'utsushidori'],
};

export const SKILL_META: Record<SkillId, { name: string; desc: string; rangeM?: number }> = {
  dokaishu:    { name: '読解術',   desc: '未封印の妖の正体・属性を読み解く（50m圏内）', rangeM: 50 },
  shikigami:   { name: '式神術',   desc: '封印した妖怪を式神化し、使役する' },
  kekkai:      { name: '結界術',   desc: '3体以上の封印位置で結界を形成する' },
  kotodama:    { name: '言霊術',   desc: '契約した妖怪の真名を解き明かす' },
  monyou:      { name: '紋様術',   desc: '現在地に紋様を刻む（24時間有効、1日1回）' },
  utsushidori: { name: '写し取り', desc: '契約した妖怪の力を己の内に写し取る' },
};

export const RANK_SHIKIGAMI_SLOTS: Record<string, number> = {
  C: 1, B: 2, A: 3, S: 4, SS: 5,
};

export const MAX_COPIED_POWERS = 3;
export const MONYOU_DAILY_LIMIT = 1;
export const MONYOU_MAX_ACTIVE  = 5;
export const MONYOU_TTL_HOURS   = 24;

/** PatternsTable の1レコード */
export interface PatternDBItem {
  pattern_id: string;
  deviceId:   string;
  lat:        number;
  lon:        number;
  created_at: string;
  expires_at: string;
}
