import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, NOROI_CURSES_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import { JUTSU_COST, NOROI_DURATION_DAYS } from '../types/skill';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

interface NoroiRequest {
  deviceId: string;
  youkaiId: string;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: NoroiRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, youkaiId } = body;
  if (!deviceId || !youkaiId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  const [profileRes, captureRes] = await Promise.all([
    ddb.send(new GetCommand({
      TableName: PLAYER_PROFILE_TABLE,
      Key: { deviceId },
      ProjectionExpression: '#j',
      ExpressionAttributeNames: { '#j': 'job' },
    })),
    ddb.send(new GetCommand({
      TableName: CAPTURES_TABLE,
      Key: { deviceId, youkaiId },
      ProjectionExpression: 'actionType',
    })),
  ]);

  if (profileRes.Item?.job !== 'yojutsushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Yojutsushi only' }) };
  }
  if (captureRes.Item?.actionType !== 'release') {
    return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'Youkai must be released by you' }) };
  }

  const jutsu = await deductJutsu(deviceId, JUTSU_COST.skill_yojutsushi_noroi, false);
  if (!jutsu.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.skill_yojutsushi_noroi, max: jutsu.max,
    })};
  }

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + NOROI_DURATION_DAYS * 86400 * 1000);

  await ddb.send(new PutCommand({
    TableName: NOROI_CURSES_TABLE,
    Item: {
      youkai_id:  youkaiId,
      placed_by:  deviceId,
      placed_at:  now.toISOString(),
      expires_at: expiresAt.toISOString(),
      ttl:        Math.floor(expiresAt.getTime() / 1000),
    },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true, youkai_id: youkaiId,
      expires_at: expiresAt.toISOString(),
      jutsuriyoku: jutsu.current, jutsuriyoku_max: jutsu.max,
    }),
  };
};
