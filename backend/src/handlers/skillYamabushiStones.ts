import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YAMABUSHI_STONES_TABLE } from '../lib/dynamodb';
import { isValidDeviceId } from '../lib/deviceId';
import { encodeOwnerRef } from '../lib/ownerRef';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

/**
 * GET /skill/yamabushi/stones?deviceId=
 * 全員の石積みを返す。持ち主やいいねした人の端末IDは返さない（端末IDは実質的な本人確認のため）。
 * 代わりに持ち主の不透明な参照 owner_ref と、閲覧者から見た is_own / liked_by_me を返す。
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const viewer = event.queryStringParameters?.deviceId;
  const me = isValidDeviceId(viewer) ? viewer : null;

  const res = await ddb.send(new ScanCommand({
    TableName: YAMABUSHI_STONES_TABLE,
    ProjectionExpression: 'deviceId, stone_id, lat, lon, placed_at, #msg, liked_by',
    ExpressionAttributeNames: { '#msg': 'message' },
  }));

  const stones = await Promise.all((res.Items ?? []).map(async (s) => {
    const likedBy = s.liked_by ? Array.from(s.liked_by as Set<string>) : [];
    return {
      owner_ref:   await encodeOwnerRef(s.deviceId as string),
      stone_id:    s.stone_id  as string,
      lat:         s.lat       as number,
      lon:         s.lon       as number,
      placed_at:   s.placed_at as string,
      message:     s.message   as string | undefined,
      like_count:  likedBy.length,
      liked_by_me: me ? likedBy.includes(me) : false,
      is_own:      me ? s.deviceId === me : false,
    };
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ stones }),
  };
};
