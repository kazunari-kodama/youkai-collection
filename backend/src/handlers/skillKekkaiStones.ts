import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, KEKKAI_STONES_TABLE, KEKKAI_BARRIERS_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!deviceId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing deviceId' }) };
  }

  const [stonesRes, barriersRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: KEKKAI_STONES_TABLE,
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
    })),
    ddb.send(new QueryCommand({
      TableName: KEKKAI_BARRIERS_TABLE,
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
    })),
  ]);

  const stones = (stonesRes.Items ?? []).map((s) => ({
    stone_id:  s.stone_id as string,
    lat:       s.lat as number,
    lon:       s.lon as number,
    placed_at: s.placed_at as string,
  }));

  const barriers = (barriersRes.Items ?? []).map((b) => ({
    barrier_id: b.barrier_id as string,
    lats:       b.lats as number[],
    lons:       b.lons as number[],
    center:     { lat: b.center_lat as number, lon: b.center_lon as number },
    area_m2:    b.area_m2 as number,
    formed_at:  b.formed_at as string,
    expires_at: b.expires_at as string,
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ stones, barriers }),
  };
};
