// ============================================================
// 妖怪コレクション — 学術モード
// Cognito 認証 + GET /academic/youkai + Leaflet 地図表示
// ============================================================

const COGNITO_REGION      = 'ap-northeast-1';
const COGNITO_USER_POOL_ID = 'ap-northeast-1_jD05QlqAD';
const COGNITO_CLIENT       = '219csst82vd6cc0pdm2cvgmh9t';
const TOKEN_KEY            = 'ac_id_token';
const REFRESH_KEY          = 'ac_refresh_token';

// カテゴリ正規化マップ（特定名・複合名 → 代表カテゴリ）
const CAT_NORMALIZE = {
  // 九尾の狐・ムジナ等、妖怪固有名 → 種族名
  '九尾の狐':       '狐',
  'ムジナ':         '狸',
  '狐火':           '狐',
  '蛇女':           '蛇神',
  '竜宮':           '竜神',
  '武装地蔵':       '地蔵',
  '異形老婆神像':   '神社怪異',
  '霊泉':           '霊水',
  // 「鬼・〇〇」など複合カテゴリ → 前半の主カテゴリへ
  '鬼・怪異群':     '鬼',
  '鬼・文芸':       '鬼',
  '大蛇・大ムカデ': '大蛇',
  '大蛇・竜神':     '竜神',
  '地霊・水神':     '水神',
  '幽霊・水霊':     '幽霊',
  '死霊・美女霊':   '死霊',
  '妖獣・河童説':   '河童',
};

// カテゴリ → 色マッピング（正規化後のカテゴリ名で指定）
const CAT_COLORS = {
  // 水系
  '河童': '#2980b9', '水神': '#2980b9', '霊水': '#2980b9', '霊魚': '#2980b9',
  // 鬼・霊系
  '鬼': '#c0392b', '怨霊': '#c0392b', '死霊': '#c0392b', '怨念': '#c0392b',
  // 天狗系
  '天狗': '#27ae60', '修験': '#27ae60',
  // 竜・蛇系
  '竜神': '#8e44ad', '大蛇': '#8e44ad', '蛇神': '#8e44ad',
  // 動物変化系
  '狐': '#e67e22', '狸': '#e67e22', '狼': '#e67e22', '霊鹿': '#e67e22',
  // 幽霊系
  '幽霊': '#7f8c8d', '異類嫁': '#7f8c8d', '異形女性': '#7f8c8d', '異類報恩': '#7f8c8d',
  // 霊石・霊木系
  '地蔵': '#16a085', '霊石': '#16a085', '霊木': '#16a085',
  // 神霊・神社系
  '神社怪異': '#d35400', '神霊': '#d35400', '女神': '#d35400',
  '蚕の起源神': '#d35400', '日輪信仰': '#d35400',
  // 妖・付喪神系
  '妖': '#9b59b6', '妖獣': '#9b59b6', '付喪神': '#9b59b6', '妖術師': '#9b59b6',
};
const DEFAULT_COLOR = '#8B6914';

let map = null;
let allItems = [];
let markers = [];
let currentFilter = '';

// 認証フロー用の一時状態
let pendingIdToken      = null;  // 非プレミアムでログイン成功したユーザーの idToken（決済に使用、localStorage には保存しない）
let pendingSignupEmail  = '';    // サインアップ→確認コードの受け渡し
let pendingSignupPassword = '';  // 確認完了後の自動ログイン用

// ──────────────────────────────────────────────
// 起動
// ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const checkout = new URLSearchParams(location.search).get('checkout');
  if (checkout === 'success') {
    // 決済直後：古い非プレミアムトークンを破棄し、再ログインで premium を反映させる
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    showBanner('success', '決済ありがとうございます。反映まで少し時間がかかる場合があります。少し待ってから再ログインすると学術モードが解放されます。');
  } else if (checkout === 'cancel') {
    showBanner('cancel', '決済がキャンセルされました。いつでもアップグレードできます。');
  } else {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token && !isTokenExpired(token) && isPremium(token)) {
      showMapView(token);
    }
  }
  // Enter キーで各フォームを送信
  bindEnter('login-password', doLogin);
  bindEnter('signup-password', doSignup);
  bindEnter('confirm-code', doConfirm);
});

function bindEnter(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') fn(); });
}

// ──────────────────────────────────────────────
// 認証モード切替（ログイン / 新規登録 / 確認コード）
// ──────────────────────────────────────────────
function switchAuthMode(mode) {
  clearError();
  const forms = { login: 'login-form', signup: 'signup-form', confirm: 'confirm-form' };
  Object.values(forms).forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.getElementById(forms[mode] || forms.login).style.display = 'block';
  // タブ表示（confirm は signup タブのアクティブ扱い）
  const tabActive = (mode === 'confirm') ? 'signup' : mode;
  document.getElementById('tab-login').classList.toggle('active', tabActive === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tabActive === 'signup');
}

function getUserPool() {
  return new AmazonCognitoIdentity.CognitoUserPool({
    UserPoolId: COGNITO_USER_POOL_ID,
    ClientId  : COGNITO_CLIENT,
  });
}

// ──────────────────────────────────────────────
// ログイン
// ──────────────────────────────────────────────
function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn      = document.getElementById('login-btn');
  const errEl    = document.getElementById('login-error');

  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = '認証中…';

  const resetBtn = () => { btn.disabled = false; btn.textContent = 'ログ イ ン'; };

  try {
    const userPool = getUserPool();
    const cognitoUser = new AmazonCognitoIdentity.CognitoUser({
      Username: email,
      Pool    : userPool,
    });
    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
      Username: email,
      Password: password,
    });

    cognitoUser.authenticateUser(authDetails, {
      onSuccess(result) {
        const idToken      = result.getIdToken().getJwtToken();
        const refreshToken = result.getRefreshToken().getToken();
        resetBtn();

        // 非プレミアムでもログインは通し、アップグレード画面へ誘導する。
        // 非プレミアムトークンは localStorage に保存せず、決済呼び出し用にメモリ保持のみ。
        if (!isPremium(idToken)) {
          pendingIdToken = idToken;
          showUpgradeView();
          return;
        }

        localStorage.setItem(TOKEN_KEY,   idToken);
        localStorage.setItem(REFRESH_KEY, refreshToken);
        showMapView(idToken);
      },
      onFailure(err) {
        showError(translateCognitoError(err.code || err.message || 'ログインに失敗しました'));
        resetBtn();
      },
      newPasswordRequired() {
        showError('パスワードの変更が必要です。管理者にお問い合わせください。');
        resetBtn();
      },
    });
  } catch (e) {
    showError('通信エラーが発生しました。');
    resetBtn();
  }
}

function doLogout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  pendingIdToken = null;
  document.getElementById('map-view').style.display     = 'none';
  document.getElementById('upgrade-view').style.display = 'none';
  document.getElementById('login-view').style.display   = 'flex';
  switchAuthMode('login');
}

// ──────────────────────────────────────────────
// 新規登録
// ──────────────────────────────────────────────
function doSignup() {
  const email    = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const btn      = document.getElementById('signup-btn');

  clearError();
  if (!email || !password) { showError('メールアドレスとパスワードを入力してください。'); return; }

  btn.disabled = true; btn.textContent = '登録中…';
  const reset = () => { btn.disabled = false; btn.textContent = '新 規 登 録'; };

  try {
    const userPool = getUserPool();
    const attrs = [ new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'email', Value: email }) ];
    userPool.signUp(email, password, attrs, null, (err) => {
      reset();
      if (err) { showError(translateCognitoError(err.code || err.message || '登録に失敗しました')); return; }
      // 確認コード入力へ。自動ログイン用に控える
      pendingSignupEmail    = email;
      pendingSignupPassword = password;
      switchAuthMode('confirm');
    });
  } catch (e) {
    reset();
    showError('通信エラーが発生しました。');
  }
}

// ──────────────────────────────────────────────
// 確認コード検証
// ──────────────────────────────────────────────
function doConfirm() {
  const code = document.getElementById('confirm-code').value.trim();
  const btn  = document.getElementById('confirm-btn');

  clearError();
  if (!code) { showError('確認コードを入力してください。'); return; }
  if (!pendingSignupEmail) { showError('登録情報が不明です。最初からやり直してください。'); switchAuthMode('signup'); return; }

  btn.disabled = true; btn.textContent = '確認中…';
  const reset = () => { btn.disabled = false; btn.textContent = '確 認 す る'; };

  try {
    const cognitoUser = new AmazonCognitoIdentity.CognitoUser({ Username: pendingSignupEmail, Pool: getUserPool() });
    cognitoUser.confirmRegistration(code, true, (err) => {
      reset();
      if (err) { showError(translateCognitoError(err.code || err.message || '確認に失敗しました')); return; }
      // 確認完了 → そのまま自動ログイン（非プレミアムなのでアップグレード画面へ遷移する）
      autoLoginAfterConfirm(pendingSignupEmail, pendingSignupPassword);
    });
  } catch (e) {
    reset();
    showError('通信エラーが発生しました。');
  }
}

function autoLoginAfterConfirm(email, password) {
  switchAuthMode('login');
  document.getElementById('login-email').value    = email;
  document.getElementById('login-password').value = password || '';
  pendingSignupPassword = '';
  if (password) {
    doLogin();
  } else {
    showBanner('success', '登録が完了しました。ログインしてください。');
  }
}

// ──────────────────────────────────────────────
// アップグレード（Stripe Checkout へ）
// ──────────────────────────────────────────────
function showUpgradeView() {
  document.getElementById('login-view').style.display   = 'none';
  document.getElementById('map-view').style.display     = 'none';
  document.getElementById('upgrade-view').style.display = 'flex';
}

async function doCheckout() {
  const btn   = document.getElementById('upgrade-btn');
  const errEl = document.getElementById('upgrade-error');
  errEl.style.display = 'none';

  if (!pendingIdToken || isTokenExpired(pendingIdToken)) {
    showUpgradeError('セッションの有効期限が切れました。再ログインしてください。');
    return;
  }

  const reset = () => { btn.disabled = false; btn.textContent = 'プレミアムにアップグレード（¥1,500）'; };
  btn.disabled = true; btn.textContent = '決済ページへ移動中…';

  try {
    const res = await fetch(`${API_BASE_URL}/billing/checkout`, {
      method : 'POST',
      headers: { Authorization: `Bearer ${pendingIdToken}`, 'Content-Type': 'application/json' },
    });

    if (res.status === 401 || res.status === 403) {
      showUpgradeError('セッションの有効期限が切れました。再ログインしてください。');
      reset();
      return;
    }

    const data = await res.json();

    if (data.alreadyPremium) {
      showUpgradeError('すでにプレミアム会員です。再ログインすると学術モードが開きます。');
      reset();
      return;
    }
    if (data.url) {
      window.location.href = data.url;  // Stripe Checkout へリダイレクト
      return;
    }
    throw new Error('no checkout url');
  } catch (e) {
    showUpgradeError('決済ページの取得に失敗しました。時間をおいて再度お試しください。');
    reset();
  }
}

// ──────────────────────────────────────────────
// エラー / バナー表示
// ──────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('login-error');
  el.textContent   = msg;
  el.style.display = 'block';
}

function clearError() {
  document.getElementById('login-error').style.display = 'none';
}

function showUpgradeError(msg) {
  const el = document.getElementById('upgrade-error');
  el.textContent   = msg;
  el.style.display = 'block';
}

function showBanner(kind, msg) {
  const el = document.getElementById('ac-banner');
  el.className     = 'ac-banner ' + kind;
  el.textContent   = msg;
  el.style.display = 'block';
  // URL から checkout パラメータを除去（リロード時の再表示を防ぐ）
  if (history.replaceState) history.replaceState(null, '', location.pathname);
}

// ──────────────────────────────────────────────
// 地図モード表示
// ──────────────────────────────────────────────
async function showMapView(token) {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('map-view').style.display   = 'flex';

  if (!map) initMap();
  // 非表示コンテナで初期化したLeafletのサイズを再計算
  setTimeout(() => { if (map) map.invalidateSize(); }, 100);
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

  const sourcesWrap = document.getElementById('ac-detail-sources-wrap');
  const sourcesList = document.getElementById('ac-detail-sources');
  if (Array.isArray(item.sources) && item.sources.length > 0) {
    sourcesList.innerHTML = item.sources.map((s, i) => {
      const title = s.title || s.url;
      const snippet = s.snippet ? `<div class="ac-source-snippet">${s.snippet}</div>` : '';
      return `<li>
        <span class="ac-source-index">${i + 1}.</span>
        <div>
          <a class="ac-source-link" href="${s.url}" target="_blank" rel="noopener noreferrer">${title}</a>
          ${snippet}
        </div>
      </li>`;
    }).join('');
    sourcesWrap.style.display = 'block';
  } else {
    sourcesWrap.style.display = 'none';
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
  // 1. notes の [カテゴリ] 形式
  const m = (item.notes || '').match(/^\[(.+?)\]/);
  if (m) {
    const raw = m[1];
    // 直接マッチ
    if (CAT_NORMALIZE[raw]) return CAT_NORMALIZE[raw];
    if (CAT_COLORS[raw]) return raw;
    // 複合カテゴリ (A・B・C...) → CAT_COLORS にマッチする最初の要素を使う
    const parts = raw.split(/・|、|,/).map(p => p.trim());
    for (const part of parts) {
      const norm = CAT_NORMALIZE[part] ?? part;
      if (CAT_COLORS[norm]) return norm;
    }
    // どれもマッチしなければ先頭要素を返す（フィルタ用）
    return CAT_NORMALIZE[parts[0]] ?? parts[0];
  }

  // 2. category フィールド直指定
  if (item.category) return CAT_NORMALIZE[item.category] ?? item.category;

  // 3. notes + name のキーワードマッチ（カテゴリ未付与アイテム用）
  const text = (item.notes || '') + ' ' + (item.name || '');
  if (/河童/.test(text)) return '河童';
  if (/天狗/.test(text)) return '天狗';
  if (/狐|狐火|九尾/.test(text)) return '狐';
  if (/狸|ムジナ|貉/.test(text)) return '狸';
  if (/狼|山犬/.test(text)) return '狼';
  if (/竜|龍|竜神|竜宮/.test(text)) return '竜神';
  if (/大蛇|蛇神|蛇女|蛇体/.test(text)) return '大蛇';
  if (/幽霊|亡霊|死霊|怨霊/.test(text)) return '幽霊';
  if (/鬼/.test(text)) return '鬼';
  if (/修験|山伏/.test(text)) return '天狗';
  if (/神社|祠|御神木/.test(text)) return '神社怪異';
  if (/地蔵|仏|観音/.test(text)) return '地蔵';
  if (/河伯|水神|水霊|龍神/.test(text)) return '水神';
  if (/付喪神|器物/.test(text)) return '付喪神';
  if (/妖術|妖狐|妖怪/.test(text)) return '妖';

  return '';
}

function extractRegion(item) {
  // raw_content の "場所: 〇〇" を抽出
  const m = (item.raw_content || '').match(/場所:\s*(.+?)(\n|$)/);
  return m ? m[1].trim() : '';
}

function sourceLabel(type) {
  return { academic: '学術文献', web: 'Web', oral: '民間伝承', image: '画像資料' }[type] || type;
}

function translateCognitoError(codeOrMsg) {
  const s = codeOrMsg || '';
  if (s.includes('NotAuthorizedException') || s.includes('Incorrect'))
    return 'メールアドレスまたはパスワードが正しくありません。';
  if (s.includes('UserNotFoundException'))
    return 'アカウントが見つかりません。';
  if (s.includes('UserNotConfirmedException'))
    return 'メールアドレスの確認が完了していません。';
  if (s.includes('PasswordResetRequiredException'))
    return 'パスワードのリセットが必要です。';
  if (s.includes('LimitExceededException'))
    return 'ログイン試行回数が上限に達しました。しばらくお待ちください。';
  if (s.includes('UsernameExistsException'))
    return 'このメールアドレスは既に登録されています。ログインしてください。';
  if (s.includes('InvalidPasswordException'))
    return 'パスワードは8文字以上で、大文字・小文字の英字と数字を含めてください。';
  if (s.includes('InvalidParameterException'))
    return '入力内容を確認してください。';
  if (s.includes('CodeMismatchException'))
    return '確認コードが正しくありません。';
  if (s.includes('ExpiredCodeException'))
    return '確認コードの有効期限が切れています。再送信してください。';
  return s;
}
