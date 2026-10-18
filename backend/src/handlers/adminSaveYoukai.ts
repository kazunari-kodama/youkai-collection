import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

  // 管理画面が扱わない項目（prefecture, rarity, illustrator など）は既存の値を引き継ぐ。
  // PutItem は全置換なので、引き継がないと保存のたびに消えてしまう。
  const existing = (await ddb.send(new GetCommand({
    TableName: YOUKAI_TABLE, Key: { yokai_id: yokai_id.trim() },
  }))).Item ?? {};
  const MANAGED = [
    'name', 'kana', 'notes', 'appearance', 'region_detail', 'rally_key',
    'latitude', 'longitude', 'night_only', 'require_qr', 'is_original', 'youryoku',
    'images', 'image_types', 'image_captions', 'regions', 'category_tags', 'keywords',
  ];
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => !MANAGED.includes(k)));

  // Remove undefined/empty optional fields so DynamoDB doesn't store empty strings
  const item: Record<string, unknown> = { ...kept, yokai_id: yokai_id.trim() };
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
  if (typeof body.youryoku === 'number' && body.youryoku >= 1 && body.youryoku <= 5) item.youryoku = body.youryoku;

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
