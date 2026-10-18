/**
 * 地域対応表（geohash 4桁 → 都道府県名）の参照。
 * region-map.json は scripts/build-region-map で生成する（出典・ライセンスは同 README）。
 * 海上などで該当なしのマスは表に含めていない。
 */
import regionMap from '../../data/region-map.json';

const MAP = regionMap as Record<string, string>;

export function prefectureOfGeohash(geohash: string): string | null {
  return MAP[geohash.slice(0, 4)] ?? null;
}

export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const;

/**
 * 妖怪の地域情報から都道府県名を拾う。
 * prefecture（kodama_db の文字列項目）と、regions（自由記述の配列）に
 * 都道府県名がそのまま含まれているものだけを採用する。
 * 「京都」のような略称は「東京都」に誤一致するので拾わない。
 */
export function prefecturesOf(prefecture: unknown, regions: unknown): string[] {
  const texts: string[] = [];
  if (typeof prefecture === 'string') texts.push(prefecture);
  if (Array.isArray(regions)) for (const r of regions) if (typeof r === 'string') texts.push(r);
  const found = new Set<string>();
  for (const t of texts) for (const p of PREFECTURES) if (t.includes(p)) found.add(p);
  return [...found];
}
