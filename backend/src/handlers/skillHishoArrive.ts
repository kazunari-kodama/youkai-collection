import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FLYING_SHIKIGAMI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import {
  HISHO_SUCCESS_RATE_KNOWN,
  HISHO_SUCCESS_RATE_UNKNOWN,
} from '../types/skill';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const EXP_GAIN_SUCCESS = 15;
const EXP_GAIN_FAIL    = 3;

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; shikigamiId?: string };
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deviceId, shikigamiId } = body;
  if (!deviceId || !shikigamiId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // 飛翔レコード取得
  const recordRes = await ddb.send(new GetCommand({
    TableName: FLYING_SHIKIGAMI_TABLE,
    Key: { deviceId, shikigami_id: shikigamiId },
  }));
  const record = recordRes.Item;
  if (!record) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Shikigami not found' }) };
  }
  if (record.status !== 'flying') {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Already resolved', status: record.status }) };
  }

  // 到達時刻チェック
  const arrivesAt = new Date(record.arrives_at as string);
  if (Date.now() < arrivesAt.getTime()) {
    const remainingSec = Math.ceil((arrivesAt.getTime() - Date.now()) / 1000);
    return {
      statusCode: 425,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Not arrived yet', remaining_sec: remainingSec }),
    };
  }

  // 真名既知チェック（過去に封印済みか）
  const captureRes = await ddb.send(new GetCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId: record.target_youkai_id as string },
  }));
  const shinmeiKnown = captureRes.Item?.actionType === 'seal';
  const successRate  = shinmeiKnown ? HISHO_SUCCESS_RATE_KNOWN : HISHO_SUCCESS_RATE_UNKNOWN;
  const success      = Math.random() < successRate;

  const now    = new Date().toISOString();
  const status = success ? 'sealed' : 'failed';

  // 飛翔レコード更新
  await ddb.send(new UpdateCommand({
    TableName: FLYING_SHIKIGAMI_TABLE,
    Key: { deviceId, shikigami_id: shikigamiId },
    UpdateExpression: 'SET #st = :s, result_at = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':s': status, ':now': now },
  }));

  if (success) {
    // 捕獲レコードを作成/上書き
    await ddb.send(new PutCommand({
      TableName: CAPTURES_TABLE,
      Item: {
        deviceId,
        youkaiId:    record.target_youkai_id,
        capturedAt:  now,
        userLat:     record.target_lat,
        userLon:     record.target_lon,
        actionType:  'seal',
        faction:     'exorcist',
        via_hisho:   true,
      },
    }));
  }

  // EXP加算
  const expGain = success ? EXP_GAIN_SUCCESS : EXP_GAIN_FAIL;
  ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'ADD exp :gain SET updated_at = :now',
    ExpressionAttributeValues: { ':gain': expGain, ':now': now },
  })).catch((e) => console.error('exp update failed', e));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success,
      status,
      shinmei_known:    shinmeiKnown,
      success_rate:     successRate,
      target_youkai_id: record.target_youkai_id,
      exp_gained:       expGain,
    }),
  };
};
