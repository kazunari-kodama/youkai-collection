import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FLYING_SHIKIGAMI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, YOUKAI_TABLE } from '../lib/dynamodb';
import {
  HISHO_SUCCESS_RATE_KNOWN,
  HISHO_SUCCESS_RATE_UNKNOWN,
  YOURYOKU_RANKS,
} from '../types/skill';
import type { YokaiDBItem } from '../types/youkai';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const EXP_GAIN_TRIAL   = 5;   // 試行成功（進捗加算）
const EXP_GAIN_SEALED  = 15;  // 封印完了
const EXP_GAIN_MISS    = 2;   // 試行失敗

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

  const targetYoukaiId = record.target_youkai_id as string;

  // 目標妖怪の youryoku 取得
  const youkaiRes = await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE,
    Key: { yokai_id: targetYoukaiId },
    ProjectionExpression: 'youryoku',
  }));
  const youryoku  = ((youkaiRes.Item as Pick<YokaiDBItem, 'youryoku'> | undefined)?.youryoku ?? 1) as number;
  const rankInfo  = YOURYOKU_RANKS[youryoku] ?? YOURYOKU_RANKS[1];
  const required  = rankInfo.trials;

  // 現在の封印進捗取得
  const captureRes = await ddb.send(new GetCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId: targetYoukaiId },
  }));
  const existing = captureRes.Item;

  // 既に封印・契約済みならスキップ
  if (existing?.actionType === 'seal' || existing?.actionType === 'bond') {
    await ddb.send(new UpdateCommand({
      TableName: FLYING_SHIKIGAMI_TABLE,
      Key: { deviceId, shikigami_id: shikigamiId },
      UpdateExpression: 'SET #st = :s, result_at = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':s': 'sealed', ':now': new Date().toISOString() },
    }));
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ success: false, reason: 'already_captured', actionType: existing.actionType }),
    };
  }

  // 真名既知チェック → 試行成功率決定
  const shinmeiKnown = existing?.actionType === 'seal' || (existing?.seal_progress ?? 0) > 0;
  const successRate  = shinmeiKnown ? HISHO_SUCCESS_RATE_KNOWN : HISHO_SUCCESS_RATE_UNKNOWN;
  const trialSuccess = Math.random() < successRate;

  const now      = new Date().toISOString();
  const prevProg = (existing?.seal_progress as number | undefined) ?? 0;

  // 飛翔レコードを解決済みに更新
  const newStatus = trialSuccess ? (prevProg + 1 >= required ? 'sealed' : 'flying_done') : 'failed';
  await ddb.send(new UpdateCommand({
    TableName: FLYING_SHIKIGAMI_TABLE,
    Key: { deviceId, shikigami_id: shikigamiId },
    UpdateExpression: 'SET #st = :s, result_at = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':s': newStatus === 'flying_done' ? 'sealed' : newStatus, ':now': now },
  }));

  if (!trialSuccess) {
    // 試行失敗: 進捗変化なし
    _addExp(deviceId, EXP_GAIN_MISS, now);
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        success: false,
        trial_success: false,
        shinmei_known: shinmeiKnown,
        success_rate: successRate,
        progress: prevProg,
        required,
        youryoku,
        exp_gained: EXP_GAIN_MISS,
      }),
    };
  }

  // 試行成功: 進捗を1加算
  const newProg  = prevProg + 1;
  const sealed   = newProg >= required;
  const expGain  = sealed ? EXP_GAIN_SEALED : EXP_GAIN_TRIAL;

  if (sealed) {
    await ddb.send(new PutCommand({
      TableName: CAPTURES_TABLE,
      Item: {
        deviceId,
        youkaiId:   targetYoukaiId,
        capturedAt: now,
        userLat:    record.target_lat,
        userLon:    record.target_lon,
        actionType: 'seal',
        faction:    'exorcist',
        seal_progress: required,
        seal_required: required,
        via_hisho:  true,
      },
    }));
  } else {
    await ddb.send(new PutCommand({
      TableName: CAPTURES_TABLE,
      Item: {
        deviceId,
        youkaiId:     targetYoukaiId,
        actionType:   'in_progress',
        faction:      'exorcist',
        seal_progress: newProg,
        seal_required: required,
        capturedAt:   existing?.capturedAt ?? now,
        lastTriedAt:  now,
        userLat:      record.target_lat,
        userLon:      record.target_lon,
        via_hisho:    true,
      },
    }));
  }

  _addExp(deviceId, expGain, now);

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true,
      trial_success: true,
      sealed,
      shinmei_known: shinmeiKnown,
      success_rate: successRate,
      progress: newProg,
      required,
      youryoku,
      rank_name: rankInfo.name,
      exp_gained: expGain,
    }),
  };
};

function _addExp(deviceId: string, gain: number, now: string) {
  ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'ADD exp :gain SET updated_at = :now',
    ExpressionAttributeValues: { ':gain': gain, ':now': now },
  })).catch((e) => console.error('exp update failed', e));
}
