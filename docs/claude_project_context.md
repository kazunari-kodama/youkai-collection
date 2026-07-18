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
- 2026-07-18 時点で `youkai_core` は1788件（`published=true`）、うち学術データ（`is_original`除く）は1614件

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
  ページング対応を追加した（`listCore.ts`、PR #1で`dev`にマージ・デプロイ済み）。
  `academicListYoukai.ts` にはすでに同方式のページングが実装済みだった。
  2026-07-18 のデプロイ後に再生成し、全1614件を収録済み。
- `dev` ブランチと `main` ブランチは同じ本番スタック（`youkai-collection-web`）にデプロイされる構成のため、
  本エクスポート機能は `dev` ベースで開発している。`main` にマージする場合は、
  `dev` で追加された他機能（課金・スキルシステム等）が本番から失われないよう、
  `main` を `dev` に追従させてから行うこと。
- `youkai_core` のスキーマは ADR-0001 策定時から実運用で変化しており、
  `raw_content` / `sources` / `reliability_score` / `originality_score` などの
  research 由来の属性がそのまま core 側にも残っている（移行時の互換フィールド）。
  エクスポートスクリプトは新旧どちらのスキーマの属性が来ても存在するものだけを出力する。
- 出力ファイルは約1.9MB（1614件）。Claude Project の Knowledge 容量上限に注意し、
  必要であれば地域・カテゴリ単位で分割出力する運用に切り替えることを検討する。
- 既知のデータ品質問題として、一部のレコードで `name`/`notes` が文字化けし `?????` に
  なっているものが確認できる（`docs/HANDOFF.md` に記載の文字コード問題の可能性）。
  エクスポートスクリプト自体はソースデータをそのまま出力しているため、
  修正するなら `youkai_core` 側のデータクレンジングが必要。
