/**
 * youkai_core（published, is_original除く）を全件取得し、
 * Claude Project の Knowledge（プロジェクトコンテキスト）に
 * そのままアップロードできる Markdown に変換するスクリプト。
 *
 * KDM-65（自前RAG）はクローズ済み。RAG基盤を組む代わりに、
 * 学芸員承認済みの youkai_core データをそのまま Claude Project の
 * コンテキストとして与える運用にするための出力を作る。
 *
 * GET /core は公開エンドポイント（認証不要）。cursor パラメータで
 * ページングし（academicListYoukai.ts と同じ方式）、AWS 認証情報がない
 * 環境（Claude Code on the web 等）からでも全件取得できる。
 *
 * 使い方:
 *   node export_academic_context.mjs [出力先パス]
 *
 * 環境変数:
 *   API_BASE  デフォルト: 本番 API Gateway エンドポイント
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_BASE = process.env.API_BASE ?? 'https://5rmuhg7c8d.execute-api.ap-northeast-1.amazonaws.com/prod';
const OUTPUT_PATH = process.argv[2] ?? path.join(import.meta.dirname, '..', '..', 'docs', 'context', 'youkai_academic_context.md');
const PAGE_LIMIT = 200;

async function fetchAllCoreItems() {
  const items = [];
  const seenIds = new Set();
  let cursor;
  let truncated = false;

  while (true) {
    const url = new URL(`${API_BASE.replace(/\/$/, '')}/core`);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', encodeURIComponent(JSON.stringify(cursor)));

    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET /core failed: ${res.status} ${await res.text()}`);
    const body = await res.json();

    // cursor 対応が未デプロイの場合、API は毎回同じ先頭ページを返す。
    // そのケースを検知して無限ループを防ぐ。
    const freshItems = body.items.filter((i) => !seenIds.has(i.yokai_id));
    if (cursor && freshItems.length === 0) {
      console.warn('[export] warn: cursor に対して新しいアイテムが返らなかったため打ち切り。');
      console.warn('[export] warn: GET /core の cursor 対応がまだデプロイされていない可能性があります。');
      truncated = true;
      break;
    }

    for (const i of freshItems) seenIds.add(i.yokai_id);
    items.push(...freshItems);
    console.log(`  fetched ${items.length} items so far...`);

    if (!body.next_key) break;
    cursor = body.next_key;
  }

  return { items, truncated };
}

function formatList(label, values) {
  if (!values || values.length === 0) return '';
  return `- ${label}: ${values.join(' / ')}\n`;
}

function formatEntry(item) {
  const lines = [`## ${item.name ?? '(名称未設定)'}`, ''];

  lines.push(`- ID: ${item.yokai_id}`);
  if (item.kana) lines.push(`- 読み: ${item.kana}`);
  if (item.latitude != null && item.longitude != null) {
    lines.push(`- 座標: ${item.latitude}, ${item.longitude}`);
  }
  if (item.region_detail) lines.push(`- 地域: ${item.region_detail}`);
  const regionList = formatList('地域タグ', item.regions);
  if (regionList) lines.push(regionList.trimEnd());
  const categoryList = formatList('カテゴリ', item.category_tags);
  if (categoryList) lines.push(categoryList.trimEnd());
  const keywordList = formatList('キーワード', item.keywords);
  if (keywordList) lines.push(keywordList.trimEnd());
  if (item.source_type) lines.push(`- 情報源種別: ${item.source_type}`);
  if (item.reliability_score != null) lines.push(`- 信頼性スコア: ${item.reliability_score}`);
  if (item.originality_score != null) lines.push(`- オリジナリティスコア: ${item.originality_score}`);
  lines.push(`- 更新日時: ${item.updated_at}`);
  lines.push('');

  if (item.notes) {
    lines.push(item.notes.trim(), '');
  }

  if (item.appearance) {
    lines.push('### 外見・特徴', '', item.appearance.trim(), '');
  }

  if (item.raw_content) {
    lines.push('### 収集した伝承・記録', '', item.raw_content.trim(), '');
  }

  if (item.sources && item.sources.length > 0) {
    lines.push('### 出典', '');
    for (const s of item.sources) {
      const title = s.title ?? s.url ?? '(無題)';
      const snippet = s.snippet ? ` — ${s.snippet}` : '';
      lines.push(`- [${title}](${s.url})${snippet}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  console.log(`[export] fetching published core items from ${API_BASE}/core ...`);
  const { items: all, truncated } = await fetchAllCoreItems();

  // 創作妖怪（is_original: true）は学術コンテキストから除外
  const academic = all.filter((i) => i.is_original !== true);
  console.log(`[export] total published: ${all.length}, academic (is_original除く): ${academic.length}`);

  academic.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ja'));

  const generatedAt = new Date().toISOString();
  const header = [
    '# 妖怪コレクション 学術データ（Claude Project コンテキスト用）',
    '',
    `- 生成日時: ${generatedAt}`,
    `- 件数: ${academic.length}`,
    '- 生成元: `youkai_core` テーブル（`published=true`, `is_original` を除く）',
    '- 生成スクリプト: `backend/scripts/export_academic_context.mjs`',
    ...(truncated
      ? [
          '',
          '**⚠️ 注意:** 生成時点で GET /core の `cursor` ページング機能が本番未デプロイだったため、',
          '最新 200 件のみを収録しています。ページング対応版のデプロイ後に再生成すると全件が入ります。',
        ]
      : []),
    '',
    'このファイルは Claude.ai の Project の Knowledge（プロジェクトコンテキスト）に',
    'そのままアップロードすることを想定した、妖怪コレクションの学術データのスナップショットです。',
    '再生成する場合は `node backend/scripts/export_academic_context.mjs` を実行し、',
    '出力されたこのファイルを再アップロードしてください。',
    '',
    '---',
    '',
  ].join('\n');

  const body = academic.map(formatEntry).join('\n---\n\n');

  await writeFile(OUTPUT_PATH, header + body + '\n', 'utf-8');
  console.log(`[export] wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
