# 妖怪学術データを Claude Project のコンテキストとして使う

KDM-65（自前 RAG 基盤の検証）はクローズ済みで、以後は **Claude 駆動 + 学芸員ゲート** で
妖怪情報を蓄積・審査する方針に転換している（`docs/HANDOFF.md` 参照）。
検索基盤を自前で組む代わりに、学芸員が承認済みの `youkai_core` データを
そのまま Claude.ai の **Project の Knowledge（プロジェクトコンテキスト）** に
アップロードし、Claude が直接参照できる状態にする。

## 何を作るか

`backend/scripts/export_academic_context.mjs` が `GET /core`（公開・認証不要）を
`cursor` パラメータで全件ページングして取得し、`docs/context/youkai_academic_context.md` に
Markdown として書き出す。ページング方式はプレミアム限定の `GET /academic/youkai`
（`academicListYoukai.ts`）と同じ `cursor` 方式に揃えている。

- 対象: `published=true` かつ `is_original` でないアイテム（`/academic/youkai` と同じ絞り込み）
- 除外: 査読中・却下（`youkai_research` 側）のデータ、創作妖怪
- 1妖怪 = 1セクション（見出し・メタ情報・本文・出典）
- 2026-07-18 時点で `youkai_core` は1500件を超えている（`published-updated_at-index` 経由）

## 使い方

```bash
node backend/scripts/export_academic_context.mjs
# 別の出力先に書きたい場合
node backend/scripts/export_academic_context.mjs /path/to/output.md
# 別環境の API を叩きたい場合
API_BASE=https://xxxx.execute-api.ap-northeast-1.amazonaws.com/dev \
  node backend/scripts/export_academic_context.mjs
```

AWS 認証情報は不要。公開エンドポイントを HTTP で叩くだけなので、
AWS アクセスのない環境（Claude Code on the web のセッション含む）からでも実行できる。

## Claude.ai へのアップロード手順

1. Claude.ai で対象の Project を開く
2. 「Knowledge」→「Add Content」から `docs/context/youkai_academic_context.md` をアップロード
3. 既存ファイルを置き換える場合は古いバージョンを削除してから再アップロード
   （Project Knowledge は自動同期されないため、データ更新のたびに手動で入れ替える）

## 再生成のタイミング

`youkai_core` にデータが追加・更新されるたび（学芸員が research を promote するたび）に
内容が古くなる。以下のタイミングで再生成・再アップロードすることを推奨する。

- 学芸員が新しい research をまとめて promote したとき
- 定期的な棚卸し（月次目安）

## 既知の制限・注意点

- `GET /core` は元々ページングに対応していなかったため、`cursor` クエリパラメータによる
  ページング対応を本 PR（`dev` ブランチ向け）で追加した（`listCore.ts`）。
  `academicListYoukai.ts` にはすでに同方式のページングが実装済みだった。
  この変更が `dev` にマージ・デプロイされる前に生成したファイルは **最新 200 件のみ** を
  収録している（生成された Markdown 冒頭に注意書きが入る）。デプロイ後に再生成すれば全件（1500件超）が入る。
- `dev` ブランチと `main` ブランチは同じ本番スタック（`youkai-collection-web`）にデプロイされる構成のため、
  本エクスポート機能は `dev` ベースで開発している。`main` にマージする場合は、
  `dev` で追加された他機能（課金・スキルシステム等）が本番から失われないよう、
  `main` を `dev` に追従させてから行うこと。
- `youkai_core` のスキーマは ADR-0001 策定時から実運用で変化しており、
  `raw_content` / `sources` / `reliability_score` / `originality_score` などの
  research 由来の属性がそのまま core 側にも残っている（移行時の互換フィールド）。
  エクスポートスクリプトは新旧どちらのスキーマの属性が来ても存在するものだけを出力する。
- 出力ファイルは1500件規模になるとかなり大きくなる（200件で約290KB相当）。
  Claude Project の Knowledge 容量上限に注意し、必要であれば地域・カテゴリ単位で
  分割出力する運用に切り替えることを検討する。
