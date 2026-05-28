import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PLAYER_PROFILE_TABLE, CAPTURES_TABLE, YOUKAI_TABLE } from '../lib/dynamodb';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const BONUS_PER_20PCT = 1;
const BONUS_MAX       = 5;

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!deviceId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing deviceId' }) };
  }

  const profileRes = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    ProjectionExpression: '#j',
    ExpressionAttributeNames: { '#j': 'job' },
  }));
  if (profileRes.Item?.job !== 'yamabushi') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Yamabushi only' }) };
  }

  // 封印・契約済み妖怪を取得
  const capturesRes = await ddb.send(new QueryCommand({
    TableName: CAPTURES_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    ExpressionAttributeValues: { ':d': deviceId },
    ProjectionExpression: 'youkaiId, actionType',
  }));
  const sealedIds = new Set(
    (capturesRes.Items ?? [])
      .filter((c) => c.actionType === 'seal' || c.actionType === 'bond')
      .map((c) => c.youkaiId as string),
  );

  // 全妖怪をスキャンしてリージョン情報を取得
  const yokaiScanRes = await ddb.send(new ScanCommand({
    TableName: YOUKAI_TABLE,
    ProjectionExpression: 'yokai_id, regions',
  }));
  const allYoukai = yokaiScanRes.Items ?? [];

  // 地域ごとに集計
  const regionMap = new Map<string, { total: number; sealed: number }>();
  for (const y of allYoukai) {
    const region = (y.regions as string[] | undefined)?.[0] ?? '不明';
    if (!regionMap.has(region)) regionMap.set(region, { total: 0, sealed: 0 });
    const r = regionMap.get(region)!;
    r.total += 1;
    if (sealedIds.has(y.yokai_id as string)) r.sealed += 1;
  }

  const regions = Array.from(regionMap.entries())
    .map(([name, { total, sealed }]) => ({
      name,
      total,
      sealed,
      rate_pct: total > 0 ? Math.round((sealed / total) * 100) : 0,
    }))
    .sort((a, b) => b.rate_pct - a.rate_pct);

  const totalYoukai  = allYoukai.length;
  const totalSealed  = sealedIds.size;
  const overallPct   = totalYoukai > 0 ? Math.round((totalSealed / totalYoukai) * 100) : 0;
  const bonus        = Math.min(BONUS_MAX, Math.floor(overallPct / 20) * BONUS_PER_20PCT);

  await ddb.send(new UpdateCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
    UpdateExpression: 'SET yamabushi_traversal_bonus = :b',
    ExpressionAttributeValues: { ':b': bonus },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ regions, overall_pct: overallPct, bonus }),
  };
};
