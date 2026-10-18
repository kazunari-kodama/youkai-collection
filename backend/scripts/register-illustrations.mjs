/**
 * イラストレーターから納品された妖怪イラストを、ゲーム（kodama_db）に新しい妖怪として登録する。
 *
 * 入力:
 *   - 納品管理表 zenkokuka-candidates/illustration-deliveries.csv
 *       no, yokai_id(先頭8桁可), name, kana, credit, status(検収済/未検収), youryoku,
 *       file_hint（ファイル名の手がかり。| 区切り、= で始まるものはファイル名の完全一致）,
 *       file（ファイルを直接指定する場合のパス。「ダウンロード」からの相対パス可）, note,
 *       lat, lon, pref, place（配置データの座標・県・地名が伝承地とずれているときの上書き）
 *   - 配置データ zenkokuka-candidates/placement.json（道路にスナップ済みの座標）
 *   - youkai_core（伝承文）
 *   - 納品ファイル（既定はユーザーの「ダウンロード」フォルダを3階層まで探す）
 *
 * 処理（--apply のときだけ書き込む）:
 *   1. 画像をカメラ用 PNG（長辺1500px以内）とマーカー用サムネ（144px webp）に変換し S3 に置く
 *        youkai/<yokai_id>_camera.png / thumbs/<yokai_id>_camera.webp
 *   2. kodama_db に妖怪を登録（既に在れば --force が無い限り触らない）
 *   3. youkai_core に game_visible=true とクレジット（illustrator）を付ける
 *
 * 実行（backend/ から）:
 *   node scripts/register-illustrations.mjs                 # 確認だけ（ファイルの有無・サイズ・透過）
 *   node scripts/register-illustrations.mjs --apply         # 検収済みで、ファイルが1つに決まるものを登録
 *   node scripts/register-illustrations.mjs --apply --only 295,224
 *   オプション: --downloads <dir>  --manifest <csv>  --placement <json>  --force
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK_DIR = path.resolve(__dirname, '../../../zenkokuka-candidates');

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const BUCKET = process.env.IMAGES_BUCKET ?? 'youkai-collection-images';
const YOUKAI_TABLE = process.env.YOUKAI_TABLE ?? 'kodama_db';
const CORE_TABLE = process.env.CORE_TABLE ?? 'youkai_core';
// adminUploadUrl.ts / generate-thumbs.mjs と揃える
const CACHE_CONTROL = 'public, max-age=604800';
const CAMERA_MAX = 1500;
const THUMB_SIZE = 144;
const MIN_SIDE = 1024;          // 仕様書の許容下限
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const EXCLUDE = ['サインあり', 'サイン有', 'ラフ', '不採用', '__MACOSX'];

// ---- 引数 -------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const ONLY = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : null;
const MANIFEST = opt('--manifest', path.join(WORK_DIR, 'illustration-deliveries.csv'));
const PLACEMENT = opt('--placement', path.join(WORK_DIR, 'placement.json'));
const DOWNLOADS = opt('--downloads', path.join(os.homedir(), 'Downloads'));

// ---- CSV --------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, '').trim(), (r[i] ?? '').trim()])));
}

// ---- ファイル探し -------------------------------------------------------------

const nfc = (s) => s.normalize('NFC');

function walk(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else out.push(p);
  }
  return out;
}

const ALL_FILES = walk(DOWNLOADS).map((p) => ({ path: p, base: nfc(path.basename(p)), rel: nfc(path.relative(DOWNLOADS, p)) }));

function findFiles(hint) {
  const tokens = hint.split('|').map((t) => nfc(t.trim())).filter(Boolean);
  const match = (f) => tokens.some((t) => (t.startsWith('=') ? f.base === t.slice(1) : f.rel.includes(t)));
  const images = ALL_FILES.filter((f) => IMAGE_EXT.test(f.base) && match(f) && !EXCLUDE.some((x) => f.rel.includes(x)));
  const zips = ALL_FILES.filter((f) => /\.zip$/i.test(f.base) && match(f));
  return { images, zips };
}

// ---- 画像の確認 ---------------------------------------------------------------

async function inspect(file) {
  const img = sharp(file);
  const meta = await img.metadata();
  let transparentRatio = 0;
  if (meta.hasAlpha) {
    const { data, info } = await sharp(file).resize(256, 256, { fit: 'inside' })
      .ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    let n = 0;
    for (const a of data) if (a < 16) n++;
    transparentRatio = n / (info.width * info.height);
  }
  const problems = [];
  if (Math.min(meta.width, meta.height) < MIN_SIDE) problems.push(`小さい(${meta.width}x${meta.height})`);
  if (!meta.hasAlpha || transparentRatio < 0.05) problems.push('背景が透過していない');
  if (Math.abs(meta.width - meta.height) > Math.max(meta.width, meta.height) * 0.05) problems.push('正方形でない');
  return { width: meta.width, height: meta.height, format: meta.format, transparentRatio, problems };
}

// ---- 実行 ---------------------------------------------------------------------

const s3 = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const manifest = parseCsv(fs.readFileSync(MANIFEST, 'utf8'));
const placement = JSON.parse(fs.readFileSync(PLACEMENT, 'utf8')).records;

function resolvePlacement(idPrefix) {
  const hits = placement.filter((r) => r.yokai_id.startsWith(idPrefix));
  if (hits.length !== 1) throw new Error(`placement.json で yokai_id ${idPrefix} が ${hits.length} 件`);
  return hits[0];
}

const cleanName = (s) => s.replace(/^★/, '').trim();
const cleanNotes = (s) => (s ?? '').replace(/^\[[^\]]*\]\s*/, '').trim();

async function register(row, pl, file) {
  const id = pl.yokai_id;
  const existing = (await ddb.send(new GetCommand({ TableName: YOUKAI_TABLE, Key: { yokai_id: id } }))).Item;
  if (existing && !FORCE) return '登録済みのためスキップ（--force で上書き）';

  const core = (await ddb.send(new GetCommand({ TableName: CORE_TABLE, Key: { yokai_id: id } }))).Item;
  if (!core) throw new Error('youkai_core に無い');

  const camera = await sharp(file).rotate()
    .resize(CAMERA_MAX, CAMERA_MAX, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const thumb = await sharp(camera)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 }).toBuffer();
  const cameraKey = `youkai/${id}_camera.png`;
  const thumbKey = `thumbs/${id}_camera.webp`;

  if (!APPLY) return `（確認のみ）camera ${(camera.length / 1024).toFixed(0)}KB / thumb ${(thumb.length / 1024).toFixed(1)}KB`;

  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: cameraKey, Body: camera, ContentType: 'image/png', CacheControl: CACHE_CONTROL }));
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: thumbKey, Body: thumb, ContentType: 'image/webp', CacheControl: CACHE_CONTROL }));

  const notes = cleanNotes(core.notes) || cleanNotes(pl.notes);
  const item = {
    ...(existing ?? {}),
    yokai_id: id,
    name: cleanName(core.name ?? row.name),
    ...(row.kana ? { kana: row.kana } : {}),
    notes,
    appearance: notes,
    latitude: row.lat ? Number(row.lat) : pl.lat,
    longitude: row.lon ? Number(row.lon) : pl.lon,
    prefecture: row.pref || pl.pref,
    regions: [row.place || pl.place || row.pref || pl.pref],
    region_detail: `${row.pref || pl.pref}${row.place || pl.place || ''}`,
    youryoku: Number(row.youryoku) || 2,
    images: [cameraKey],
    image_types: ['camera'],
    image_captions: [`絵：${row.credit}`],
    illustrator: row.credit,
  };
  await ddb.send(new PutCommand({
    TableName: YOUKAI_TABLE,
    Item: item,
    ...(FORCE ? {} : { ConditionExpression: 'attribute_not_exists(yokai_id)' }),
  }));
  await ddb.send(new UpdateCommand({
    TableName: CORE_TABLE,
    Key: { yokai_id: id },
    UpdateExpression: 'SET game_visible = :t, illustrator = :c, updated_at = :now',
    ExpressionAttributeValues: { ':t': 'true', ':c': row.credit, ':now': new Date().toISOString() },
  }));
  return `登録しました（${item.name} @ ${item.latitude},${item.longitude}）`;
}

console.log(`manifest: ${MANIFEST}\ndownloads: ${DOWNLOADS}（${ALL_FILES.length}ファイル）\nmode: ${APPLY ? 'APPLY（書き込みあり）' : '確認のみ'}\n`);

let done = 0;
for (const row of manifest) {
  if (ONLY && !ONLY.has(row.no)) continue;
  const label = `No.${row.no} ${row.name}（${row.credit}）`;
  let pl;
  try { pl = resolvePlacement(row.yokai_id); } catch (e) { console.log(`✗ ${label}: ${e.message}`); continue; }

  // file 列は「ダウンロード」からの相対パスでも絶対パスでもよい
  let file = row.file ? path.resolve(DOWNLOADS, row.file) : null;
  let candidates = [];
  if (!file) {
    const { images, zips } = findFiles(row.file_hint || row.name);
    candidates = images;
    if (images.length === 1) file = images[0].path;
    else if (!images.length) {
      console.log(`… ${label}: ファイル未着${zips.length ? `（zip あり、展開が必要: ${zips.map((z) => z.rel).join(', ')}）` : ''}`);
      continue;
    }
  }

  if (!file) {
    console.log(`? ${label}: 候補が ${candidates.length} 件。file 列で指定してください`);
    for (const c of candidates) {
      const r = await inspect(c.path).catch(() => null);
      console.log(`    - ${c.rel}  ${r ? `${r.width}x${r.height} 透過${(r.transparentRatio * 100).toFixed(0)}%` : ''}`);
    }
    continue;
  }

  const info = await inspect(file);
  const spec = `${info.width}x${info.height} ${info.format} 透過${(info.transparentRatio * 100).toFixed(0)}%`;
  const warn = info.problems.length ? ` ⚠ ${info.problems.join('・')}` : '';
  if (row.status !== '検収済') {
    console.log(`- ${label}: ${row.status}のため登録しない [${path.relative(DOWNLOADS, file)} ${spec}]${warn}`);
    continue;
  }
  try {
    const msg = await register(row, pl, file);
    console.log(`✓ ${label}: ${msg} [${path.relative(DOWNLOADS, file)} ${spec}]${warn}`);
    done++;
  } catch (e) {
    console.log(`✗ ${label}: ${e.message}`);
  }
}
console.log(`\n${APPLY ? '登録' : '登録可能'}: ${done} 件`);
