import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YAMABUSHI_STONES_TABLE } from '../lib/dynamodb';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async () => {
  const res = await ddb.send(new ScanCommand({
    TableName: YAMABUSHI_STONES_TABLE,
    ProjectionExpression: 'deviceId, stone_id, lat, lon, placed_at, #msg, liked_by',
    ExpressionAttributeNames: { '#msg': 'message' },
  }));

  const stones = (res.Items ?? []).map((s) => ({
    deviceId:  s.deviceId  as string,
    stone_id:  s.stone_id  as string,
    lat:       s.lat       as number,
    lon:       s.lon       as number,
    placed_at: s.placed_at as string,
    message:   s.message   as string | undefined,
    liked_by:  s.liked_by  ? Array.from(s.liked_by as Set<string>) : [],
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ stones }),
  };
};
