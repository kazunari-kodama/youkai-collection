#!/usr/bin/env node
/**
 * 地域対応表（geohash 4桁 → 都道府県名）を生成する。
 *
 * 出典: 国土数値情報（行政区域データ N03）（国土交通省）
 *       https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2024.html
 *       使用許諾条件: オープンデータ（CC BY 4.0）
 *       本スクリプトの出力 region-map.json は上記データを加工して作成したもの。
 *
 * 使い方（手順の詳細は同じフォルダの README.md）:
 *   node --max-old-space-size=4096 scripts/build-region-map/index.mjs <N03 GeoJSON のフォルダ> [出力先]
 *   出力先の既定値: backend/src/data/region-map.json
 *
 * 判定方法:
 *   - 北緯20〜46度・東経122〜154度に中心がある geohash 4桁（約40km四方）を対象とする
 *   - マス中心点が含まれる都道府県を採用する
 *   - 中心点が海上なら、マス内 3×3 の9点のうち最多の都道府県を採用する（同数は名前順で先のもの）
 *   - それでも該当なしのマスは出力に含めない（参照側は「無い = null」として扱う）
 *
 * 依存パッケージなし。N03 の属性 N03_001（都道府県名）を使う。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(__dirname, '../../backend/src/data/region-map.json');

const BOUNDS = { minLat: 20, maxLat: 46, minLng: 122, maxLng: 154 };
const PRECISION = 4;
const NAME_PROP = 'N03_001';
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

// ---- geohash（ngeohash と同じ標準アルゴリズム） -----------------------------

function decodeBbox(hash) {
  let isLng = true;
  let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180;
  for (const ch of hash) {
    const v = BASE32.indexOf(ch);
    for (let bit = 4; bit >= 0; bit--) {
      const b = (v >> bit) & 1;
      if (isLng) {
        const mid = (minLng + maxLng) / 2;
        if (b) minLng = mid; else maxLng = mid;
      } else {
        const mid = (minLat + maxLat) / 2;
        if (b) minLat = mid; else maxLat = mid;
      }
      isLng = !isLng;
    }
  }
  return [minLat, minLng, maxLat, maxLng];
}

function* allHashes(len, prefix = '') {
  if (prefix.length === len) { yield prefix; return; }
  for (const ch of BASE32) yield* allHashes(len, prefix + ch);
}

// ---- サンプル点 -----------------------------------------------------------

/** マス内 3×3 の点。index 0 が中心 */
function samplePoints([minLat, minLng, maxLat, maxLng]) {
  const fr = [0.5, 1 / 6, 5 / 6];
  const pts = [];
  for (const fy of fr) {
    for (const fx of fr) {
      pts.push([minLat + (maxLat - minLat) * fy, minLng + (maxLng - minLng) * fx]);
    }
  }
  return pts; // [0] = (0.5, 0.5)
}

const cells = [];      // { hash, pts: [[lat,lng]...], hits: (string|null)[] }
for (const hash of allHashes(PRECISION)) {
  const bbox = decodeBbox(hash);
  const cLat = (bbox[0] + bbox[2]) / 2;
  const cLng = (bbox[1] + bbox[3]) / 2;
  if (cLat < BOUNDS.minLat || cLat > BOUNDS.maxLat || cLng < BOUNDS.minLng || cLng > BOUNDS.maxLng) continue;
  const pts = samplePoints(bbox);
  cells.push({ hash, pts, hits: new Array(pts.length).fill(null) });
}

// 点の空間インデックス（0.25度のバケツ）
const BUCKET = 0.25;
const bucketKey = (lat, lng) => `${Math.floor(lat / BUCKET)}:${Math.floor(lng / BUCKET)}`;
const buckets = new Map();
cells.forEach((cell, ci) => {
  cell.pts.forEach(([lat, lng], pi) => {
    const k = bucketKey(lat, lng);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push([ci, pi]);
  });
});

function pointsInBbox(minLat, minLng, maxLat, maxLng) {
  const out = [];
  for (let y = Math.floor(minLat / BUCKET); y <= Math.floor(maxLat / BUCKET); y++) {
    for (let x = Math.floor(minLng / BUCKET); x <= Math.floor(maxLng / BUCKET); x++) {
      const b = buckets.get(`${y}:${x}`);
      if (!b) continue;
      for (const ref of b) {
        const [lat, lng] = cells[ref[0]].pts[ref[1]];
        if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) out.push(ref);
      }
    }
  }
  return out;
}

// ---- 多角形判定 -----------------------------------------------------------

/** ring: [[lng, lat], ...]（GeoJSON の順） */
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringBbox(ring) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lng, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return [minLat, minLng, maxLat, maxLng];
}

function applyPolygon(rings, pref) {
  const [outer, ...holes] = rings;
  if (!outer || outer.length < 4) return;
  for (const [ci, pi] of pointsInBbox(...ringBbox(outer))) {
    const cell = cells[ci];
    if (cell.hits[pi]) continue;
    const [lat, lng] = cell.pts[pi];
    if (!inRing(lat, lng, outer)) continue;
    if (holes.some((h) => inRing(lat, lng, h))) continue;
    cell.hits[pi] = pref;
  }
}

// ---- 実行 -----------------------------------------------------------------

const inputDir = process.argv[2];
const outPath = path.resolve(process.argv[3] ?? DEFAULT_OUT);
if (!inputDir) {
  console.error('usage: node scripts/build-region-map/index.mjs <N03 GeoJSON folder> [output]');
  process.exit(1);
}

const files = fs.readdirSync(inputDir)
  .filter((f) => f.endsWith('.geojson') && !f.includes('subprefecture'))
  .sort();
if (!files.length) {
  console.error(`GeoJSON が見つかりません: ${inputDir}`);
  process.exit(1);
}

const prefsSeen = new Set();
for (const f of files) {
  const gj = JSON.parse(fs.readFileSync(path.join(inputDir, f), 'utf8'));
  let n = 0;
  for (const feat of gj.features ?? []) {
    const pref = feat.properties?.[NAME_PROP];
    const g = feat.geometry;
    if (!pref || !g) continue;
    prefsSeen.add(pref);
    if (g.type === 'Polygon') applyPolygon(g.coordinates, pref);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => applyPolygon(p, pref));
    n++;
  }
  console.log(`${f}: ${n} features`);
}

const map = {};
let byCenter = 0, byMajority = 0;
for (const cell of cells) {
  if (cell.hits[0]) { map[cell.hash] = cell.hits[0]; byCenter++; continue; }
  const counts = new Map();
  for (const p of cell.hits) if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  if (!counts.size) continue;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
  map[cell.hash] = best[0];
  byMajority++;
}

const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(sorted) + '\n');

console.log(`prefectures: ${prefsSeen.size}`);
console.log(`cells: ${cells.length} scanned, ${byCenter} by center, ${byMajority} by 9-point majority, ${cells.length - byCenter - byMajority} null (omitted)`);
console.log(`wrote ${outPath}`);
