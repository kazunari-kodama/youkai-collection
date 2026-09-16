import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { ScanCommandInput } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client);

/**
 * LastEvaluatedKey が尽きるまで Scan を繰り返して全件返す。
 *
 * Scan は1回あたり 1MB までしか読まず、FilterExpression はその 1MB を読んだ「後」に
 * 適用される。ページングしないと、テーブルが育った時点で結果がエラーも出さずに
 * 欠け始める（kodama_db は1件約1.3KBなので約800件が単一ページの限界）。
 *
 * maxPages は暴走時の保険。打ち切った場合は警告を出したうえで取得済み分を返す。
 */
export async function scanAll<T>(input: ScanCommandInput, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  let pages = 0;

  do {
    const res = await ddb.send(
      new ScanCommand({ ...input, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) }),
    );
    out.push(...((res.Items ?? []) as T[]));
    lastKey = res.LastEvaluatedKey;
    pages += 1;
  } while (lastKey && pages < maxPages);

  if (lastKey) {
    console.warn(`[scanAll] ${input.TableName}: maxPages(${maxPages}) に達したため打ち切り。${out.length}件を返します`);
  }
  return out;
}

export const YOUKAI_TABLE = process.env.YOUKAI_TABLE!;
export const CAPTURES_TABLE = process.env.CAPTURES_TABLE!;
export const IMAGES_BASE_URL = process.env.IMAGES_BASE_URL!;
export const RESEARCH_TABLE = process.env.RESEARCH_TABLE!;
export const CORE_TABLE = process.env.CORE_TABLE!;
export const PLAYER_PROFILE_TABLE = process.env.PLAYER_PROFILE_TABLE!;
export const ARAGAMI_TABLE           = process.env.ARAGAMI_TABLE!;
export const FLYING_SHIKIGAMI_TABLE  = process.env.FLYING_SHIKIGAMI_TABLE!;
export const KEKKAI_STONES_TABLE     = process.env.KEKKAI_STONES_TABLE!;
export const KEKKAI_BARRIERS_TABLE    = process.env.KEKKAI_BARRIERS_TABLE!;
export const YAMABUSHI_STONES_TABLE   = process.env.YAMABUSHI_STONES_TABLE!;
export const KITOSHI_PRAYERS_TABLE    = process.env.KITOSHI_PRAYERS_TABLE!;
export const NOROI_CURSES_TABLE       = process.env.NOROI_CURSES_TABLE!;
export const SHOUJUTSU_TABLE          = process.env.SHOUJUTSU_TABLE!;

/** images[0] → camera の S3 キー
 *  "youkai/xxx_camera.png"  → "youkai/xxx_camera.png"  (direct key, new format)
 *  "images/yamaonna.png"    → "youkai/yamaonna_camera.png"  (legacy format)
 */
function toCameraKey(images: string[] | undefined): string {
  if (!images?.length) return '';
  const first = images[0];
  if (first.startsWith('youkai/')) return first;
  const baseName = first.split('/').pop()?.replace('.png', '') ?? '';
  if (!baseName) return '';
  return `youkai/${baseName}_camera.png`;
}

/** images[0] → camera URL（フル解像度。詳細画面・撮影演出用） */
export function toCameraUrl(images: string[] | undefined, base: string): string {
  const key = toCameraKey(images);
  return key ? `${base}/${key}` : '';
}

/** images[0] → マーカー用サムネ URL（長辺144px webp、平均5KB）
 *  キーの規則は scripts/generate-thumbs.mjs の toThumbKey と一致させること。
 *  "youkai/xxx_camera.png" → "{base}/thumbs/xxx_camera.webp"
 */
export function toThumbUrl(images: string[] | undefined, base: string): string {
  const key = toCameraKey(images);
  if (!key) return '';
  return `${base}/thumbs/${key.slice('youkai/'.length).replace(/\.[^.]+$/, '')}.webp`;
}
