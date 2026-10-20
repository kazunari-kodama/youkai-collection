import type { APIGatewayProxyHandler } from 'aws-lambda';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import ngeohash from 'ngeohash';
import { ddb, CAPTURES_TABLE, SPAWN_CAPTURES_TABLE, toYokaiListItem } from '../lib/dynamodb';
import { cellsAround, computeCell, hourWindowOf } from '../lib/spawn/engine';
import { getSpawnPool } from '../lib/spawn/pool';
import { getSpawnSecret } from '../lib/spawn/secret';
import { checkAndRecordMovement } from '../lib/spawn/movement';
import { isValidDeviceId } from '../lib/deviceId';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const isoSec = (sec: number) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z');

/**
 * GET /spawns?lat=&lng=&deviceId=
 * 現在地のマスと周囲8マスの計算配置と、同じ範囲の固定配置をまとめて返す。
 * deviceId があれば捕獲済みかどうかを付け、移動速度チェック用に位置を記録する。
 * 固定配置の一覧は従来どおり GET /youkai（形式は変えていない）。
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const q = event.queryStringParameters ?? {};
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  if (q.lat == null || q.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'lat and lng required' }) };
  }
  const deviceId = isValidDeviceId(q.deviceId) ? q.deviceId : null;

  const nowMs = Date.now();
  const [secret, pool] = await Promise.all([getSpawnSecret(), getSpawnPool(nowMs)]);
  const hourWindow = hourWindowOf(nowMs / 1000);
  const cells = cellsAround(lat, lng);

  const computed = cells.flatMap((gh) => computeCell(secret, gh, hourWindow, pool.tableFor));

  // 固定配置は9マスを囲む矩形の中のもの
  let minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
  for (const gh of cells) {
    const [a, b, c, d] = ngeohash.decode_bbox(gh);
    minLat = Math.min(minLat, a); minLng = Math.min(minLng, b);
    maxLat = Math.max(maxLat, c); maxLng = Math.max(maxLng, d);
  }
  const fixed = pool.fixed.filter((y) =>
    y.latitude >= minLat && y.latitude <= maxLat && y.longitude >= minLng && y.longitude <= maxLng);

  let capturedSpawns = new Set<string>();
  let capturedYokai = new Set<string>();
  if (deviceId) {
    // /spawns では速度異常でも拒否しない（位置を更新しないだけ）。捕獲時に改めて判定される
    const [caps] = await Promise.all([
      fetchCaptured(deviceId, computed.map((s) => s.spawn_id), fixed.map((y) => y.yokai_id)),
      checkAndRecordMovement(deviceId, lat, lng, nowMs).catch((e) => console.error('movement record failed', e)),
    ]);
    ({ capturedSpawns, capturedYokai } = caps);
  }

  const spawns = [
    ...computed.map((s) => ({
      spawn_id: s.spawn_id,
      source: 'computed' as const,
      yokai_id: s.yokai_id,
      lat: Number(s.lat.toFixed(6)),
      lng: Number(s.lng.toFixed(6)),
      expires_at: isoSec(s.expiresAtSec),
      captured: capturedSpawns.has(s.spawn_id),
    })),
    ...fixed.map((y) => ({
      spawn_id: `fixed:${y.yokai_id}`,
      source: 'fixed' as const,
      ...toYokaiListItem(y),
      captured: capturedYokai.has(y.yokai_id),
    })),
  ];

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ spawns }) };
};

async function fetchCaptured(deviceId: string, spawnIds: string[], yokaiIds: string[]) {
  const capturedSpawns = new Set<string>();
  const capturedYokai = new Set<string>();
  type Req = { table: string; key: Record<string, string> };
  const reqs: Req[] = [
    ...spawnIds.map((id) => ({ table: SPAWN_CAPTURES_TABLE, key: { deviceId, spawn_id: id } })),
    ...yokaiIds.map((id) => ({ table: CAPTURES_TABLE, key: { deviceId, youkaiId: id } })),
  ];

  for (let i = 0; i < reqs.length; i += 100) {
    let requestItems: Record<string, { Keys: Record<string, string>[]; ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string> }> = {};
    for (const r of reqs.slice(i, i + 100)) {
      requestItems[r.table] ??= r.table === CAPTURES_TABLE
        ? { Keys: [], ProjectionExpression: 'youkaiId, actionType' }
        : { Keys: [], ProjectionExpression: 'spawn_id' };
      requestItems[r.table].Keys.push(r.key);
    }
    for (let attempt = 0; attempt < 3 && Object.keys(requestItems).length; attempt++) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: requestItems }));
      for (const it of res.Responses?.[SPAWN_CAPTURES_TABLE] ?? []) capturedSpawns.add(it.spawn_id as string);
      for (const it of res.Responses?.[CAPTURES_TABLE] ?? []) {
        if (it.actionType === 'seal' || it.actionType === 'bond') capturedYokai.add(it.youkaiId as string);
      }
      requestItems = (res.UnprocessedKeys ?? {}) as typeof requestItems;
    }
  }
  return { capturedSpawns, capturedYokai };
}
