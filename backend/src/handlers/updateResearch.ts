import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, RESEARCH_TABLE } from '../lib/dynamodb';
import type { ResearchStatus } from '../types/research';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const ADMIN_KEY = process.env.ADMIN_KEY!;

// approve transition is handled by /promote endpoint
const VALID_TRANSITIONS: Partial<Record<ResearchStatus, ResearchStatus[]>> = {
  pending: ['reviewing'],
  reviewing: ['rejected'],
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const adminKey = event.headers['x-admin-key'] ?? event.headers['X-Admin-Key'];
  if (adminKey !== ADMIN_KEY) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const research_id = event.pathParameters?.id;
  if (!research_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id required' }) };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const current = await ddb.send(new GetCommand({ TableName: RESEARCH_TABLE, Key: { research_id } }));
  if (!current.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  const currentStatus = current.Item.status as ResearchStatus;
  const newStatus = body.status as ResearchStatus | undefined;

  if (newStatus && newStatus !== currentStatus) {
    const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({ error: `Cannot transition from ${currentStatus} to ${newStatus}` }),
      };
    }
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {};

  if (newStatus) {
    updates.status = newStatus;
    updates.reviewed_by = 'curator';
    updates.reviewed_at = now;
  }
  if (typeof body.review_notes === 'string') updates.review_notes = body.review_notes;
  if (typeof body.summary === 'string') updates.summary = body.summary;
  if (typeof body.reliability_score === 'number') updates.reliability_score = body.reliability_score;
  if (typeof body.originality_score === 'number') updates.originality_score = body.originality_score;

  if (Object.keys(updates).length === 0) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No fields to update' }) };
  }

  const keys = Object.keys(updates);
  const setExpressions = keys.map((k, i) => `#f${i} = :v${i}`);
  const expressionAttributeNames = Object.fromEntries(keys.map((k, i) => [`#f${i}`, k]));
  const expressionAttributeValues = Object.fromEntries(keys.map((k, i) => [`:v${i}`, updates[k]]));

  await ddb.send(
    new UpdateCommand({
      TableName: RESEARCH_TABLE,
      Key: { research_id },
      UpdateExpression: `SET ${setExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }),
  );

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, research_id }) };
};
