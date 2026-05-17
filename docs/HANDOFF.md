# HANDOFF: 妖怪コレクション データ基盤再設計（KDM-99）

VSCode + AWS アクセスがある環境で続きを進めるための引き継ぎメモ。
Claude Code on the web 側のセッションは AWS にアクセスできないため、
DynamoDB / S3 の実体確認はこちら側で実施する必要がある。

最終更新: 2026-05-17

---

## これまでの経緯（Jira）

### 完了済み

| Key | サマリ | 備考 |
|---|---|---|
| KDM-111 | 既存SPAのフレームワーク・構成棚卸し | youkai-event 側の `docs/open-questions.md` に反映済（コミット de5c0cc） |
| KDM-98 | 【01】旧Jorougumo方針転換と既存資産の棚卸し | 棚卸し結果サマリをコメントに記載 |
| KDM-10 | Web3/NFT連携 | クローズ（方針外） |
| KDM-51 | Kodama-APIをAWS Lambda+ API Gateway化 | クローズ（youkai-collection で実装済み） |
| KDM-65 | 技術：RAG（検索拡張生成）の検証 | クローズ（Claude駆動方針へ転換） |

### 確定した方針

- **youkai-event と youkai-collection は永続的に別リポジトリで運用**
  （詳細: youkai-event `docs/open-questions.md`「リポジトリ分離方針」セクション）
- **Jorougumo 系の自前パイプライン構築は破棄**。情報収集は Claude 駆動 + 学芸員に集約
- 妖怪情報は **research / core 二段テーブル** で人間ゲート付き運用に再設計

### 次にやるエピック（このドキュメントの主題）

**KDM-99 【02】データ基盤再設計（research / core 二段テーブル + API）**

- 親エピックには既に「主要サブタスク候補」が列挙済み
- KDM-100 以降（Claude駆動プロンプト運用、アカデミックモード）の前提となるので最優先

---

## KDM-99 のゴール（Jira から転記）

- `youkai_research` / `youkai_core` のスキーマ確定
- DynamoDB 上のテーブル作成（dev / prod）
- research → core 昇格フローの実装
- アクセス権限の実装
- 既存 KDM 資産（KDM-4, 40, 41, 42, 54, 57, 59, 60）の組み込み

### 主要サブタスク候補

- youkai_research スキーマ確定とテーブル作成
- youkai_core スキーマ確定とテーブル作成
- GSI 設計（location 検索 / status 検索 / collector_id 検索）
- S3 バケット設計（media_attachments 用）
- `POST /research` 実装
- `PATCH /research/{id}` 実装
- `POST /research/{id}/promote` 実装
- `GET /core/{id}` 実装（既存 Kodama-API の再構築）
- `GET /core?location=...` 実装
- アクセス権限制御の実装
- 旧 KDM 資産のスキーマへの反映

---

## 既存システムの棚卸し結果（KDM-111 / KDM-98 より）

### 既存テーブル（SAM template から読み取り済）

| テーブル名 | 用途 | キー構成（既知） | GSI |
|---|---|---|---|
| `kodama_db` | 妖怪マスタ（既存） | **未確認 ← AWS で要確認** | **未確認** |
| `youkai-captures` | プレイヤー捕獲履歴 | PK: `deviceId` / SK: `youkaiId` | なし |

### 既存 API（参考）

- `GET /youkai`, `GET /youkai/{id}` … `kodama_db` を Scan / GetItem
- `POST /capture` … 妖怪マスタを GetItem → captures に PutItem
- `GET /collection` … captures を Query
- `GET /rally`, `GET /rally/collection` … スタンプラリー用
- `/admin/*` … `X-Admin-Key` ヘッダで認可、CRUD

### 既存資産（プロンプト・スキーマ原資として転用可能）

旧 Jorougumo 系で「完了」になっている設計成果物。Confluence ではなく Jira コメントに本文があるので参照価値あり。

- KDM-40 妖怪関連性判定ロジック設計
- KDM-41 ノイズ除去ロジック設計
- KDM-42 信頼性・オリジナリティ推測ロジック設計
- KDM-54 サーファー対象URLの分類定義
- KDM-55 フィルタリングの評価項目設計
- KDM-56 AIプロンプト初版設計
- KDM-57 AIスコア出力仕様設計
- KDM-59 スコア閾値ルールの設計
- KDM-60 再評価対象の管理フロー案作成

---

## まずやってほしいこと：AWS 実テーブル確認

ADR ドラフト前に **既存 `kodama_db` の物理構造とサンプルデータ**を見ておきたい。
理由は (1) 既存属性のうち research / core どちらに分離すべきか判断するため、
(2) GSI を流用できる可能性を見るため、(3) 移行コストを見積もるため。

### 1. `kodama_db` の構造

```bash
aws dynamodb describe-table \
  --table-name kodama_db \
  --region ap-northeast-1 \
  --query 'Table.{Keys:KeySchema, Attrs:AttributeDefinitions, GSIs:GlobalSecondaryIndexes, ItemCount:ItemCount, Size:TableSizeBytes, Billing:BillingModeSummary.BillingMode}'
```

確認したいこと:
- PK / SK の物理名と型
- GSI の有無（location 検索 / status 検索が現状どう実現されているか）
- 件数

### 2. `kodama_db` のサンプルアイテム（2 件）

```bash
aws dynamodb scan \
  --table-name kodama_db \
  --region ap-northeast-1 \
  --limit 2
```

確認したいこと:
- どんな属性が入っているか（name / appearance / origin / category / image_url / references / created_at 等）
- 既存属性のうち research（査読用メタ）/ core（配信用本体）どちらの責務に入るべきか判断材料

### 3. `youkai-captures` 確認（裏取り）

```bash
aws dynamodb describe-table \
  --table-name youkai-captures \
  --region ap-northeast-1 \
  --query 'Table.{Keys:KeySchema, Attrs:AttributeDefinitions, GSIs:GlobalSecondaryIndexes, ItemCount:ItemCount}'
```

### 4. 画像バケットの構造

```bash
aws s3 ls s3://youkai-collection-images/ --recursive --summarize --human-readable | head -50
```

確認したいこと:
- キー命名規則（`youkai/{id}/...` か別構造か）
- `media_attachments` 用 S3 配置設計の参考

### 結果の貼り付け先

このファイルの末尾「## AWS 確認結果」セクションに、出力をそのまま貼って commit してください。
機密が混じる属性があれば伏字でかまいません（値より構造が知りたい）。

---

## このあとの作業（AWS 確認後）

1. **ADR-0001 ドラフト作成** … `docs/adr/0001-research-core-data-foundation.md`
   - research / core スキーマ確定
   - GSI 設計
   - research → core 昇格フローの状態遷移
   - 既存 `kodama_db` からの移行戦略（破壊的か段階的か）
   - アクセス権限（既存 `X-Admin-Key` から学芸員ロールへの移行案）
2. **KDM-99 を Jira 上でサブタスクに分解**（テーブル作成 / GSI / API 5 本 / 権限 / 移行）
3. **dev 環境用の SAM スタックを切る**かどうかの判断（現状 prod 単一）

---

## 関連リンク

- youkai-collection: https://github.com/kazunari-kodama/youkai-collection
- youkai-event open-questions: https://github.com/kazunari-kodama/youkai-event/blob/claude/review-youkai-framework-84tEO/docs/open-questions.md
- KDM-99: https://youkaiya.atlassian.net/browse/KDM-99
- KDM-100: https://youkaiya.atlassian.net/browse/KDM-100
- KDM-101: https://youkaiya.atlassian.net/browse/KDM-101
- KDM-102: https://youkaiya.atlassian.net/browse/KDM-102

---

## AWS 確認結果

<!-- ここに上記 4 コマンドの出力を貼る。終わったらこのコメントは消してOK -->

### 1. `kodama_db` describe-table

```
（未確認）
```

### 2. `kodama_db` scan サンプル

```
（未確認）
```

### 3. `youkai-captures` describe-table

```
（未確認）
```

### 4. `youkai-collection-images` s3 ls

```
（未確認）
```
