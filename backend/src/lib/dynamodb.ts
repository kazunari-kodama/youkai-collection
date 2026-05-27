import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client);

export const YOUKAI_TABLE = process.env.YOUKAI_TABLE!;
export const CAPTURES_TABLE = process.env.CAPTURES_TABLE!;
export const IMAGES_BASE_URL = process.env.IMAGES_BASE_URL!;
export const RESEARCH_TABLE = process.env.RESEARCH_TABLE!;
export const CORE_TABLE = process.env.CORE_TABLE!;
export const PLAYER_PROFILE_TABLE = process.env.PLAYER_PROFILE_TABLE!;
export const PATTERNS_TABLE          = process.env.PATTERNS_TABLE!;
export const FLYING_SHIKIGAMI_TABLE  = process.env.FLYING_SHIKIGAMI_TABLE!;

/** images[0] → camera URL
 *  "youkai/xxx_camera.png"  → "{base}/youkai/xxx_camera.png"  (direct key, new format)
 *  "images/yamaonna.png"    → "{base}/youkai/yamaonna_camera.png"  (legacy format)
 */
export function toCameraUrl(images: string[] | undefined, base: string): string {
  if (!images?.length) return '';
  const first = images[0];
  if (first.startsWith('youkai/')) return `${base}/${first}`;
  const baseName = first.split('/').pop()?.replace('.png', '') ?? '';
  if (!baseName) return '';
  return `${base}/youkai/${baseName}_camera.png`;
}
