import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YOUKAI_TABLE, IMAGES_BASE_URL, toCameraUrl } from '../lib/dynamodb';
import type { YokaiDBItem } from '../types/youkai';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const key = event.queryStringParameters?.key;
  if (!key) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'key required' }) };
  }

  const result = await ddb.send(
    new ScanCommand({
      TableName: YOUKAI_TABLE,
      FilterExpression: 'rally_key = :k',
      ExpressionAttributeValues: { ':k': key },
      ProjectionExpression: 'yokai_id, #n, latitude, longitude, images, image_types, rally_key, #rq',
      ExpressionAttributeNames: { '#n': 'name', '#rq': 'require_qr' },
    }),
  );

  if (!result.Items?.length) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Invalid rally key' }) };
  }

  const yokai = (result.Items as YokaiDBItem[]).map((item) => ({
    id: item.yokai_id,
    name: item.name,
    lat: item.latitude,
    lon: item.longitude,
    camera_url: toCameraUrl(item.images, IMAGES_BASE_URL),
    rally_key: item.rally_key,
    ...(item.require_qr ? { require_qr: true } : {}),
  }));

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ key, yokai }) };
};
