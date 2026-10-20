/**
 * 他プレイヤーの持ち物（山伏の石積み・祈祷師の祈り）を指す不透明な参照。
 *
 * 端末IDは実質的な本人確認なので、一覧 API で他人の端末IDを返してはいけない
 * （返すと、その ID で進捗リセットや削除ができてしまう）。代わりに持ち主の端末IDを
 * AES-256-GCM で暗号化したトークンを返し、いいね・受け取りの API でサーバー側だけが復号する。
 *
 * 鍵は計算配置と同じ SSM の秘密の値から用途別に導出する（値を変えると既存の参照は無効になる）。
 */
import crypto from 'node:crypto';
import { getSpawnSecret } from './spawn/secret';
import { isValidDeviceId } from './deviceId';

const PURPOSE = 'owner-ref-v1';

let keyPromise: Promise<Buffer> | null = null;
function getKey(): Promise<Buffer> {
  keyPromise ??= getSpawnSecret().then((s) => crypto.createHmac('sha256', s).update(PURPOSE).digest());
  return keyPromise;
}

export async function encodeOwnerRef(deviceId: string): Promise<string> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await getKey(), iv);
  const ct = Buffer.concat([cipher.update(deviceId, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** 改ざん・別の鍵・不正な形式なら null */
export async function decodeOwnerRef(ref: unknown): Promise<string | null> {
  if (typeof ref !== 'string' || ref.length > 200) return null;
  try {
    const buf = Buffer.from(ref, 'base64url');
    if (buf.length < 12 + 16 + 1) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', await getKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const id = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return isValidDeviceId(id) ? id : null;
  } catch {
    return null;
  }
}
