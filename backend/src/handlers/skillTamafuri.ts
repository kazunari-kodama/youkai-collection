import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, ARAGAMI_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import { JUTSU_COST, ARAGAMI_TTL_HOURS } from '../types/skill';
import type { YokaiDBItem } from '../types/youkai';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; youkaiId?: string };
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, youkaiId } = body;
  if (!deviceId || !youkaiId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // 呪術師ロール確認
  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: 'job',
  }));
  if (profileRes.Item?.job !== 'jujutsushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Jujutsushi only' }) };
  }

  // 自分がこの妖怪を解除済みか確認
  const captureRes = await ddb.send(new GetCommand({
    TableName: CAPTURES_TABLE,
    Key: { deviceId, youkaiId },
    ProjectionExpression: 'actionType',
  }));
  if (captureRes.Item?.actionType !== 'release') {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Yokai not released by you' }) };
  }

  // 既に荒魂化されていないか確認
  const now = new Date().toISOString();
  const aragamiRes = await ddb.send(new GetCommand({
    TableName: ARAGAMI_TABLE,
    Key: { youkaiId },
    ProjectionExpression: 'expires_at',
  }));
  if (aragamiRes.Item && aragamiRes.Item.expires_at > now) {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Already aragami' }) };
  }

  // 妖怪の妖力と名前を取得
  const yokaiRes = await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE,
    Key: { yokai_id: youkaiId },
    ProjectionExpression: 'youryoku, #n',
    ExpressionAttributeNames: { '#n': 'name' },
  }));
  if (!yokaiRes.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Youkai not found' }) };
  }
  const youryoku = (yokaiRes.Item.youryoku as number | undefined) ?? 1;
  const youkaiName = (yokaiRes.Item as Pick<YokaiDBItem, 'name'>).name;

  // 術力消費
  const jutsu = await deductJutsu(deviceId, JUTSU_COST.skill_tamafuri);
  if (!jutsu.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.skill_tamafuri, max: jutsu.max,
    })};
  }

  // 荒魂レコードを書き込む
  const expiresAt = new Date(Date.now() + ARAGAMI_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const ttl = Math.floor(Date.now() / 1000) + ARAGAMI_TTL_HOURS * 3600;

  await ddb.send(new PutCommand({
    TableName: ARAGAMI_TABLE,
    Item: {
      youkaiId,
      activated_by: deviceId,
      activated_at: now,
      youryoku,
      expires_at: expiresAt,
      ttl,
    },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true,
      youkaiId,
      youkaiName,
      youryoku,
      expires_at: expiresAt,
      jutsuriyoku: jutsu.current,
      jutsuriyoku_max: jutsu.max,
    }),
  };
};
