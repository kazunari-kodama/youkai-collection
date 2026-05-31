import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, KITOSHI_PRAYERS_TABLE, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';
import { PRAYER_EFFECT_HOURS } from '../types/skill';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

interface ReceiveRequest {
  deviceId:        string;
  owner_device_id: string;
  prayer_id:       string;
  faction:         'exorcist' | 'supernatural';
}

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: ReceiveRequest;
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, owner_device_id, prayer_id, faction } = body;
  if (!deviceId || !owner_device_id || !prayer_id || !faction) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }
  if (deviceId === owner_device_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Cannot receive own prayer' }) };
  }

  const prayerRes = await ddb.send(new GetCommand({
    TableName: KITOSHI_PRAYERS_TABLE,
    Key: { deviceId: owner_device_id, prayer_id },
    ProjectionExpression: 'prayer_id, expires_at',
  }));
  const prayer = prayerRes.Item;
  if (!prayer || (prayer.expires_at as string) <= new Date().toISOString()) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Prayer not found or expired' }) };
  }

  const modifier   = faction === 'exorcist' ? -1 : 1;
  const effectUntil = new Date(Date.now() + PRAYER_EFFECT_HOURS * 60 * 60 * 1000).toISOString();

  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'SET prayer_mod = :m, prayer_mod_until = :u',
    ExpressionAttributeValues: { ':m': modifier, ':u': effectUntil },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ ok: true, modifier, effect_until: effectUntil }),
  };
};
