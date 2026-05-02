// API エンドポイント
// ローカル開発時: sam local start-api を起動後、ここを 'http://localhost:3000' に変更
// デプロイ時: GitHub Actions が __API_BASE_URL__ を自動置換
const API_BASE_URL = 'https://5rmuhg7c8d.execute-api.ap-northeast-1.amazonaws.com/prod';

// DEV フラグ: localhost / 127.0.0.1、または ?debug=1 のときに true
const IS_DEV = ['localhost', '127.0.0.1'].includes(location.hostname)
  || new URLSearchParams(location.search).get('debug') === '1';
