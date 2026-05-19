import type { APIGatewayProxyHandler } from 'aws-lambda';
import { JUTSU_COST } from '../types/skill';
import { deductJutsu } from '../lib/jutsuriyoku';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import type { YokaiDBItem } from '../types/youkai';

const EXP_GAIN = 15;
const LORE_PREVIEW_LEN = 80;

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

  // ジョブ確認
  const profileResult = await ddb.send(new GetCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));
  if (profileResult.Item?.job !== 'jujutsushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Job mismatch: jujutsushi required' }) };
  }
  // 術力チェック
  const jutsuResult = await deductJutsu(deviceId, JUTSU_COST.skill_kotodama);
  if (!jutsuResult.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsuResult.current, required: JUTSU_COST.skill_kotodama, max: jutsuResult.max,
    })};
  }


  // bond済み確認
  const captureResult = await ddb.send(new GetCommand({ TableName: CAPTURES_TABLE, Key: { deviceId, youkaiId } }));
  const capture = captureResult.Item;
  if (!capture || capture.actionType !== 'bond') {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Not bonded by you' }) };
  }
  if (capture.true_name_learned) {
    // 既習得 → idempotent で返す
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        already_learned: true,
        kana: capture.true_name_kana ?? '',
        lore: capture.true_name_lore ?? '',
      }),
    };
  }

  // 妖怪データ取得
  const yokaiResult = await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE,
    Key: { yokai_id: youkaiId },
    ProjectionExpression: 'kana, notes',
  }));
  if (!yokaiResult.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Youkai not found' }) };
  }
  const youkai = yokaiResult.Item as Pick<YokaiDBItem, 'kana' | 'notes'>;
  const kana = youkai.kana ?? '';
  const lore = (youkai.notes ?? '').slice(0, LORE_PREVIEW_LEN);

  // 真名習得を記録
  await ddb.send(new UpdateCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId },
    UpdateExpression: 'SET true_name_learned = :t, true_name_kana = :k, true_name_lore = :l, kotodama_at = :now',
    ExpressionAttributeValues: { ':t': true, ':k': kana, ':l': lore, ':now': new Date().toISOString() },
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
    body: JSON.stringify({ kana, lore, exp_gained: EXP_GAIN }),
  };
};
