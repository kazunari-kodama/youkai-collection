import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand, BatchWriteCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  ddb,
  CAPTURES_TABLE,
  KEKKAI_STONES_TABLE,
  KEKKAI_BARRIERS_TABLE,
  YAMABUSHI_STONES_TABLE,
  KITOSHI_PRAYERS_TABLE,
  SHOUJUTSU_TABLE,
  PLAYER_PROFILE_TABLE,
} from '../lib/dynamodb';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

/** deviceId(PK) のレコードを全削除。skAttr はソートキー属性名 */
async function deleteAllByDevice(table: string, deviceId: string, skAttr: string): Promise<number> {
  const res = await ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'deviceId = :d',
    ExpressionAttributeValues: { ':d': deviceId },
    ProjectionExpression: `deviceId, ${skAttr}`,
  }));
  const items = res.Items ?? [];
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [table]: chunk.map((it) => ({
          DeleteRequest: { Key: { deviceId: it.deviceId, [skAttr]: it[skAttr] } },
        })),
      },
    }));
  }
  return items.length;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!deviceId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'deviceId required' }) };
  }

  const [captures, stones, barriers, yamaStones, prayers, summons] = await Promise.all([
    deleteAllByDevice(CAPTURES_TABLE,         deviceId, 'youkaiId'),
    deleteAllByDevice(KEKKAI_STONES_TABLE,    deviceId, 'stone_id'),
    deleteAllByDevice(KEKKAI_BARRIERS_TABLE,  deviceId, 'barrier_id'),
    deleteAllByDevice(YAMABUSHI_STONES_TABLE, deviceId, 'stone_id'),
    deleteAllByDevice(KITOSHI_PRAYERS_TABLE,  deviceId, 'prayer_id'),
    deleteAllByDevice(SHOUJUTSU_TABLE,        deviceId, 'shoujutsu_id'),
  ]);

  // プロフィール削除（ランク・経験値・職業・各スキル状態をすべて消去）
  await ddb.send(new DeleteCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      ok: true,
      deleted: { captures, stones, barriers, yamaStones, prayers, summons },
    }),
  };
};
