import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// 5-minute in-memory cache (Lambda warm container)
let _cache: { exorcist: number; supernatural: number; total: number; at: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export const handler: APIGatewayProxyHandler = async () => {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    const { exorcist, supernatural, total } = _cache;
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(buildResponse(exorcist, supernatural, total)) };
  }

  let exorcist = 0;
  let supernatural = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: CAPTURES_TABLE,
      ProjectionExpression: 'actionType',
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items ?? []) {
      if (item.actionType === 'bond') supernatural++;
      else if (item.actionType === 'seal') exorcist++;
      // actionType のない旧レコードはカウントしない
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const total = exorcist + supernatural;
  _cache = { exorcist, supernatural, total, at: Date.now() };

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(buildResponse(exorcist, supernatural, total)) };
};

function buildResponse(exorcist: number, supernatural: number, total: number) {
  const comeback_bonus_active =
    total > 10 && (exorcist / total > 0.7 || supernatural / total > 0.7);
  const disadvantaged = exorcist <= supernatural ? 'exorcist' : 'supernatural';
  return { exorcist, supernatural, total, comeback_bonus_active, disadvantaged };
}
