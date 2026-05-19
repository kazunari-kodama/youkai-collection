import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { RANK_SHIKIGAMI_SLOTS } from '../types/skill';

const EXP_GAIN = 10;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; youkaiId?: string };
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deviceId, youkaiId } = body;
  if (!deviceId || !youkaiId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // ジョブ・ランク確認
  const profileResult = await ddb.send(new GetCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));
  const profile = profileResult.Item;
  if (!profile || profile.job !== 'onmyoji') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Job mismatch: onmyoji required' }) };
  }

  const rank = (profile.rank as string) ?? 'C';
  const maxSlots = RANK_SHIKIGAMI_SLOTS[rank] ?? 1;

  // 捕獲レコード確認（sealのみ）
  const captureResult = await ddb.send(new GetCommand({ TableName: CAPTURES_TABLE, Key: { deviceId, youkaiId } }));
  const capture = captureResult.Item;
  if (!capture || capture.actionType !== 'seal') {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Not sealed by you' }) };
  }
  if (capture.is_shikigami) {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Already shikigami' }) };
  }

  // 現在の式神数を数える（自分のsealsをクエリ）
  const allCaptures = await ddb.send(new QueryCommand({
    TableName: CAPTURES_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: 'actionType = :a AND is_shikigami = :t',
    ExpressionAttributeValues: { ':d': deviceId, ':a': 'seal', ':t': true },
    ProjectionExpression: 'youkaiId',
  }));
  const currentShikigami = allCaptures.Items ?? [];

  if (currentShikigami.length >= maxSlots) {
    return {
      statusCode: 409,
      headers: HEADERS,
      body: JSON.stringify({
        error: 'Shikigami slots full',
        current: currentShikigami.length,
        max: maxSlots,
        shikigami_ids: currentShikigami.map((i) => i.youkaiId),
      }),
    };
  }

  // 式神化
  await ddb.send(new UpdateCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId },
    UpdateExpression: 'SET is_shikigami = :t, shikigami_at = :now',
    ExpressionAttributeValues: { ':t': true, ':now': new Date().toISOString() },
  }));

  // EXP加算
  ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'ADD exp :gain SET updated_at = :now',
    ExpressionAttributeValues: { ':gain': EXP_GAIN, ':now': new Date().toISOString() },
  })).catch((e) => console.error('exp update failed', e));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true,
      shikigami_count: currentShikigami.length + 1,
      max_slots: maxSlots,
      shikigami_ids: [...currentShikigami.map((i) => i.youkaiId as string), youkaiId],
      exp_gained: EXP_GAIN,
    }),
  };
};
