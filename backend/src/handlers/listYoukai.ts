import type { APIGatewayProxyHandler } from 'aws-lambda';
import { YOUKAI_TABLE, scanAll, toYokaiListItem } from '../lib/dynamodb';
import type { YokaiDBItem, YokaiListItem } from '../types/youkai';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async () => {
  const scanned = await scanAll<YokaiDBItem>({
    TableName: YOUKAI_TABLE,
    // 座標の無い妖怪が1件でも混ざると地図の描画が止まるので、ここで除く
    FilterExpression: 'attribute_not_exists(rally_key) AND attribute_exists(latitude) AND attribute_exists(longitude)',
    ProjectionExpression: 'yokai_id, #n, latitude, longitude, images, night_only, #rq',
    ExpressionAttributeNames: { '#n': 'name', '#rq': 'require_qr' },
  });

  const items: YokaiListItem[] = scanned.map(toYokaiListItem);

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(items) };
};
