import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE, PLAYER_PROFILE_TABLE, YOUKAI_TABLE } from '../lib/dynamodb';
import { distanceMeters } from '../lib/distance';

const KEKKAI_MIN_AREA_M2 = 500; // 最小三角面積（m²）

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

/** Shoelace formula で三角形面積（m²近似）を計算 */
function triangleAreaM2(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  c: { lat: number; lon: number },
): number {
  // 各辺を距離に変換（簡易平面近似: 緯度・経度を独立に m 換算）
  const latM = 111_320;
  const lonM = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lon * lonM, ay = a.lat * latM;
  const bx = b.lon * lonM, by = b.lat * latM;
  const cx = c.lon * lonM, cy = c.lat * latM;
  return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
}

function centroid(points: { lat: number; lon: number }[]) {
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
  };
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!deviceId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing deviceId' }) };
  }

  // ジョブ確認
  const profileResult = await ddb.send(new GetCommand({ TableName: PLAYER_PROFILE_TABLE, Key: { deviceId } }));
  const p = profileResult.Item;
  if (p?.job !== 'onmyoji' && p?.faction !== 'exorcist') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Job mismatch: onmyoji required' }) };
  }

  // 封印済み妖怪IDを取得
  const capturesResult = await ddb.send(new QueryCommand({
    TableName: CAPTURES_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: 'actionType = :a',
    ExpressionAttributeValues: { ':d': deviceId, ':a': 'seal' },
    ProjectionExpression: 'youkaiId',
  }));

  const sealedIds = (capturesResult.Items ?? []).map((i) => i.youkaiId as string);
  if (sealedIds.length < 3) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ kekkais: [], sealed_count: sealedIds.length, required: 3 }),
    };
  }

  // 妖怪の緯度経度を一括取得
  const batchResult = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [YOUKAI_TABLE]: {
        Keys: sealedIds.map((id) => ({ yokai_id: id })),
        ProjectionExpression: 'yokai_id, latitude, longitude',
      },
    },
  }));

  const posMap = new Map<string, { lat: number; lon: number }>();
  for (const item of (batchResult.Responses?.[YOUKAI_TABLE] ?? [])) {
    posMap.set(item.yokai_id as string, { lat: item.latitude as number, lon: item.longitude as number });
  }

  const validIds = sealedIds.filter((id) => posMap.has(id));
  if (validIds.length < 3) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ kekkais: [], sealed_count: validIds.length, required: 3 }),
    };
  }

  // 全tripletで結界候補を探す（最大20件）
  const kekkais: Array<{
    yokai_ids: string[];
    center: { lat: number; lon: number };
    area_m2: number;
  }> = [];

  outer: for (let i = 0; i < validIds.length - 2; i++) {
    for (let j = i + 1; j < validIds.length - 1; j++) {
      for (let k = j + 1; k < validIds.length; k++) {
        const a = posMap.get(validIds[i])!;
        const b = posMap.get(validIds[j])!;
        const c = posMap.get(validIds[k])!;
        const area = triangleAreaM2(a, b, c);
        if (area >= KEKKAI_MIN_AREA_M2) {
          kekkais.push({
            yokai_ids: [validIds[i], validIds[j], validIds[k]],
            center: centroid([a, b, c]),
            area_m2: Math.round(area),
          });
          if (kekkais.length >= 20) break outer;
        }
      }
    }
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ kekkais, sealed_count: validIds.length }),
  };
};
