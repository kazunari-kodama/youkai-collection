import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import type { YokaiDBItem } from '../types/youkai';
import { MAX_COPIED_POWERS } from '../types/skill';

const EXP_GAIN = 12;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; youkaiId?: string; keyword?: string };
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deviceId, youkaiId, keyword } = body;
  if (!deviceId || !youkaiId || !keyword) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // ジョブ確認
  const profileResult = await ddb.send(new GetCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));
  const profile = profileResult.Item;
  if (!profile || profile.job !== 'jujutsushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Job mismatch: jujutsushi required' }) };
  }

  // bond済み確認
  const captureResult = await ddb.send(new GetCommand({ TableName: CAPTURES_TABLE, Key: { deviceId, youkaiId } }));
  const capture = captureResult.Item;
  if (!capture || capture.actionType !== 'bond') {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Not bonded by you' }) };
  }
  if (capture.power_copied === keyword) {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Already copied this power' }) };
  }

  // 妖怪のkeywordsに含まれるか確認
  const yokaiResult = await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE,
    Key: { yokai_id: youkaiId },
    ProjectionExpression: 'keywords',
  }));
  const keywords = (yokaiResult.Item as Pick<YokaiDBItem, 'keywords'>)?.keywords ?? [];
  if (!keywords.includes(keyword)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid keyword for this youkai' }) };
  }

  // captures に写し取りを記録
  await ddb.send(new UpdateCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId },
    UpdateExpression: 'SET power_copied = :kw, utsushi_at = :now',
    ExpressionAttributeValues: { ':kw': keyword, ':now': new Date().toISOString() },
  }));

  // プレイヤープロファイルのcopied_powersを更新（最大3件、古いものを先頭から削除）
  const currentPowers: string[] = (profile.copied_powers as string[]) ?? [];
  const newPowers = [...currentPowers.filter((p) => p !== keyword), keyword];
  const trimmed = newPowers.slice(-MAX_COPIED_POWERS);

  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'SET copied_powers = :cp, updated_at = :now ADD exp :gain',
    ExpressionAttributeValues: {
      ':cp': trimmed,
      ':now': new Date().toISOString(),
      ':gain': EXP_GAIN,
    },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      copied_powers: trimmed,
      effect: `「${keyword}」の力を写し取った。同じ属性の妖との契約時、霊力が増す。`,
      exp_gained: EXP_GAIN,
    }),
  };
};
