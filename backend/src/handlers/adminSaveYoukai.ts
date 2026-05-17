import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, CORE_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const ADMIN_KEY = process.env.ADMIN_KEY!;

export const handler: APIGatewayProxyHandler = async (event) => {
  const receivedKey = event.headers['x-admin-key'] ?? event.headers['X-Admin-Key'];
  if (receivedKey !== ADMIN_KEY) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { yokai_id } = body;
  if (!yokai_id || typeof yokai_id !== 'string' || !yokai_id.trim()) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'yokai_id required' }) };
  }

  // Remove undefined/empty optional fields so DynamoDB doesn't store empty strings
  const item: Record<string, unknown> = { yokai_id: yokai_id.trim() };
  const stringFields = ['name', 'kana', 'notes', 'appearance', 'region_detail', 'rally_key'] as const;
  for (const f of stringFields) {
    const v = body[f];
    if (typeof v === 'string' && v.trim()) item[f] = v.trim();
  }

  if (typeof body.latitude === 'number') item.latitude = body.latitude;
  if (typeof body.longitude === 'number') item.longitude = body.longitude;
  if (body.night_only === true) item.night_only = true;
  if (body.require_qr === true) item.require_qr = true;
  if (body.is_original === true) item.is_original = true;

  const arrayFields = ['images', 'image_types', 'image_captions', 'regions', 'category_tags', 'keywords'] as const;
  for (const f of arrayFields) {
    const v = body[f];
    if (Array.isArray(v) && v.length > 0) item[f] = v;
  }

  await ddb.send(new PutCommand({ TableName: YOUKAI_TABLE, Item: item }));

  // youkai_core に is_original フラグを同期（存在する場合のみ）
  try {
    const updateExpr = body.is_original === true
      ? 'SET is_original = :v'
      : 'REMOVE is_original';
    const exprVals = body.is_original === true
      ? { ':v': true }
      : undefined;
    await ddb.send(new UpdateCommand({
      TableName: CORE_TABLE,
      Key: { yokai_id: yokai_id.trim() },
      UpdateExpression: updateExpr,
      ...(exprVals ? { ExpressionAttributeValues: exprVals } : {}),
      ConditionExpression: 'attribute_exists(yokai_id)',
    }));
  } catch (e: any) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    // youkai_core に対応するアイテムが存在しない場合は無視
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, yokai_id: item.yokai_id }) };
};
