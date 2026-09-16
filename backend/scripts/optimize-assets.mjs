/**
 * assets-src/images/ の原寸画像から frontend/assets/images/ の配信用画像を生成する。
 *
 * 原寸は 1024〜2266px あるのに UI では 36〜130px でしか描画しておらず、
 * assets だけで 23.4MB あった。イントロ背景 6.3MB と hitodama 2.5MB は
 * 初回表示の前に落ちてくるため、モバイル回線での起動が極端に遅かった。
 *
 * targetEdge は「CSS 上の表示サイズ × 3（3x Retina）」を基準に決めている。
 * 生成物は frontend/ 配下なのでコミット対象。原寸は assets-src/ に置き、
 * デプロイ（aws s3 sync frontend/）には含めない。
 *
 * 実行: node scripts/optimize-assets.mjs [--dry-run]  (backend/ から実行)
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../assets-src/images');
const DST = path.resolve(HERE, '../../frontend/assets/images');

const dryRun = process.argv.includes('--dry-run');

/** @type {{src:string,out:string,edge:number,format:'webp'|'png',note:string}[]} */
const MANIFEST = [
  // イントロ全画面背景（cover）。デスクトップ1920px幅まで耐える
  { src: 'background.png', out: 'background.webp', edge: 1920, format: 'webp', note: 'intro cover' },

  // 未封印マーカー 36px枠 / 荒神マーカー 36px枠
  { src: 'hitodama.png', out: 'hitodama.webp', edge: 144, format: 'webp', note: '36px marker' },
  { src: 'aratama.png', out: 'aratama.webp', edge: 144, format: 'webp', note: '36px marker' },
  // favicon は互換性重視で PNG のまま
  { src: 'hitodama.png', out: 'favicon.png', edge: 64, format: 'png', note: 'favicon' },

  // 封印演出の護符 130x178枠
  { src: 'seal/ofuda-seal.png', out: 'seal/ofuda-seal.webp', edge: 534, format: 'webp', note: '130x178' },
  { src: 'seal/ofuda-break.png', out: 'seal/ofuda-break.webp', edge: 534, format: 'webp', note: '130x178' },
  { src: 'seal/ofuda-summon-active.png', out: 'seal/ofuda-summon-active.webp', edge: 534, format: 'webp', note: '130x178' },

  // サイドナビ 52px枠
  { src: 'nav/collection.png', out: 'nav/collection.webp', edge: 156, format: 'webp', note: '52px' },
  { src: 'nav/skills.png', out: 'nav/skills.webp', edge: 156, format: 'webp', note: '52px' },
  { src: 'nav/rally.png', out: 'nav/rally.webp', edge: 156, format: 'webp', note: '52px' },
  { src: 'nav/academic.png', out: 'nav/academic.webp', edge: 156, format: 'webp', note: '52px' },

  // スキル系マーカー 最大 44x60枠
  { src: 'markers/kekkai-stone.png', out: 'markers/kekkai-stone.webp', edge: 180, format: 'webp', note: '42px' },
  { src: 'markers/shikigami.png', out: 'markers/shikigami.webp', edge: 180, format: 'webp', note: '44x60' },
  { src: 'markers/inori.png', out: 'markers/inori.webp', edge: 180, format: 'webp', note: '34px' },
  { src: 'markers/takusen.png', out: 'markers/takusen.webp', edge: 180, format: 'webp', note: '36px' },
  { src: 'markers/yamabushi-stone.png', out: 'markers/yamabushi-stone.webp', edge: 180, format: 'webp', note: '44x48' },
  { src: 'markers/yamabushi-stone-stack.png', out: 'markers/yamabushi-stone-stack.webp', edge: 180, format: 'webp', note: '44x48' },

  // 職業紋 最大 100px枠
  { src: 'emblems/onmyoji.png', out: 'emblems/onmyoji.webp', edge: 300, format: 'webp', note: '100px' },
  { src: 'emblems/kitoshi.png', out: 'emblems/kitoshi.webp', edge: 300, format: 'webp', note: '100px' },
  { src: 'emblems/miko.png', out: 'emblems/miko.webp', edge: 300, format: 'webp', note: '100px' },
  { src: 'emblems/yojutsushi.png', out: 'emblems/yojutsushi.webp', edge: 300, format: 'webp', note: '100px' },
  { src: 'emblems/yamabushi.png', out: 'emblems/yamabushi.webp', edge: 300, format: 'webp', note: '100px' },
  { src: 'emblems/jujutsushi.png', out: 'emblems/jujutsushi.webp', edge: 300, format: 'webp', note: '100px' },

  // OGP 画像。SNS のスクレイパーしか読まないので起動時間には効かないが、
  // 既に共有済みの URL を壊さないようファイル名と形式は変えずに縮小だけする。
  { src: 'background_ogp.png', out: 'background_ogp.png', edge: 1200, format: 'png', note: 'og:image' },
];

async function main() {
  let before = 0;
  let after = 0;
  const missing = [];

  for (const e of MANIFEST) {
    const srcPath = path.join(SRC, e.src);
    if (!fs.existsSync(srcPath)) { missing.push(e.src); continue; }

    const pipeline = sharp(srcPath).resize(e.edge, e.edge, { fit: 'inside', withoutEnlargement: true });
    const buf = e.format === 'webp'
      ? await pipeline.webp({ quality: 82 }).toBuffer()
      // PNG はパレット量子化しないと縮小しても数百KB残る
      : await pipeline.png({ palette: true, quality: 90, compressionLevel: 9 }).toBuffer();

    const srcSize = fs.statSync(srcPath).size;
    before += srcSize;
    after += buf.length;

    const outPath = path.join(DST, e.out);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
    }
    const meta = await sharp(buf).metadata();
    console.log(
      `  ${e.src.padEnd(34)} ${(srcSize / 1024).toFixed(0).padStart(5)}KB → ` +
      `${(buf.length / 1024).toFixed(1).padStart(6)}KB  ${String(meta.width + 'x' + meta.height).padStart(10)}  (${e.note})`,
    );
  }

  if (missing.length) console.error(`\n[assets] 元画像が見つかりません: ${missing.join(', ')}`);
  console.log(
    `\n[assets] ${MANIFEST.length - missing.length} files  ` +
    `${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(2)} MB ` +
    `(${(before / after).toFixed(0)}x smaller)`,
  );
  if (dryRun) console.log('[dry-run] 書き出しはしていません');
  if (missing.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
