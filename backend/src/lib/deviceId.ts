/**
 * 端末ID（クライアントが crypto.randomUUID() で作り Cookie に保存する ID）の形式チェック。
 * この ID が実質的な本人確認なので、想定外の文字列（HTML や長大な値）を DB に入れない。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidDeviceId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
