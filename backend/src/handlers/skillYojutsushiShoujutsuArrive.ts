import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, SHOUJUTSU_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, YOUKAI_TABLE } from '../lib/dynamodb';
import { YOURYOKU_RANKS } from '../types/skill';
import type { YokaiDBItem } from '../types/youkai';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function addExp(deviceId: string, gain: number, now: string) {
  ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'ADD exp :g SET updated_at = :now',
    ExpressionAttributeValues: { ':g': gain, ':now': now },
  })).catch(() => {});
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; shoujutsuId?: string };
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, shoujutsuId } = body;
  if (!deviceId || !shoujutsuId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  const recordRes = await ddb.send(new GetCommand({
    TableName: SHOUJUTSU_TABLE,
    Key: { deviceId, shoujutsu_id: shoujutsuId },
  }));
  const record = recordRes.Item;
  if (!record) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Summon not found' }) };
  if (record.status !== 'flying') return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Already resolved' }) };
  if (Date.now() < new Date(record.arrives_at as string).getTime()) {
    const rem = Math.ceil((new Date(record.arrives_at as string).getTime() - Date.now()) / 1000);
    return { statusCode: 425, headers: HEADERS, body: JSON.stringify({ error: 'Not arrived yet', remaining_sec: rem }) };
  }

  const targetYoukaiId = record.target_youkai_id as string;
  const now = new Date().toISOString();

  const [youkaiRes, captureRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: YOUKAI_TABLE, Key: { yokai_id: targetYoukaiId }, ProjectionExpression: 'youryoku' })),
    ddb.send(new GetCommand({ TableName: CAPTURES_TABLE, Key: { deviceId, youkaiId: targetYoukaiId } })),
  ]);

  const youryoku = ((youkaiRes.Item as Partial<YokaiDBItem>)?.youryoku ?? 1) as number;
  const rankInfo = YOURYOKU_RANKS[youryoku] ?? YOURYOKU_RANKS[1];
  const existing = captureRes.Item;

  // 既に封印済みならスキップ
  if (existing?.actionType === 'seal' || existing?.actionType === 'bond') {
    await ddb.send(new UpdateCommand({
      TableName: SHOUJUTSU_TABLE,
      Key: { deviceId, shoujutsu_id: shoujutsuId },
      UpdateExpression: 'SET #st = :s, result_at = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':s': 'failed', ':now': now },
    }));
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: false, reason: 'already_captured' }) };
  }

  const required = rankInfo.trials;
  const prevProg = (existing?.seal_progress as number | undefined) ?? 0;
  const newProg  = prevProg + 1;
  const sealed   = newProg >= required;

  await ddb.send(new PutCommand({
    TableName: CAPTURES_TABLE,
    Item: {
      deviceId, youkaiId: targetYoukaiId,
      actionType:    sealed ? 'seal' : 'in_progress',
      faction:       'supernatural',
      seal_progress: newProg,
      seal_required: required,
      capturedAt:    existing?.capturedAt ?? now,
      lastTriedAt:   now,
      userLat:       record.target_lat,
      userLon:       record.target_lon,
      via_shoujutsu: true,
    },
  }));
  await ddb.send(new UpdateCommand({
    TableName: SHOUJUTSU_TABLE,
    Key: { deviceId, shoujutsu_id: shoujutsuId },
    UpdateExpression: 'SET #st = :s, result_at = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':s': sealed ? 'sealed' : 'arrived', ':now': now },
  }));

  addExp(deviceId, sealed ? 15 : 5, now);

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true, sealed, progress: newProg, required, youryoku,
      rank_name: rankInfo.name, exp_gained: sealed ? 15 : 5,
      target_youkai_id: targetYoukaiId,
    }),
  };
};
