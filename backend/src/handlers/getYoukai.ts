import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, IMAGES_BASE_URL, toCameraUrl } from '../lib/dynamodb';
import type { YokaiDBItem, YokaiDetail } from '../types/youkai';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const id = event.pathParameters?.id;
  if (!id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id required' }) };
  }

  const result = await ddb.send(
    new GetCommand({ TableName: YOUKAI_TABLE, Key: { yokai_id: id } }),
  );

  if (!result.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  const item = result.Item as YokaiDBItem;

  const images = (item.images ?? []).map((path, i) => ({
    url: `${IMAGES_BASE_URL}/${path}`,
    type: item.image_types?.[i] ?? 'unknown',
    caption: item.image_captions?.[i] ?? '',
  }));

  const detail: YokaiDetail = {
    id: item.yokai_id,
    name: item.name,
    kana: item.kana,
    lat: item.latitude,
    lon: item.longitude,
    notes: item.notes ?? '',
    appearance: item.appearance ?? '',
    camera_url: toCameraUrl(item.images, IMAGES_BASE_URL),
    images,
    regions: item.regions ?? [],
    region_detail: item.region_detail ?? '',
    category_tags: item.category_tags ?? [],
    keywords: item.keywords ?? [],
    ...(item.rally_key ? { rally_key: item.rally_key } : {}),
    ...(item.require_qr ? { require_qr: true } : {}),
  };

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(detail) };
};
