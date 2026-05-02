import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, IMAGES_BASE_URL, toCameraUrl } from '../lib/dynamodb';
import type { YokaiDBItem, YokaiListItem } from '../types/youkai';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function resolveIconUrl(item: YokaiDBItem): string {
  if (!item.images || !item.image_types) return '';
  const idx = item.image_types.findIndex((t) => t === 'icon');
  if (idx === -1) return '';
  return `${IMAGES_BASE_URL}/${item.images[idx]}`;
}

export const handler: APIGatewayProxyHandler = async () => {
  const result = await ddb.send(
    new ScanCommand({
      TableName: YOUKAI_TABLE,
      FilterExpression: 'attribute_not_exists(rally_key)',
      ProjectionExpression: 'yokai_id, #n, latitude, longitude, images, image_types',
      ExpressionAttributeNames: { '#n': 'name' },
    }),
  );

  const items: YokaiListItem[] = ((result.Items ?? []) as YokaiDBItem[]).map((item) => ({
    id: item.yokai_id,
    name: item.name,
    lat: item.latitude,
    lon: item.longitude,
    icon_url: resolveIconUrl(item),
    camera_url: toCameraUrl(item.images, IMAGES_BASE_URL),
  }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(items) };
};
