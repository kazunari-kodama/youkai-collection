// API エンドポイント
// ローカル開発時: sam local start-api を起動後、ここを 'http://localhost:3000' に変更
// デプロイ時: GitHub Actions が __API_BASE_URL__ を自動置換
const API_BASE_URL = 'https://5rmuhg7c8d.execute-api.ap-northeast-1.amazonaws.com/prod';

// DEV フラグ: localhost / 127.0.0.1 のみ。
// 本番では ?debug=1 を無効化（位置偽装・データリセット等の不正利用を防止）
const IS_DEV = ['localhost', '127.0.0.1'].includes(location.hostname);

// ナイトタイムフラグ: 17時〜翌5時を夜とする
const IS_NIGHT = new URLSearchParams(location.search).get('night') === '1'
  || (() => { const h = new Date().getHours(); return h >= 17 || h < 8; })();

// CARTO ダークベースマップのキー。2026年8月頃からキー必須になり、
// 無し・無効だとタイルに "API KEY REQUIRED" の透かしが入る。
// 無料枠は月500万タイル（https://carto.com/basemaps/apikey/ で即発行）。
// リポジトリには置かず、GitHub Actions が secrets.CARTO_API_KEY で
// __CARTO_API_KEY__ を置換する。未設定なら OSM 標準タイルにフォールバックする。
const CARTO_API_KEY = '__CARTO_API_KEY__'.startsWith('__') ? '' : '__CARTO_API_KEY__';
