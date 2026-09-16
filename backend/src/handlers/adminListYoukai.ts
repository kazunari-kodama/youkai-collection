import type { APIGatewayProxyHandler } from 'aws-lambda';
import { YOUKAI_TABLE, IMAGES_BASE_URL, toCameraUrl, scanAll } from '../lib/dynamodb';
import type { YokaiDBItem } from '../types/youkai';

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

  const scanned = await scanAll<YokaiDBItem>({ TableName: YOUKAI_TABLE });
  const items = scanned.map((item) => ({
    ...item,
    _images_base_url: IMAGES_BASE_URL,
    _icon_url: toCameraUrl(item.images, IMAGES_BASE_URL),
  }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(items) };
};
