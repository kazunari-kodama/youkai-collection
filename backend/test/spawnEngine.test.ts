import { test } from 'node:test';
import assert from 'node:assert/strict';
import ngeohash from 'ngeohash';
import {
  buildTable, cellsAround, computeCell, computeSlot, hmac, parseSpawnId, pointInCell,
  spawnCount, weightedPick, windowEndSec, type SpawnCandidate,
} from '../src/lib/spawn/engine';
import { buildCandidates, makeTableFor } from '../src/lib/spawn/pool';
import { prefectureOfGeohash, prefecturesOf } from '../src/lib/spawn/region';
import { validateComputedCapture } from '../src/lib/spawn/validate';
import { speedKmh } from '../src/lib/spawn/movement';
import { SPAWN_CONFIG } from '../src/config/spawn';
import type { YokaiDBItem } from '../src/types/youkai';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const HW = 494213;

const CANDIDATES: SpawnCandidate[] = [
  { yokai_id: 'common-a', rarity: 'common', prefectures: ['東京都'] },
  { yokai_id: 'common-b', rarity: 'common', prefectures: ['福島県'] },
  { yokai_id: 'uncommon-a', rarity: 'uncommon', prefectures: [] },
  { yokai_id: 'rare-a', rarity: 'rare', prefectures: [] },
  { yokai_id: 'legend-a', rarity: 'legendary', prefectures: ['東京都'] },
];
const tableFor = makeTableFor(CANDIDATES);

/** n 個の相異なる7桁 geohash を決定的に作る */
function sampleCells(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const lat = 24 + ((i * 0.0137) % 21);
    const lng = 123 + ((i * 0.0291) % 23);
    out.push(ngeohash.encode(lat, lng, 7));
  }
  return [...new Set(out)];
}

// ---- 決定性 ---------------------------------------------------------------

test('同じ geohash7 と hourWindow なら何度計算しても同じ結果', () => {
  for (const gh of ['xn76urx', 'xnetw4p', 'xnuxs2b']) {
    const a = computeCell(SECRET, gh, HW, tableFor);
    for (let i = 0; i < 5; i++) assert.deepEqual(computeCell(SECRET, gh, HW, makeTableFor([...CANDIDATES].reverse())), a);
  }
});

test('秘密の値・時間枠が変わると結果が変わる', () => {
  const cells = sampleCells(200);
  const base = cells.map((gh) => JSON.stringify(computeCell(SECRET, gh, HW, tableFor)));
  const otherSecret = cells.map((gh) => JSON.stringify(computeCell(SECRET + 'x', gh, HW, tableFor)));
  const otherHour = cells.map((gh) => JSON.stringify(computeCell(SECRET, gh, HW + 1, tableFor)));
  assert.ok(base.filter((b, i) => b !== otherSecret[i]).length > 100);
  assert.ok(base.filter((b, i) => b !== otherHour[i]).length > 100);
});

// ---- 分布 -----------------------------------------------------------------

test('10万マスで平均体数 1.0±0.02、0体の割合 25% 前後', () => {
  const N = 100_000;
  let total = 0;
  let zero = 0;
  for (let i = 0; i < N; i++) {
    // マス名は分布に影響しないので、10万個の別キーとして連番を使う
    const c = spawnCount(SECRET, `cell${i}`, HW);
    total += c;
    if (c === 0) zero++;
  }
  const mean = total / N;
  assert.ok(Math.abs(mean - 1) <= 0.02, `mean=${mean}`);
  assert.ok(Math.abs(zero / N - 0.25) <= 0.01, `zero=${zero / N}`);
});

test('座標と抽選は seed の別のバイトから取る（座標が抽選結果と連動しない）', () => {
  const seed = hmac(SECRET, 'xn76urx:1:0');
  const altered = Buffer.from(seed);
  altered.writeUInt32BE(0, 8); // 抽選用だけ変える
  assert.deepEqual(pointInCell('xn76urx', seed), pointInCell('xn76urx', altered));
});

// ---- 座標 -----------------------------------------------------------------

test('出現座標は必ずマスの内側（外周10%を除いた範囲）', () => {
  const m = SPAWN_CONFIG.CELL_EDGE_MARGIN;
  let checked = 0;
  for (const gh of sampleCells(5000)) {
    const [minLat, minLng, maxLat, maxLng] = ngeohash.decode_bbox(gh);
    const dLat = (maxLat - minLat) * m;
    const dLng = (maxLng - minLng) * m;
    for (const s of computeCell(SECRET, gh, HW, tableFor)) {
      assert.ok(s.lat >= minLat + dLat && s.lat <= maxLat - dLat, `${gh} lat`);
      assert.ok(s.lng >= minLng + dLng && s.lng <= maxLng - dLng, `${gh} lng`);
      assert.equal(ngeohash.encode(s.lat, s.lng, 7), gh);
      checked++;
    }
  }
  assert.ok(checked > 3000);
});

test('cellsAround は中心と周囲8マスの9マス', () => {
  const cells = cellsAround(35.681, 139.767);
  assert.equal(cells.length, 9);
  assert.equal(new Set(cells).size, 9);
  assert.equal(cells[0], ngeohash.encode(35.681, 139.767, 7));
});

// ---- 抽選 -----------------------------------------------------------------

test('legendary は計算配置に出ない', () => {
  const picked = new Set<string>();
  for (const gh of sampleCells(20000)) for (const s of computeCell(SECRET, gh, HW, tableFor)) picked.add(s.yokai_id);
  assert.ok(!picked.has('legend-a'));
  assert.ok(picked.has('common-a') && picked.has('common-b'));
  // 抽選表にも載らない
  assert.ok(!buildTable(CANDIDATES, { prefecture: '東京都', hourWindow: HW }).some((e) => e.yokai_id === 'legend-a'));
});

test('計算配置は common だけ（雑魚妖怪）', () => {
  const picked = new Set<string>();
  for (const gh of sampleCells(20000)) for (const s of computeCell(SECRET, gh, HW, tableFor)) picked.add(s.yokai_id);
  assert.deepEqual([...picked].sort(), ['common-a', 'common-b']);
});

test('レア度の重みと地域の倍率', () => {
  const table = buildTable(CANDIDATES, { prefecture: '東京都', hourWindow: HW });
  const w = Object.fromEntries(table.map((e) => [e.yokai_id, e.weight]));
  const W = SPAWN_CONFIG.RARITY_WEIGHTS;
  assert.equal(w['common-a'], W.common * SPAWN_CONFIG.REGION_MATCH_MULTIPLIER);
  assert.equal(w['common-b'], W.common);
  assert.equal(w['uncommon-a'], W.uncommon || undefined);
  assert.equal(w['rare-a'], W.rare || undefined);
  const none = buildTable(CANDIDATES, { prefecture: null, hourWindow: HW });
  assert.equal(none.find((e) => e.yokai_id === 'common-a')?.weight, 60);
});

test('weightedPick の分布はおおむね重みどおり', () => {
  const table = [{ yokai_id: 'a', weight: 60 }, { yokai_id: 'b', weight: 28 }, { yokai_id: 'c', weight: 12 }];
  const n = { a: 0, b: 0, c: 0 } as Record<string, number>;
  for (let i = 0; i < 50_000; i++) n[weightedPick(table, hmac(SECRET, `p${i}`))!]++;
  assert.ok(Math.abs(n.a / 50_000 - 0.6) < 0.01);
  assert.ok(Math.abs(n.b / 50_000 - 0.28) < 0.01);
  assert.ok(Math.abs(n.c / 50_000 - 0.12) < 0.01);
  assert.equal(weightedPick([], hmac(SECRET, 'x')), null);
});

test('buildCandidates: 迷霊（妖力1）の common だけ。kodama_db に無いもの・ラリー・QR を除く', () => {
  const core = [
    { yokai_id: 'k1' }, { yokai_id: 'k2' }, { yokai_id: 'core-only' },
    { yokai_id: 'rally', rally_key: 'x' }, { yokai_id: 'qr' }, { yokai_id: 'leg', rarity: 'legendary' },
    { yokai_id: 'rare', rarity: 'rare' }, { yokai_id: 'strong' },
  ];
  const kodama = [
    { yokai_id: 'k1', prefecture: '福島県', regions: ['会津'], youryoku: 1 },
    { yokai_id: 'k2', regions: ['熊本県多良木町'] },
    { yokai_id: 'rally' }, { yokai_id: 'qr', require_qr: true }, { yokai_id: 'leg' },
    { yokai_id: 'rare', youryoku: 1 }, { yokai_id: 'strong', youryoku: 2 },
  ] as unknown as YokaiDBItem[];
  const c = buildCandidates(core, kodama);
  assert.deepEqual(c.map((x) => x.yokai_id), ['k1', 'k2']);
  assert.equal(c[0].rarity, 'common');
  assert.deepEqual(c[0].prefectures, ['福島県']);
  assert.deepEqual(c[1].prefectures, ['熊本県']);
});

// ---- 地域対応表 -----------------------------------------------------------

test('地域対応表のサンプル', () => {
  const pref = (lat: number, lng: number) => prefectureOfGeohash(ngeohash.encode(lat, lng, 7));
  assert.equal(pref(35.681, 139.767), '東京都');   // 東京駅
  assert.equal(pref(37.508, 139.931), '福島県');   // 会津若松駅
  assert.equal(pref(39.327, 141.533), '岩手県');   // 遠野駅
  assert.equal(pref(30.0, 150.0), null);            // 太平洋上
});

test('prefecturesOf は略称で誤一致しない', () => {
  assert.deepEqual(prefecturesOf('東京都', ['京都']), ['東京都']);
  assert.deepEqual(prefecturesOf(undefined, ['京都府の山中']), ['京都府']);
  assert.deepEqual(prefecturesOf(undefined, null), []);
});

// ---- 捕獲の検証（純粋関数部分） -------------------------------------------

/** 指定時間枠で出現が1体以上あるマスと、その最初の出現を探す */
function findSpawn(hw: number) {
  for (const gh of sampleCells(1000)) {
    const cell = computeCell(SECRET, gh, hw, tableFor);
    if (cell.length) return cell[0];
  }
  throw new Error('no spawn');
}

test('正しい捕獲は通る（猶予内も通る）', () => {
  const s = findSpawn(HW);
  const input = { spawnId: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 10 };
  const midWindow = windowEndSec(HW) - 1800;
  const r = validateComputedCapture(SECRET, input, tableFor, midWindow);
  assert.ok(r.ok);
  assert.equal(r.ok && r.spawn.yokai_id, s.yokai_id);
  assert.ok(validateComputedCapture(SECRET, input, tableFor, windowEndSec(HW) + 119).ok);
});

test('期限切れ: 終了後2分を過ぎたら EXPIRED', () => {
  const s = findSpawn(HW);
  const r = validateComputedCapture(SECRET, { spawnId: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 10 },
    tableFor, windowEndSec(HW) + 121);
  assert.deepEqual(r, { ok: false, code: 'EXPIRED' });
});

test('距離超過: TOO_FAR', () => {
  const s = findSpawn(HW);
  const r = validateComputedCapture(SECRET, { spawnId: s.spawn_id, lat: s.lat + 0.0005, lng: s.lng, accuracy: 10 },
    tableFor, windowEndSec(HW) - 60);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'TOO_FAR');
});

test('精度不足: 50m 超・未指定は LOW_ACCURACY', () => {
  const s = findSpawn(HW);
  for (const accuracy of [50.1, 200, undefined, -1, 'x']) {
    const r = validateComputedCapture(SECRET, { spawnId: s.spawn_id, lat: s.lat, lng: s.lng, accuracy },
      tableFor, windowEndSec(HW) - 60);
    assert.deepEqual(r, { ok: false, code: 'LOW_ACCURACY' }, String(accuracy));
  }
  assert.ok(validateComputedCapture(SECRET, { spawnId: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 50 },
    tableFor, windowEndSec(HW) - 60).ok);
});

test('存在しない slot・不正な形式・未来の時間枠・妖怪の食い違いは INVALID_SPAWN', () => {
  const now = windowEndSec(HW) - 60;
  // count 未満の slot しか存在しない
  for (const gh of sampleCells(50)) {
    const count = spawnCount(SECRET, gh, HW);
    const [lat, lng] = [ngeohash.decode(gh).latitude, ngeohash.decode(gh).longitude];
    const r = validateComputedCapture(SECRET, { spawnId: `${gh}:${HW}:${count}`, lat, lng, accuracy: 5 }, tableFor, now);
    assert.deepEqual(r, { ok: false, code: 'INVALID_SPAWN' });
  }
  const s = findSpawn(HW);
  const bad = ['', 'xn76urx', 'xn76ur:1:0', 'xn76urxa:1:0', 'xn76urx:1:10', 'xn76uri:1:0', `${s.geohash}:-1:0`, 42, null];
  for (const spawnId of bad) {
    assert.deepEqual(validateComputedCapture(SECRET, { spawnId, lat: s.lat, lng: s.lng, accuracy: 5 }, tableFor, now),
      { ok: false, code: 'INVALID_SPAWN' }, String(spawnId));
  }
  const future = findSpawn(HW + 1);
  assert.deepEqual(validateComputedCapture(SECRET, { spawnId: future.spawn_id, lat: future.lat, lng: future.lng, accuracy: 5 },
    tableFor, now), { ok: false, code: 'INVALID_SPAWN' });
  assert.deepEqual(validateComputedCapture(SECRET, { spawnId: s.spawn_id, lat: s.lat, lng: s.lng, accuracy: 5, yokaiId: 'other' },
    tableFor, now), { ok: false, code: 'INVALID_SPAWN' });
});

test('parseSpawnId', () => {
  assert.deepEqual(parseSpawnId('xn76urx:494213:0'), { geohash: 'xn76urx', hourWindow: 494213, slot: 0 });
  assert.equal(parseSpawnId('fixed:abc'), null);
});

test('computeSlot と computeCell は同じ出現を返す', () => {
  const s = findSpawn(HW);
  assert.deepEqual(computeSlot(SECRET, s.geohash, HW, s.slot, tableFor), s);
});

// ---- 移動速度 -------------------------------------------------------------

test('speedKmh: 徒歩は通り、東京→大阪を1分は異常', () => {
  const t0 = 1_000_000_000_000;
  const tokyo = { lat: 35.681, lng: 139.767, atMs: t0 };
  assert.ok(speedKmh(tokyo, 35.6815, 139.767, t0 + 60_000) < 10);
  assert.ok(speedKmh(tokyo, 34.702, 135.495, t0 + 60_000) > SPAWN_CONFIG.MAX_SPEED_KMH);
  // GPS の揺らぎ（100m 以内）は時間が短くても 0
  assert.equal(speedKmh(tokyo, 35.6815, 139.767, t0 + 1), 0);
  // 新幹線（約 280km/h 相当の区間平均）でも 2時間空けば通る
  assert.ok(speedKmh(tokyo, 34.702, 135.495, t0 + 2 * 3600_000) < SPAWN_CONFIG.MAX_SPEED_KMH);
});
