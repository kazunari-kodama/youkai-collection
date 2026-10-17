import { getParam } from '../ssm';
import { SPAWN_CONFIG } from '../../config/spawn';

/**
 * 出現計算の秘密の値（SSM SecureString /youkai/spawn-secret）。
 * getParam がプロセス寿命の間キャッシュするので、取得はコールドスタート時の1回だけ。
 * 値をログ・レスポンスに出さないこと。
 */
export async function getSpawnSecret(): Promise<string> {
  const v = await getParam(SPAWN_CONFIG.SECRET_PARAM, true);
  if (v.length < 32) throw new Error('spawn secret is too short');
  return v;
}
