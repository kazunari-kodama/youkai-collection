# ADR-0001: データ基盤再設計 — research / core 二段テーブル

- **Status:** Draft
- **Date:** 2026-05-17
- **Jira:** KDM-99
- **Deciders:** 合同会社妖怪屋

---

## コンテキスト

現状の `kodama_db` は「配信用の確定データ」と「情報収集・査読中のデータ」を区別できない単一テーブルである。

- 174件・GSIなし・PK: `yokai_id` のみ
- location 検索はフルスキャンで実現（174件なので現状は許容範囲）
- 旧 Jorougumo パイプライン（自前クローラー）は廃止済み
- 今後は **Claude 駆動 + 学芸員によるゲート** で情報を蓄積・審査する方針

この方針を実現するには、「収集中（research）」と「配信確定（core）」を物理的に分離し、人間ゲート（昇格フロー）を API として定義する必要がある。

---

## 決定

`kodama_db` を廃止し、**`youkai_research`** と **`youkai_core`** の二段テーブルに再設計する。

---

## テーブル設計

### `youkai_research`

査読フェーズのデータを保持する。学芸員が承認するまでゲームには公開されない。

**キー構成:**

| 種別 | 属性名 | 型 |
|---|---|---|
| PK | `research_id` | S (UUID) |

**属性:**

| 属性名 | 型 | 説明 |
|---|---|---|
| `research_id` | S | UUID v4 |
| `status` | S | `pending` \| `reviewing` \| `approved` \| `rejected` |
| `yokai_name` | S | 妖怪名（仮称、査読前） |
| `source_url` | S | 情報源 URL |
| `source_type` | S | `academic` \| `web` \| `oral` \| `image` |
| `raw_content` | S | 収集した生テキスト |
| `summary` | S | Claude 要約（オプション） |
| `reliability_score` | N | AI信頼性スコア 0.0–1.0（KDM-42 仕様準拠） |
| `originality_score` | N | AIオリジナリティスコア 0.0–1.0（KDM-42 仕様準拠） |
| `collector_id` | S | 収集者ID（`system` or 学芸員ユーザーID） |
| `collected_at` | S | ISO 8601 |
| `reviewed_by` | S | 承認した学芸員ID（承認時のみ） |
| `reviewed_at` | S | ISO 8601（承認時のみ） |
| `review_notes` | S | 査読コメント |
| `promoted_to` | S | 昇格先 `yokai_id`（`approved` 時のみ） |
| `media_attachments` | L | S3 キーリスト（`research/{id}/attachments/{file}`） |

**GSI:**

| GSI 名 | PK | SK | 用途 |
|---|---|---|---|
| `status-collected_at-index` | `status` | `collected_at` | ステータス別一覧（学芸員ダッシュボード） |
| `collector_id-collected_at-index` | `collector_id` | `collected_at` | 収集者別履歴 |

---

### `youkai_core`

ゲーム・アプリに配信する確定データ。学芸員が承認した内容のみ存在する。

**キー構成:**

| 種別 | 属性名 | 型 |
|---|---|---|
| PK | `yokai_id` | S (UUID) |

既存 `kodama_db` と同じキー名を維持し、既存 API (`GET /youkai`, `POST /capture` 等) への影響を最小化する。

**属性（既存属性 + 新規）:**

| 属性名 | 型 | 既存? | 説明 |
|---|---|---|---|
| `yokai_id` | S | ✅ | UUID |
| `name` | S | ✅ | 正式名称 |
| `kana` | S | ✅ | 読み仮名 |
| `appearance` | S | ✅ | 外見・特徴 |
| `notes` | S | ✅ | 解説 |
| `regions` | L | ✅ | 地域リスト |
| `region_detail` | S | ✅ | 地域詳細 |
| `category_tags` | L | ✅ | カテゴリタグ |
| `keywords` | L | ✅ | キーワード |
| `images` | L | ✅ | S3 キーリスト（既存: 相対パス → **S3 URI に統一**） |
| `image_types` | L | ✅ | official \| icon 等 |
| `image_captions` | L | ✅ | キャプション |
| `latitude` | N | ✅ | 配置座標（緯度） |
| `longitude` | N | ✅ | 配置座標（経度） |
| `require_qr` | BOOL | ✅ | QRコード捕獲フラグ（2026-05 追加済み） |
| `published` | BOOL | 🆕 | `false` = 非公開（管理用ドラフト扱い） |
| `research_ids` | L | 🆕 | 参照元 `research_id` リスト（トレーサビリティ） |
| `created_at` | S | 🆕 | ISO 8601 |
| `updated_at` | S | 🆕 | ISO 8601 |

**GSI:**

174件はフルスキャンで許容範囲のため、当面 GSI は `published` のみ追加する。
location 検索（lat/lon）は件数増加時に geohash GSI を検討する。

| GSI 名 | PK | SK | 用途 |
|---|---|---|---|
| `published-updated_at-index` | `published` | `updated_at` | 公開妖怪一覧（管理画面） |

---

## S3 バケット設計

既存: `youkai-collection-images`（`youkai/{id}_camera.png` フラット構造）

新規 prefix を追加し、既存オブジェクトはそのまま維持する:

| prefix | 用途 |
|---|---|
| `youkai/{yokai_id}/` | core 用画像（正式、既存を段階移行） |
| `research/{research_id}/attachments/` | research 用添付ファイル |

---

## research → core 昇格フロー

```
[Claude / 外部ツール]
  POST /research  →  research_id 発行、status=pending

[学芸員]
  PATCH /research/{id}  →  status=reviewing に遷移（編集・注釈追加）

[学芸員]
  POST /research/{id}/promote
    →  youkai_core に PutItem（yokai_id 新規発行）
    →  research.status = approved
    →  research.promoted_to = yokai_id

  or

  PATCH /research/{id}  →  status=rejected（却下コメント付き）
```

**状態遷移図:**

```
pending → reviewing → approved
                    ↘ rejected
pending →            rejected  (査読省略却下)
```

---

## アクセス権限

### 現状

- `X-Admin-Key` ヘッダ（固定シークレット）で `/admin/*` を保護

### 新設計

| ロール | 操作範囲 |
|---|---|
| **system** | `POST /research`（Claude 等の自動収集） |
| **curator**（学芸員） | research の CRUD、`POST /research/{id}/promote`、core の編集 |
| **public** | `GET /core/*`（ゲーム向け読み取り） |

**移行方針（段階的）:**

1. **短期:** 既存 `X-Admin-Key` を `curator` ロールとして継続。`X-System-Key` を新設して system ロールに割り当て。
2. **長期:** API Gateway の Usage Plan + API Key 管理 or AWS Cognito に移行（KDM-100 以降で検討）。

---

## 既存 `kodama_db` からの移行戦略

### 方針: 段階的移行（ブルーグリーン）

1. `youkai_core` テーブルを新規作成（SAM テンプレートに追加）
2. 移行スクリプトで `kodama_db` → `youkai_core` に全件コピー（174件、数秒）
3. API の参照先を `youkai_core` に切り替え（環境変数 `YOUKAI_TABLE` を変更）
4. 動作確認後に `kodama_db` を廃止

**リスク:**
- `images` 属性が相対パス形式（`images/xxx.png`）のため、フロントエンドの参照先変更が必要。移行時に S3 URI（`https://.../{key}`）に変換するか、フロントエンド側で吸収するかを選択。
- 文字コード問題（Shift-JIS 混在の疑い）を移行前に確認・修正する。

---

## 検討した代替案

### A. `kodama_db` に属性追加して単一テーブルで運用

- 却下理由: research データ（査読中、却下済）がゲーム向け API に混入するリスク。GSI 設計も複雑化する。

### B. マルチテナント（PK に `type#` prefix）

- 却下理由: 権限制御が困難。research と core では課金・スケーリング特性が異なる（research は書き込み頻度高、core は読み込み頻度高）。

---

## 未解決事項

- [ ] 文字コード問題の実態確認（`kodama_db` の name / notes 等が Shift-JIS か否か）
- [ ] dev 環境用 SAM スタックを切るかどうかの判断（現状 prod 単一）
- [ ] geohash GSI の導入タイミング（件数が何件を超えたらスキャンをやめるか）
- [ ] `X-System-Key` の発行・ローテーション運用（Secrets Manager を使うか）
