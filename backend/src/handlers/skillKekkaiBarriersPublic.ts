import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, KEKKAI_BARRIERS_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async () => {
  const now = new Date().toISOString();
  const result = await ddb.send(new ScanCommand({
    TableName: KEKKAI_BARRIERS_TABLE,
    FilterExpression: 'expires_at > :now',
    ExpressionAttributeValues: { ':now': now },
    ProjectionExpression: 'barrier_id, lats, lons, center_lat, center_lon, area_m2, expires_at',
  }));

  const barriers = (result.Items ?? []).map((b) => ({
    barrier_id: b.barrier_id as string,
    lats:       b.lats       as number[],
    lons:       b.lons       as number[],
    center:     { lat: b.center_lat as number, lon: b.center_lon as number },
    area_m2:    b.area_m2   as number,
    expires_at: b.expires_at as string,
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ barriers }),
  };
};
