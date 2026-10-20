import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CORE_TABLE } from '../lib/dynamodb';
import { resolveRole } from '../lib/auth';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  // 学術データ（youkai_core）は premium 限定（/academic/*）。こちらは社内スクリプト用なので管理キー必須
  if (!resolveRole(event)) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const yokai_id = event.pathParameters?.id;
  if (!yokai_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id required' }) };
  }

  const result = await ddb.send(new GetCommand({ TableName: CORE_TABLE, Key: { yokai_id } }));
  if (!result.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result.Item) };
};
