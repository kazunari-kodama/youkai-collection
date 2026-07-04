import type { APIGatewayProxyHandler } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { getStripe } from '../lib/stripe';
import { getParam } from '../lib/ssm';

const cognito = new CognitoIdentityProviderClient({});

const WEBHOOK_SECRET_PARAM = process.env.STRIPE_WEBHOOK_SECRET_PARAM!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const PREMIUM_GROUP = 'premium';

/**
 * POST /billing/webhook  (公開 — Stripe 署名で検証)
 * checkout.session.completed を受け取り、該当ユーザーを Cognito premium グループへ追加。
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const sig =
    event.headers['Stripe-Signature'] ?? event.headers['stripe-signature'];
  if (!sig || !event.body) {
    return { statusCode: 400, body: 'missing signature or body' };
  }

  // 署名検証には生ボディが必須。API Gateway が base64 化していれば復号する。
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  const stripe = await getStripe();
  const webhookSecret = await getParam(WEBHOOK_SECRET_PARAM, true);

  let stripeEvent;
  try {
    stripeEvent = await stripe.webhooks.constructEventAsync(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('stripe signature verification failed:', (err as Error).message);
    return { statusCode: 400, body: 'invalid signature' };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const username =
      session.client_reference_id ?? session.metadata?.cognito_username;

    if (!username) {
      console.error('checkout.session.completed without username', session.id);
      return { statusCode: 200, body: 'ignored (no username)' };
    }

    // AdminAddUserToGroup は所属済みでも no-op なので再送に対して冪等。
    // 一時的な AWS エラーはあえて throw し 5xx を返して Stripe に再送させる。
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: PREMIUM_GROUP,
      }),
    );
    console.log(`granted premium to ${username} (session ${session.id})`);
  }

  return { statusCode: 200, body: 'ok' };
};
