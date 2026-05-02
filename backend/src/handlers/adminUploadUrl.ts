import type { APIGatewayProxyHandler } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const ADMIN_KEY = process.env.ADMIN_KEY!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;

const s3 = new S3Client({});

export const handler: APIGatewayProxyHandler = async (event) => {
  const receivedKey = event.headers['x-admin-key'] ?? event.headers['X-Admin-Key'];
  if (receivedKey !== ADMIN_KEY) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body: { key?: string; contentType?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { key, contentType } = body;
  if (!key || !contentType) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'key and contentType required' }) };
  }

  // Only allow uploads into the youkai/ prefix
  if (!key.startsWith('youkai/')) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'key must start with youkai/' }) };
  }

  const command = new PutObjectCommand({
    Bucket: IMAGES_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 300 });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ url, key }) };
};
