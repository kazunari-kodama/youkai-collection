// ============================================================
// 妖怪コレクション — 学術モード
// Cognito 認証 + GET /academic/youkai + Leaflet 地図表示
// ============================================================

const COGNITO_REGION   = 'ap-northeast-1';
const COGNITO_CLIENT   = '219csst82vd6cc0pdm2cvgmh9t';
const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
const TOKEN_KEY        = 'ac_id_token';
const REFRESH_KEY      = 'ac_refresh_token';

// カテゴリ → 色マッピング
const CAT_COLORS = {
  '河童': '#2980b9', '水霊': '#2980b9', '水神': '#2980b9', '霊水': '#2980b9',
  '鬼':  '#c0392b', '怨霊': '#c0392b', '死霊': '#c0392b',
  '天狗': '#27ae60', '修験': '#27ae60',
  '竜神': '#8e44ad', '大蛇': '#8e44ad', '蛇神': '#8e44ad', '九尾の狐': '#8e44ad',
  '狐':  '#e67e22', '狸':   '#e67e22', '化け猫': '#e67e22', '狸変化': '#e67e22',
  '幽霊': '#7f8c8d', '異類嫁': '#7f8c8d', '異形女性': '#7f8c8d', '異類報恩': '#7f8c8d',
  '地蔵': '#16a085', '仏像': '#16a085', '霊石': '#16a085',
  '神社怪異': '#d35400', '神霊': '#d35400',
};
const DEFAULT_COLOR = '#8B6914';

let map = null;
let allItems = [];
let markers = [];
let currentFilter = '';

// ──────────────────────────────────────────────
// 起動
// ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token && !isTokenExpired(token)) {
    showMapView(token);
  }
  // Enter キーでログイン
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
});

// ──────────────────────────────────────────────
// ログイン
// ──────────────────────────────────────────────
async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn      = document.getElementById('login-btn');
  const errEl    = document.getElementById('login-error');

  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = '認証中…';

  try {
    const resp = await fetch(COGNITO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type'  : 'application/x-amz-json-1.1',
        'X-Amz-Target'  : 'AmazonCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow       : 'USER_PASSWORD_AUTH',
        ClientId       : COGNITO_CLIENT,
        AuthParameters : { USERNAME: email, PASSWORD: password },
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      const msg = data.message || data.__type || 'ログインに失敗しました';
      showError(translateCognitoError(msg));
      return;
    }

    const idToken      = data.AuthenticationResult.IdToken;
    const refreshToken = data.AuthenticationResult.RefreshToken;

    if (!isPremium(idToken)) {
      showError('学術モードはプレミアム会員限定です。\nアカウントのアップグレードが必要です。');
      return;
    }

    localStorage.setItem(TOKEN_KEY,   idToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
    showMapView(idToken);

  } catch (e) {
    showError('通信エラーが発生しました。');
  } finally {
    btn.disabled = false;
    btn.textContent = 'ログ イ ン';
  }
}

function doLogout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  document.getElementById('map-view').style.display   = 'none';
  document.getElementById('login-view').style.display = 'flex';
}

function showError(msg) {
  const el = document.getElementById('login-error');
  el.textContent    = msg;
  el.style.display  = 'block';
}

// ──────────────────────────────────────────────
// 地図モード表示
// ──────────────────────────────────────────────
async function showMapView(token) {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('map-view').style.display   = 'block';

  if (!map) initMap();
  document.getElementById('ac-loading').style.display = 'flex';

  try {
    allItems = await fetchAllItems(token);
    document.getElementById('ac-count').textContent = `${allItems.length} 件`;
    buildFilterBar(allItems);
    renderMarkers(allItems);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      doLogout();
      showError('セッションが期限切れです。再ログインしてください。');
    } else {
      alert('データの取得に失敗しました: ' + e.message);
    }
  } finally {
    document.getElementById('ac-loading').style.display = 'none';
  }
}

function initMap() {
  map = L.map('ac-map', { zoomControl: true }).setView([36.5, 139.5], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);
}

// ──────────────────────────────────────────────
// データ取得（全ページ）
// ──────────────────────────────────────────────
async function fetchAllItems(token) {
  const items = [];
  let nextKey = null;

  do {
    const qs  = nextKey ? `?limit=500&cursor=${encodeURIComponent(JSON.stringify(nextKey))}` : '?limit=500';
    const res = await fetch(`${API_BASE_URL}/academic/youkai${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    items.push(...(data.items || []));
    nextKey = data.next_key || null;
  } while (nextKey);

  return items;
}

// ──────────────────────────────────────────────
// マーカー描画
// ──────────────────────────────────────────────
function renderMarkers(items) {
  // 既存マーカーを削除
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  const withCoords = items.filter(i => i.latitude && i.longitude);

  withCoords.forEach(item => {
    const cat   = extractCategory(item);
    const color = CAT_COLORS[cat] || DEFAULT_COLOR;

    const circle = L.circleMarker([item.latitude, item.longitude], {
      radius      : 8,
      fillColor   : color,
      color       : '#fff',
      weight      : 1.5,
      opacity     : 0.9,
      fillOpacity : 0.85,
    }).addTo(map);

    circle.bindTooltip(item.name || '(名称不明)', { direction: 'top', offset: [0, -8] });
    circle.on('click', () => showDetail(item));
    markers.push(circle);
  });

  // 座標なしアイテムをカウント表示
  const noCoord = items.length - withCoords.length;
  if (noCoord > 0) {
    const label = document.getElementById('ac-count');
    label.textContent = `${items.length} 件（うち地図表示: ${withCoords.length} 件）`;
  }
}

// ──────────────────────────────────────────────
// カテゴリフィルター
// ──────────────────────────────────────────────
function buildFilterBar(items) {
  const cats = [...new Set(items.map(extractCategory).filter(Boolean))].sort();
  const bar  = document.getElementById('ac-filter-bar');
  // 既存ボタン(すべて)以外を削除
  [...bar.querySelectorAll('[data-cat]:not([data-cat=""])')].forEach(b => b.remove());

  cats.forEach(cat => {
    const btn = document.createElement('button');
    btn.className    = 'ac-filter-btn';
    btn.dataset.cat  = cat;
    btn.textContent  = cat;
    btn.onclick      = function() { filterCategory(this, cat); };
    const color = CAT_COLORS[cat];
    if (color) btn.style.setProperty('--cat-color', color);
    bar.appendChild(btn);
  });
}

function filterCategory(btnEl, cat) {
  currentFilter = cat;
  document.querySelectorAll('.ac-filter-btn').forEach(b => b.classList.remove('active'));
  btnEl.classList.add('active');
  closeDetail();

  const filtered = cat ? allItems.filter(i => extractCategory(i) === cat) : allItems;
  renderMarkers(filtered);
}

// ──────────────────────────────────────────────
// 詳細パネル
// ──────────────────────────────────────────────
function showDetail(item) {
  const cat    = extractCategory(item);
  const color  = CAT_COLORS[cat] || DEFAULT_COLOR;
  const region = extractRegion(item);

  document.getElementById('ac-detail-cat').textContent  = cat || '';
  document.getElementById('ac-detail-cat').style.color  = color;
  document.getElementById('ac-detail-name').textContent = item.name || '(名称不明)';
  document.getElementById('ac-detail-region').textContent = region;

  const coordsEl = document.getElementById('ac-detail-coords');
  if (item.latitude && item.longitude) {
    coordsEl.textContent = `${item.latitude.toFixed(4)}, ${item.longitude.toFixed(4)}`;
    coordsEl.style.display = 'block';
    coordsEl.onclick = () => map.flyTo([item.latitude, item.longitude], 14);
  } else {
    coordsEl.style.display = 'none';
  }

  const notes = (item.notes || '').replace(/^\[.*?\]\s*/, '');
  document.getElementById('ac-detail-notes').textContent = notes;

  const srcEl = document.getElementById('ac-detail-source');
  const badges = [];
  if (item.source_type) badges.push(sourceLabel(item.source_type));
  if (item.game_visible === 'true') badges.push('ゲーム対応');
  srcEl.innerHTML = badges.map(b => `<span class="ac-badge">${b}</span>`).join(' ');

  const rawWrap = document.getElementById('ac-detail-raw-wrap');
  if (item.raw_content) {
    rawWrap.style.display = 'block';
    document.getElementById('ac-detail-raw').textContent = item.raw_content;
    document.getElementById('ac-detail-raw').style.display = 'none';
  } else {
    rawWrap.style.display = 'none';
  }

  document.getElementById('ac-detail').style.display = 'block';

  if (item.latitude && item.longitude) {
    map.panTo([item.latitude, item.longitude]);
  }
}

function closeDetail() {
  document.getElementById('ac-detail').style.display = 'none';
}

function toggleRaw() {
  const el  = document.getElementById('ac-detail-raw');
  const btn = document.querySelector('.ac-raw-toggle');
  if (el.style.display === 'none') {
    el.style.display  = 'block';
    btn.textContent   = '生データを非表示 ▲';
  } else {
    el.style.display  = 'none';
    btn.textContent   = '生データを表示 ▼';
  }
}

// ──────────────────────────────────────────────
// JWT ユーティリティ
// ──────────────────────────────────────────────
function parseJwt(token) {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64));
}

function isTokenExpired(token) {
  try {
    return parseJwt(token).exp * 1000 < Date.now();
  } catch { return true; }
}

function isPremium(token) {
  try {
    const payload = parseJwt(token);
    const groups  = payload['cognito:groups'] || [];
    return Array.isArray(groups)
      ? groups.includes('premium')
      : String(groups).includes('premium');
  } catch { return false; }
}

// ──────────────────────────────────────────────
// ヘルパー
// ──────────────────────────────────────────────
function extractCategory(item) {
  // notes のフォーマット: "[河童] 概要文" → 河童
  const m = (item.notes || '').match(/^\[(.+?)\]/);
  return m ? m[1] : '';
}

function extractRegion(item) {
  // raw_content の "場所: 〇〇" を抽出
  const m = (item.raw_content || '').match(/場所:\s*(.+?)(\n|$)/);
  return m ? m[1].trim() : '';
}

function sourceLabel(type) {
  return { academic: '学術文献', web: 'Web', oral: '民間伝承', image: '画像資料' }[type] || type;
}

function translateCognitoError(msg) {
  if (msg.includes('NotAuthorizedException') || msg.includes('Incorrect'))
    return 'メールアドレスまたはパスワードが正しくありません。';
  if (msg.includes('UserNotFoundException'))
    return 'アカウントが見つかりません。';
  if (msg.includes('UserNotConfirmedException'))
    return 'メールアドレスの確認が完了していません。';
  if (msg.includes('PasswordResetRequiredException'))
    return 'パスワードのリセットが必要です。';
  return msg;
}
