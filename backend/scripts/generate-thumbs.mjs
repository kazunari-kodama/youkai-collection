/**
 * youkai/*.png（カメラ用フル解像度画像、平均 453KB）から
 * thumbs/*.webp（マーカー用 144px、数KB）を生成して S3 にアップロードする。
 *
 * マーカーは 44x44 CSS px で描画されるので 144px あれば 3x Retina まで耐える。
 *
 * 実行: node scripts/generate-thumbs.mjs [--dry-run] [--force]  (backend/ から実行)
 *   --dry-run  アップロードせず対象と削減量だけ表示
 *   --force    既存の thumbs/ を無視して全件再生成
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const BUCKET = process.env.IMAGES_BUCKET ?? 'youkai-collection-images';
const SRC_PREFIX = 'youkai/';
const DST_PREFIX = 'thumbs/';
const THUMB_SIZE = 144;
const WEBP_QUALITY = 80;
// 同じキーに差し替えアップロードされうるので immutable にはしない。
// adminUploadUrl.ts の IMAGE_CACHE_CONTROL と揃えること。
const CACHE_CONTROL = 'public, max-age=604800';
const CONCURRENCY = 8;

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

const s3 = new S3Client({ region: REGION });

/** camera key "youkai/xxx_camera.png" → thumb key "thumbs/xxx_camera.webp" */
export function toThumbKey(cameraKey) {
  const base = cameraKey.slice(SRC_PREFIX.length).replace(/\.[^.]+$/, '');
  return `${DST_PREFIX}${base}.webp`;
}

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    out.push(...(res.Contents ?? []));
    token = res.NextContinuationToken;
  } while (token);
  return out;
}

async function processOne(obj) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
  const input = Buffer.from(await res.Body.transformToByteArray());

  // マーカー側 CSS は object-fit: contain なので、切り抜かず長辺 144px に収める
  const output = await sharp(input)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  const dstKey = toThumbKey(obj.Key);
  if (!dryRun) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: dstKey,
      Body: output,
      ContentType: 'image/webp',
      CacheControl: CACHE_CONTROL,
    }));
  }
  return { src: obj.Key, dst: dstKey, before: obj.Size, after: output.length };
}

async function main() {
  const sources = (await listAll(SRC_PREFIX)).filter(
    (o) => /\.(png|jpe?g|webp)$/i.test(o.Key) && o.Size > 0,
  );
  console.log(`[thumbs] source images: ${sources.length}`);

  let targets = sources;
  if (!force) {
    const existing = new Set((await listAll(DST_PREFIX)).map((o) => o.Key));
    targets = sources.filter((o) => !existing.has(toThumbKey(o.Key)));
    console.log(`[thumbs] already generated: ${existing.size} / to generate: ${targets.length}`);
  }
  if (targets.length === 0) {
    console.log('[thumbs] nothing to do');
    return;
  }
  if (dryRun) console.log('[dry-run] no uploads will be performed');

  const results = [];
  const failures = [];
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const obj = queue.shift();
        try {
          const r = await processOne(obj);
          results.push(r);
          const pct = ((1 - r.after / r.before) * 100).toFixed(1);
          console.log(
            `  ✓ ${r.src} ${(r.before / 1024).toFixed(0)}KB → ${(r.after / 1024).toFixed(1)}KB (-${pct}%)`,
          );
        } catch (e) {
          failures.push({ key: obj.Key, error: e.message });
          console.error(`  ✗ ${obj.Key}: ${e.message}`);
        }
      }
    }),
  );

  const before = results.reduce((s, r) => s + r.before, 0);
  const after = results.reduce((s, r) => s + r.after, 0);
  console.log(
    `\n[thumbs] done: ${results.length} generated, ${failures.length} failed\n` +
    `  ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(2)} MB ` +
    `(${(before / after).toFixed(0)}x smaller, avg ${(after / results.length / 1024).toFixed(1)} KB)`,
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
