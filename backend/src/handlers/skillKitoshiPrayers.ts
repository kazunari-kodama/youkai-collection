import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, KITOSHI_PRAYERS_TABLE } from '../lib/dynamodb';
import { isValidDeviceId } from '../lib/deviceId';
import { encodeOwnerRef } from '../lib/ownerRef';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

/**
 * GET /skill/kitoshi/prayers?deviceId=
 * 有効な祈りを返す。持ち主の端末IDは返さず、owner_ref（受け取り API に渡す不透明な参照）と is_own を返す。
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const viewer = event.queryStringParameters?.deviceId;
  const me = isValidDeviceId(viewer) ? viewer : null;

  const res = await ddb.send(new ScanCommand({
    TableName: KITOSHI_PRAYERS_TABLE,
    FilterExpression: 'expires_at > :now',
    ExpressionAttributeValues: { ':now': new Date().toISOString() },
    ProjectionExpression: 'deviceId, prayer_id, lat, lon, placed_at, expires_at',
  }));

  const prayers = await Promise.all((res.Items ?? []).map(async (p) => ({
    owner_ref:  await encodeOwnerRef(p.deviceId as string),
    prayer_id:  p.prayer_id  as string,
    lat:        p.lat        as number,
    lon:        p.lon        as number,
    placed_at:  p.placed_at  as string,
    expires_at: p.expires_at as string,
    is_own:     me ? p.deviceId === me : false,
  })));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ prayers }),
  };
};
