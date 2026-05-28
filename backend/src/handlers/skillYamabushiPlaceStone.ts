import { randomUUID } from 'crypto';
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PLAYER_PROFILE_TABLE, YAMABUSHI_STONES_TABLE } from '../lib/dynamodb';
import { deductJutsu } from '../lib/jutsuriyoku';
import { JUTSU_COST } from '../types/skill';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

interface PlaceStoneRequest {
  deviceId: string;
  userLat:  number;
  userLon:  number;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: PlaceStoneRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, userLat, userLon } = body;
  if (!deviceId || userLat == null || userLon == null) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: '#j',
    ExpressionAttributeNames: { '#j': 'job' },
  }));
  if (profileRes.Item?.job !== 'yamabushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Yamabushi only' }) };
  }

  const jutsu = await deductJutsu(deviceId, JUTSU_COST.skill_yamabushi_stone, !!(body as unknown as { debug?: boolean }).debug);
  if (!jutsu.ok) {
    return { statusCode: 402, headers: HEADERS, body: JSON.stringify({
      error: 'Insufficient jutsuriyoku', current: jutsu.current, required: JUTSU_COST.skill_yamabushi_stone, max: jutsu.max,
    })};
  }

  const stoneId  = randomUUID();
  const placedAt = new Date().toISOString();

  await ddb.send(new PutCommand({
    TableName: YAMABUSHI_STONES_TABLE,
    Item: { deviceId, stone_id: stoneId, lat: userLat, lon: userLon, placed_at: placedAt },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true, stone_id: stoneId, lat: userLat, lon: userLon,
      jutsuriyoku: jutsu.current, jutsuriyoku_max: jutsu.max,
    }),
  };
};
