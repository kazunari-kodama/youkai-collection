import type { APIGatewayProxyHandler } from 'aws-lambda';
import { getStripe } from '../lib/stripe';
import { getParam } from '../lib/ssm';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const PRICE_ID_PARAM = process.env.STRIPE_PRICE_PARAM!;
const SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL!;
const CANCEL_URL = process.env.CHECKOUT_CANCEL_URL!;

/**
 * POST /billing/checkout  (Cognito 認証必須)
 * ログインユーザーの Cognito Username を client_reference_id/metadata に載せ、
 * ¥1500 買い切りの Stripe Checkout Session を発行して URL を返す。
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const claims = event.requestContext.authorizer?.claims;
  if (!claims) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // UsernameAttributes=email のため cognito:username は sub とは別の UUID。
  // AdminAddUserToGroup はこの Username を必要とするので webhook まで受け渡す。
  const username = claims['cognito:username'] as string | undefined;
  const email = claims['email'] as string | undefined;
  const sub = claims['sub'] as string | undefined;

  if (!username) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No username claim' }) };
  }

  // すでにプレミアムなら決済不要
  if (String(claims['cognito:groups'] ?? '').includes('premium')) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ alreadyPremium: true }) };
  }

  try {
    const stripe = await getStripe();
    const priceId = await getParam(PRICE_ID_PARAM, false);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: username,
      metadata: { cognito_username: username, sub: sub ?? '', email: email ?? '' },
      ...(email ? { customer_email: email } : {}),
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    // 秘密鍵やセッション内容はログに出さない
    console.error('checkout session creation failed:', (err as Error).message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Checkout failed' }) };
  }
};
