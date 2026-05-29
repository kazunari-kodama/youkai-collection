import type { APIGatewayProxyHandler } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const VALID_JOBS = new Set(['onmyoji', 'kitoshi', 'miko', 'yojutsushi', 'yamabushi', 'jujutsushi']);

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: { deviceId?: string; job?: string; faction?: string };
  try { body = JSON.parse(event.body ?? ''); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { deviceId, job, faction } = body;
  if (!deviceId || !job) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) };
  }
  if (!VALID_JOBS.has(job)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid job' }) };
  }

  const resolvedFaction = faction ?? (['onmyoji', 'kitoshi', 'miko'].includes(job) ? 'exorcist' : 'supernatural');

  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'SET #job = :j, #faction = :f, updated_at = :now',
    ExpressionAttributeNames: { '#job': 'job', '#faction': 'faction' },
    ExpressionAttributeValues: {
      ':j':   job,
      ':f':   resolvedFaction,
      ':now': new Date().toISOString(),
    },
  }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) };
};
