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
