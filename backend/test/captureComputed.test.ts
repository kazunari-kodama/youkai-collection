/**
 * POST /capture（計算配置）と GET /spawns を、DynamoDB と SSM をメモリ上のフェイクに差し替えて通す。
 * 二重取り・速度異常・図鑑（youkai-captures）への反映を確認する。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

const SECRET = 'handler-test-secret-0123456789abcdef0123';

process.env.YOUKAI_TABLE = 'kodama_db';
process.env.CORE_TABLE = 'youkai_core';
process.env.CAPTURES_TABLE = 'captures';
process.env.SPAWN_CAPTURES_TABLE = 'spawn_captures';
process.env.PLAYER_PROFILE_TABLE = 'profile';
process.env.KEKKAI_BARRIERS_TABLE = 'barriers';
process.env.ARAGAMI_TABLE = 'aragami';
process.env.NOROI_CURSES_TABLE = 'noroi';
process.env.IMAGES_BASE_URL = 'https://img.example';

// ---- フェイク ----------------------------------------------------------------

const KEYS: Record<string, string[]> = {
  kodama_db: ['yokai_id'], youkai_core: ['yokai_id'],
  captures: ['deviceId', 'youkaiId'], spawn_captures: ['deviceId', 'spawn_id'],
  profile: ['deviceId'], barriers: ['deviceId', 'barrier_id'], aragami: ['youkaiId'], noroi: ['youkai_id'],
};
const tables = new Map<string, Map<string, Record<string, unknown>>>();
const tbl = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
const keyOf = (name: string, item: Record<string, unknown>) => KEYS[name].map((k) => item[k]).join('|');

function conditionFailed() {
  const e = new Error('The conditional request failed');
  e.name = 'ConditionalCheckFailedException';
  return e;
}

async function fakeSend(cmd: { constructor: { name: string }; input: Record<string, any> }) {
  const i = cmd.input;
  const t = i.TableName ? tbl(i.TableName) : null;
  switch (cmd.constructor.name) {
    case 'GetCommand':
      return { Item: t!.get(keyOf(i.TableName, i.Key)) };
    case 'PutCommand': {
      const k = keyOf(i.TableName, i.Item);
      if (i.ConditionExpression?.startsWith('attribute_not_exists') && t!.has(k)) throw conditionFailed();
      t!.set(k, { ...i.Item });
      return {};
    }
    case 'DeleteCommand':
      t!.delete(keyOf(i.TableName, i.Key));
      return {};
    case 'UpdateCommand': {
      const k = keyOf(i.TableName, i.Key);
      const cur = { ...(t!.get(k) ?? i.Key) } as Record<string, unknown>;
      const v = i.ExpressionAttributeValues ?? {};
      if (i.UpdateExpression.includes('spawn_last_lat')) {
        Object.assign(cur, { spawn_last_lat: v[':lat'], spawn_last_lng: v[':lng'], spawn_last_at: v[':at'] });
      }
      if (v[':gain'] != null) cur.exp = ((cur.exp as number) ?? 0) + v[':gain'];
      t!.set(k, cur);
      return { Attributes: cur };
    }
    case 'QueryCommand':
      return { Items: [] };
    case 'ScanCommand':
      return { Items: [...t!.values()] };
    case 'BatchGetCommand': {
      const Responses: Record<string, unknown[]> = {};
      for (const [name, req] of Object.entries(i.RequestItems as Record<string, { Keys: Record<string, unknown>[] }>)) {
        Responses[name] = req.Keys.map((key) => tbl(name).get(keyOf(name, key))).filter(Boolean) as unknown[];
      }
      return { Responses };
    }
    default:
      throw new Error(`unexpected command ${cmd.constructor.name}`);
  }
}

// ---- 準備 --------------------------------------------------------------------

type Handler = (e: APIGatewayProxyEvent, c: Context, cb: () => void) => Promise<APIGatewayProxyResult>;
let capture: Handler;
let spawns: Handler;
let engine: typeof import('../src/lib/spawn/engine');
let tableFor: import('../src/lib/spawn/engine').TableFor;

const YOKAI = ['y-kappa', 'y-tengu', 'y-yukionna'];

before(async () => {
  (SSMClient.prototype as unknown as { send: unknown }).send = async () => ({ Parameter: { Value: SECRET } });
  const db = await import('../src/lib/dynamodb');
  (db.ddb as unknown as { send: unknown }).send = fakeSend;

  for (const id of YOKAI) {
    tbl('youkai_core').set(id, { yokai_id: id, game_visible: 'true' });
    tbl('kodama_db').set(id, { yokai_id: id, name: id, latitude: 35.0, longitude: 135.0, youryoku: 1, images: [] });
  }
  // 地図には出るが計算配置には出ない固定配置（東京駅の目の前）
  tbl('kodama_db').set('y-fixed', { yokai_id: 'y-fixed', name: '固定', latitude: 35.6812, longitude: 139.7671, youryoku: 1 });

  capture = (await import('../src/handlers/captureYoukai')).handler as unknown as Handler;
  spawns = (await import('../src/handlers/getSpawns')).handler as unknown as Handler;
  engine = await import('../src/lib/spawn/engine');
  const pool = await import('../src/lib/spawn/pool');
  tableFor = (await pool.getSpawnPool()).tableFor;
});

const call = async (h: Handler, e: Partial<APIGatewayProxyEvent>) => {
  const r = await h(e as APIGatewayProxyEvent, {} as Context, () => {});
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const post = (body: unknown) => call(capture, { body: JSON.stringify(body) });

/** 東京駅周辺で、今の時間枠に出現しているものを探す */
function currentSpawnNearTokyo() {
  const hw = engine.hourWindowOf(Date.now() / 1000);
  for (let i = 0; i < 400; i++) {
    const cells = engine.cellsAround(35.68 + i * 0.003, 139.76);
    for (const gh of cells) {
      const s = engine.computeCell(SECRET, gh, hw, tableFor);
      if (s.length) return s[0];
    }
  }
  throw new Error('no spawn');
}

// ---- テスト ------------------------------------------------------------------

test('GET /spawns: 9マス分の計算配置と、範囲内の固定配置を返す', async () => {
  const { status, body } = await call(spawns, { queryStringParameters: { lat: '35.6812', lng: '139.7671', deviceId: '00000000-0000-4000-8000-000000000001' } });
  assert.equal(status, 200);
  const computed = body.spawns.filter((s: { source: string }) => s.source === 'computed');
  const fixed = body.spawns.filter((s: { source: string }) => s.source === 'fixed');
  for (const s of computed) {
    assert.match(s.spawn_id, /^[0-9a-z]{7}:\d+:\d$/);
    assert.ok(YOKAI.includes(s.yokai_id));
    assert.equal(s.captured, false);
    assert.ok(Date.parse(s.expires_at) > Date.now());
  }
  assert.deepEqual(fixed.map((f: { spawn_id: string }) => f.spawn_id), ['fixed:y-fixed']);
  assert.equal(fixed[0].id, 'y-fixed');   // 既存 /youkai の項目をそのまま持つ
  assert.equal(JSON.stringify(body).includes(SECRET), false);
});

test('GET /spawns: lat/lng が無ければ 400', async () => {
  const { status } = await call(spawns, { queryStringParameters: { lat: 'abc' } });
  assert.equal(status, 400);
});

test('POST /capture: 計算配置の捕獲 → 図鑑反映 → 二重取りは ALREADY_CAPTURED', async () => {
  const s = currentSpawnNearTokyo();
  const req = { deviceId: '00000000-0000-4000-8000-000000000002', spawn_id: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 8, actionType: 'seal' };

  const first = await post(req);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.sealed, true);
  assert.equal(first.body.spawn_id, s.spawn_id);
  // 図鑑（既存の youkai-captures）に入っている
  const rec = tbl('captures').get(`00000000-0000-4000-8000-000000000002|${s.yokai_id}`);
  assert.equal(rec?.actionType, 'seal');

  const again = await post(req);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'ALREADY_CAPTURED');

  // /spawns で captured が付く
  const list = await call(spawns, { queryStringParameters: { lat: String(s.lat), lng: String(s.lng), deviceId: '00000000-0000-4000-8000-000000000002' } });
  assert.equal(list.body.spawns.find((x: { spawn_id: string }) => x.spawn_id === s.spawn_id).captured, true);
});

test('POST /capture: 図鑑に既に在る妖怪の出現でも経験値を得る（術力は消費しない）', async () => {
  const s = currentSpawnNearTokyo();
  tbl('captures').set(`00000000-0000-4000-8000-000000000003|${s.yokai_id}`, { deviceId: '00000000-0000-4000-8000-000000000003', youkaiId: s.yokai_id, actionType: 'bond' });
  const r = await post({ deviceId: '00000000-0000-4000-8000-000000000003', spawn_id: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 8, actionType: 'bond', faction: 'supernatural' });
  assert.equal(r.status, 200);
  assert.equal(r.body.already_in_zukan, true);
  assert.equal(r.body.exp_gained, 10);
  assert.equal(tbl('profile').get('00000000-0000-4000-8000-000000000003')?.exp, 10);
  assert.equal(tbl('profile').get('00000000-0000-4000-8000-000000000003')?.jutsu_updated_at, undefined); // 術力の消費（deductJutsu）が走っていない
});

test('POST /capture: 荒魂化していても計算配置は1回で封印できる', async () => {
  const s = currentSpawnNearTokyo();
  tbl('aragami').set(s.yokai_id, { youkaiId: s.yokai_id, youryoku: 3, expires_at: '2999-01-01T00:00:00Z' });
  const r = await post({ deviceId: '00000000-0000-4000-8000-000000000004', spawn_id: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 8 });
  tbl('aragami').delete(s.yokai_id);
  assert.equal(r.status, 200);
  assert.equal(r.body.sealed, true);
  assert.equal(tbl('captures').get(`00000000-0000-4000-8000-000000000004|${s.yokai_id}`)?.actionType, 'seal');
});

test('POST /capture: 術力不足で図鑑に反映できなければ出現は消費しない', async () => {
  const s = currentSpawnNearTokyo();
  tbl('profile').set('00000000-0000-4000-8000-000000000005', { deviceId: '00000000-0000-4000-8000-000000000005', jutsuriyoku: 0, jutsu_updated_at: new Date().toISOString(), rank: 'C' });
  const r = await post({ deviceId: '00000000-0000-4000-8000-000000000005', spawn_id: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 8, actionType: 'bond', faction: 'supernatural' });
  assert.equal(r.status, 402);
  assert.equal(tbl('spawn_captures').has(`00000000-0000-4000-8000-000000000005|${s.spawn_id}`), false);
});

test('POST /capture: 速度異常は SPEED_ANOMALY で拒否し、位置は更新しない', async () => {
  const s = currentSpawnNearTokyo();
  const osaka = { deviceId: '00000000-0000-4000-8000-000000000006', spawn_last_lat: 34.702, spawn_last_lng: 135.495, spawn_last_at: Date.now() - 60_000 };
  tbl('profile').set('00000000-0000-4000-8000-000000000006', { ...osaka });
  const r = await post({ deviceId: '00000000-0000-4000-8000-000000000006', spawn_id: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 8 });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'SPEED_ANOMALY');
  assert.equal(tbl('profile').get('00000000-0000-4000-8000-000000000006')?.spawn_last_lat, osaka.spawn_last_lat);
  assert.equal(tbl('spawn_captures').has(`00000000-0000-4000-8000-000000000006|${s.spawn_id}`), false);
});

test('POST /capture: 距離・精度・slot の拒否理由コード', async () => {
  const s = currentSpawnNearTokyo();
  const base = { deviceId: '00000000-0000-4000-8000-000000000007', spawn_id: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 8 };
  assert.equal((await post({ ...base, lat: s.lat + 0.001 })).body.error, 'TOO_FAR');
  assert.equal((await post({ ...base, accuracy: 120 })).body.error, 'LOW_ACCURACY');
  assert.equal((await post({ ...base, spawn_id: `${s.geohash}:${s.hourWindow}:7` })).body.error, 'INVALID_SPAWN');
  // 2枠前に実在した出現（slot が存在するものを選ばないと INVALID_SPAWN になる）
  const old = engine.cellsAround(s.lat, s.lng)
    .flatMap((gh) => engine.computeCell(SECRET, gh, s.hourWindow - 2, tableFor))[0];
  assert.ok(old, 'no spawn in past window');
  assert.equal((await post({ ...base, spawn_id: old.spawn_id, lat: old.lat, lng: old.lng })).body.error, 'EXPIRED');
});

test('POST /capture: 既存の固定配置の捕獲は従来どおり', async () => {
  const r = await post({ deviceId: '00000000-0000-4000-8000-000000000008', youkaiId: 'y-fixed', userLat: 35.6812, userLon: 139.7671 });
  assert.equal(r.status, 200);
  assert.equal(r.body.sealed, true);
  const far = await post({ deviceId: '00000000-0000-4000-8000-000000000008', youkaiId: 'y-kappa', userLat: 35.6812, userLon: 139.7671 });
  assert.equal(far.status, 403);
  assert.equal(far.body.error, 'Too far');
});

test('端末IDが UUID でなければ 400（HTML を混ぜた ID などを DB に入れない）', async () => {
  const s = currentSpawnNearTokyo();
  for (const deviceId of ['dev-1', '"><img src=x onerror=alert(1)>', '', 'x'.repeat(40)]) {
    const r = await post({ deviceId, spawn_id: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 8 });
    assert.equal(r.status, 400, deviceId);
  }
});

