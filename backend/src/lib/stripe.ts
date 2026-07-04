import Stripe from 'stripe';
import { getParam } from './ssm';

const SECRET_KEY_PARAM = process.env.STRIPE_SECRET_PARAM!;

let stripeSingleton: Stripe | null = null;

/**
 * SSM の秘密鍵で Stripe クライアントを遅延生成しキャッシュする。
 * apiVersion は指定せず Stripe アカウント既定のバージョンを使う（将来ピン留め可）。
 */
export async function getStripe(): Promise<Stripe> {
  if (stripeSingleton) return stripeSingleton;
  const secretKey = await getParam(SECRET_KEY_PARAM, true);
  stripeSingleton = new Stripe(secretKey);
  return stripeSingleton;
}
