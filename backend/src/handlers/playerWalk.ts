import type { APIGatewayProxyHandler } from 'aws-lambda';
import { addWalkedDistance } from '../lib/jutsuriyoku';
import { isValidDeviceId } from '../lib/deviceId';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; meters?: number };
  try { body = JSON.parse(event.body ?? '{}'); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, meters } = body;
  if (!isValidDeviceId(deviceId) || !meters || meters <= 0) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  await addWalkedDistance(deviceId, Math.min(meters, 500));
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
};
