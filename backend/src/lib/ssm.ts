import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

// コールドスタート中のみ有効なモジュールスコープのキャッシュ。
// 暖まった Lambda は SSM 呼び出しをスキップする（値変更の反映は次のコールドスタートまで）。
const cache = new Map<string, string>();

/**
 * SSM パラメータの値を取得する。SecureString は decrypt:true で復号。
 * 取得済みの値はプロセス寿命の間キャッシュされる。
 */
export async function getParam(name: string, decrypt = false): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const res = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: decrypt }),
  );
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} has no value`);

  cache.set(name, value);
  return value;
}
