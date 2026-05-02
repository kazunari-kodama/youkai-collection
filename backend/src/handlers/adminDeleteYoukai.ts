import type { APIGatewayProxyHandler } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE } from '../lib/dynamodb';

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

  const id = event.pathParameters?.id;
  if (!id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id required' }) };
  }

  await ddb.send(new DeleteCommand({ TableName: YOUKAI_TABLE, Key: { yokai_id: id } }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) };
};
