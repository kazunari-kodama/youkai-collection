# 妖怪DB データモデルと API

スクリプトを使わずにコードから直接取得したい時、またはフィールドの意味を確認したい時に読む。

Base URL: `https://5rmuhg7c8d.execute-api.ap-northeast-1.amazonaws.com/prod`

## 1. 学術モード API（既定ソース）

| エンドポイント | 内容 |
|---|---|
| `GET /academic/youkai?limit=500&cursor=<next_key JSON>` | `youkai_core` の公開データ（`published="true"`、`is_original=true` の創作妖怪は除外）。`{items, count, next_key?}`。limit 上限 500 |
| `GET /academic/youkai/{yokai_id}` | 1件 |

認証: `Authorization: Bearer <Cognito IdToken>`。トークンの `cognito:groups` に `premium` が無いと 403。

### Cognito ログイン（SDK なしで可能）

- User Pool: `ap-northeast-1_jD05QlqAD` / App Client: `219csst82vd6cc0pdm2cvgmh9t`（シークレットなし、`USER_PASSWORD_AUTH` 有効）
- `POST https://cognito-idp.ap-northeast-1.amazonaws.com/`
  - ヘッダ `Content-Type: application/x-amz-json-1.1`、`X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`
  - 本文 `{"AuthFlow":"USER_PASSWORD_AUTH","ClientId":"…","AuthParameters":{"USERNAME":"<email>","PASSWORD":"…"}}`
  - 応答 `AuthenticationResult.IdToken`（60分）/ `RefreshToken`（30日）
- 更新は `AuthFlow: REFRESH_TOKEN_AUTH`、`AuthParameters: {"REFRESH_TOKEN": "…"}`

### `youkai_core` アイテムのフィールド

| フィールド | 説明 |
|---|---|
| `yokai_id` | UUID |
| `name` | 妖怪名 |
| `notes` | `[カテゴリ] 説明文` 形式（先頭の角括弧がカテゴリ） |
| `place_name` | 伝承地（市区町村レベル以上） |
| `latitude`, `longitude` | 伝承地座標 |
| `source_type` | `academic`(学術文献) / `web` / `oral`(民間伝承) / `image`(画像資料) |
| `source_url`, `sources[]` | 出典。`sources` は `{url, title?, snippet?}` |
| `raw_content` | 収集時の原文（`場所: 〇〇` 行を含むことがある） |
| `reliability_score`, `originality_score` | AI スコア 0.0–1.0 |
| `game_visible` | `"true"` ならゲームにも出現 |
| `images` | S3 キー（media_attachments 由来） |
| `published`, `created_at`, `updated_at`, `source_research_id` | 管理用 |

スクリプトは `notes` の角括弧を外して `category` / `category_raw` に分け、`place_name` が無ければ `raw_content` の `場所:` を `place` に入れる。カテゴリ正規化ルールは `frontend/academic.js` の `extractCategory` と同じ。

## 2. ゲーム用 公開 API（`--source game`、認証不要）

| エンドポイント | 内容 |
|---|---|
| `GET /youkai` | 一覧 `id, name, lat, lon, thumb_url, camera_url, night_only?, require_qr?`（スタンプラリー専用は除外） |
| `GET /youkai/{id}` | 詳細 `kana, notes, appearance, images[{url,type,caption}], regions[], region_detail, category_tags[]("1"〜"7"、意味未定義), keywords[]` |
| `GET /youkai/{id}/stats` | `{seal_count, bond_count}` |
| `GET /stats/global` | 陣営統計 |

## 3. 背景

- ADR-0001（`docs/adr/0001-research-core-data-foundation.md`）: `youkai_research`（査読中）→ 学芸員承認 → `youkai_core`（配信確定）の二段構成。
- 書き込み系（`/research*` はシステムキー、`/admin/*` は `X-Admin-Key`）はこのスキルでは扱わない。
