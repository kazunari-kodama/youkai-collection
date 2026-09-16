import type { APIGatewayProxyHandler } from 'aws-lambda';
import { YOUKAI_TABLE, IMAGES_BASE_URL, toCameraUrl, toThumbUrl, scanAll } from '../lib/dynamodb';
import type { YokaiDBItem, YokaiListItem } from '../types/youkai';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async () => {
  const scanned = await scanAll<YokaiDBItem>({
    TableName: YOUKAI_TABLE,
    FilterExpression: 'attribute_not_exists(rally_key)',
    ProjectionExpression: 'yokai_id, #n, latitude, longitude, images, night_only, #rq',
    ExpressionAttributeNames: { '#n': 'name', '#rq': 'require_qr' },
  });

  const items: YokaiListItem[] = scanned.map((item) => ({
    id: item.yokai_id,
    name: item.name,
    lat: item.latitude,
    lon: item.longitude,
    thumb_url: toThumbUrl(item.images, IMAGES_BASE_URL),
    camera_url: toCameraUrl(item.images, IMAGES_BASE_URL),
    ...(item.night_only ? { night_only: true } : {}),
    ...(item.require_qr ? { require_qr: true } : {}),
  }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(items) };
};
