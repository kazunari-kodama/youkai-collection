// ============================================================
// 妖怪コレクション Web版
// ============================================================

// --- Device ID (Cookie, 10年) --------------------------------
function getDeviceId() {
  const KEY = 'yokai_device_id';
  const match = document.cookie.match(new RegExp('(?:^|; )' + KEY + '=([^;]+)'));
  if (match) return decodeURIComponent(match[1]);
  const id = crypto.randomUUID();
  const exp = new Date();
  exp.setFullYear(exp.getFullYear() + 10);
  document.cookie = `${KEY}=${id}; expires=${exp.toUTCString()}; path=/; SameSite=Lax`;
  return id;
}

const DEVICE_ID = getDeviceId();
const CAPTURE_RADIUS_M = 13;
const IS_QR_TEST = new URLSearchParams(location.search).get('qr') === '1';

// デバッグ専用ボタンは dev 環境のみ表示
document.getElementById('btn-debug').style.display = IS_DEV ? '' : 'none';
document.getElementById('btn-clear-collection').style.display = IS_DEV ? '' : 'none';
const AIZU_CASTLE = { lat: 37.4946, lon: 139.9293 };
const TOKYO_STATION = { lat: 35.6812, lon: 139.7671 };

let youkaiData = [];      // YokaiListItem[]
let capturedIds = new Map(); // youkaiId → actionType ('seal' | 'bond')

// --- Stamp Rally state --------------------------------------
const rallyState = {
  active: false,
  key: null,
  yokai: [],
  capturedIds: new Set(),
};
let rallyMarkers = {};
let _wakeLock = null;

const state = {
  playerPos: null,
  debugMode: false,
  initialCentered: false,
  pendingUnseal: null,  // YokaiDetail
  currentDetail: null,  // YokaiDetail
  pendingQrCode: null,  // string | null
};

const FACTION_KEY = 'yokai_faction';
let currentFaction = localStorage.getItem(FACTION_KEY) || null;

let map, playerMarker, rangeCircle;
let youkaiMarkers = {};  // id -> { marker, data }

// --- API helpers --------------------------------------------
async function apiGet(path) {
  const res = await fetch(API_BASE_URL + path);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

// --- Initial data load --------------------------------------
async function loadData() {
  setStatus('データを読み込み中…');
  try {
    const [youkai, collection] = await Promise.all([
      apiGet('/youkai'),
      apiGet(`/collection?deviceId=${encodeURIComponent(DEVICE_ID)}`),
    ]);
    youkaiData = youkai;
    capturedIds = new Map(collection.map((c) => [c.youkaiId, c.actionType ?? 'seal']));
    return true;
  } catch (e) {
    setStatus('データ読込失敗: ' + e.message);
    return false;
  }
}

// --- Haversine (クライアント側 事前チェック) -----------------
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Map ----------------------------------------------------
function initMap() {
  map = L.map('map', {
    center: [TOKYO_STATION.lat, TOKYO_STATION.lon],
    zoom: 16,
    zoomControl: false,
    attributionControl: false,
  });

  if (IS_NIGHT) {
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '© OSM © CARTO',
    }).addTo(map);
  } else {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OSM',
    }).addTo(map);
  }

  L.control.zoom({ position: 'topleft' }).addTo(map);
  L.control.attribution({ position: 'bottomleft', prefix: false }).addAttribution(IS_NIGHT ? '© OSM © CARTO' : '© OSM').addTo(map);

  const visibleYoukai = youkaiData.filter((y) => !y.night_only || IS_NIGHT);
  visibleYoukai.forEach((y) => addYoukaiMarker(y));

  map.on('click', (e) => {
    if (state.debugMode) updatePlayerPosition(e.latlng.lat, e.latlng.lng);
  });

  document.getElementById('stat-total').textContent = visibleYoukai.length;
  updateStats();
}

function capturedMarkerHtml(youkai, actionType) {
  const isBond = actionType === 'bond';
  const border  = isBond ? '#9b59f0' : '#c8302a';
  const glow    = isBond ? 'rgba(107,47,160,0.7)' : 'rgba(200,48,42,0.7)';
  const ringStyle = `border-color:${border};box-shadow:0 0 14px ${glow},0 4px 8px rgba(0,0,0,0.6)`;
  const ring = isBond ? 'bond' : 'seal';
  if (youkai.camera_url) {
    return `<div class="captured-marker ${ring}" style="${ringStyle}" data-id="${youkai.id}">` +
      `<img src="${youkai.camera_url}" alt="${youkai.name}" ` +
      `onerror="this.parentElement.className='captured-marker-fallback ${ring}';this.parentElement.style='${ringStyle}';this.remove();this.parentElement.textContent='${youkai.name.charAt(0)}'">` +
      `</div>`;
  }
  return `<div class="captured-marker-fallback ${ring}" style="${ringStyle}" data-id="${youkai.id}">${youkai.name.charAt(0)}</div>`;
}

function addYoukaiMarker(youkai) {
  const actionType = capturedIds.get(youkai.id);
  const isCaptured = actionType !== undefined;
  const icon = L.divIcon({
    className: 'youkai-icon-wrapper',
    html: isCaptured
      ? capturedMarkerHtml(youkai, actionType)
      : `<div class="hitodama-marker" data-id="${youkai.id}"><img src="assets/images/hitodama.png" alt=""></div>`,
    iconSize: isCaptured ? [44, 44] : [36, 36],
    iconAnchor: isCaptured ? [22, 22] : [18, 18],
  });
  const marker = L.marker([youkai.lat, youkai.lon], { icon }).addTo(map);
  marker.on('click', () => handleMarkerTap(youkai));
  youkaiMarkers[youkai.id] = { marker, data: youkai };
}

function refreshMarker(youkaiId) {
  const item = youkaiMarkers[youkaiId];
  if (!item) return;
  map.removeLayer(item.marker);
  delete youkaiMarkers[youkaiId];
  addYoukaiMarker(item.data);
}

async function handleMarkerTap(youkai) {
  if (capturedIds.has(youkai.id)) {
    await showDetail(youkai.id);
    return;
  }
  if (!state.playerPos) {
    showToast('まず現在地を取得してください');
    return;
  }
  const d = distanceMeters(state.playerPos.lat, state.playerPos.lon, youkai.lat, youkai.lon);
  if (d <= CAPTURE_RADIUS_M) {
    if (youkai.require_qr && (!state.debugMode || IS_QR_TEST)) {
      openQrScanner(youkai.id);
    } else {
      if (youkai.require_qr) state.pendingQrCode = youkai.id;
      await triggerUnseal(youkai.id);
    }
  } else {
    showToast(`封印まで残り ${Math.round(d)}m`);
  }
}

// --- Player position ----------------------------------------
function updatePlayerPosition(lat, lon) {
  state.playerPos = { lat, lon };
  if (!state.initialCentered) {
    state.initialCentered = true;
    map.setView([lat, lon], 16);
  }

  if (!playerMarker) {
    const icon = L.divIcon({
      className: 'player-icon-wrapper',
      html: '<div class="player-marker"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    playerMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(map);
    rangeCircle = L.circle([lat, lon], {
      radius: CAPTURE_RADIUS_M,
      color: '#c8302a',
      fillColor: '#c8302a',
      fillOpacity: 0.12,
      weight: 2,
      dashArray: '6 4',
      className: 'range-circle',
    }).addTo(map);
  } else {
    playerMarker.setLatLng([lat, lon]);
    rangeCircle.setLatLng([lat, lon]);
  }

  Object.values(youkaiMarkers).forEach(({ marker, data }) => {
    if (capturedIds.has(data.id)) return;
    const d = distanceMeters(lat, lon, data.lat, data.lon);
    const el = marker.getElement();
    if (!el) return;
    const sealEl = el.querySelector('.hitodama-marker');
    if (!sealEl) return;
    if (d <= CAPTURE_RADIUS_M) {
      sealEl.classList.add('in-range');
      if (!isAnyModalOpen() && (!data.require_qr || (state.debugMode && !IS_QR_TEST))) {
        if (data.require_qr) state.pendingQrCode = data.id;
        triggerUnseal(data.id);
      }
    } else {
      sealEl.classList.remove('in-range');
    }
  });

  // Rally yokai proximity check
  if (rallyState.active) {
    Object.values(rallyMarkers).forEach(({ marker, data }) => {
      if (rallyState.capturedIds.has(data.id)) return;
      const d = distanceMeters(lat, lon, data.lat, data.lon);
      const el = marker.getElement();
      if (!el) return;
      const sealEl = el.querySelector('.rally-marker');
      if (!sealEl) return;
      if (d <= CAPTURE_RADIUS_M) {
        sealEl.classList.add('in-range');
        if (!isAnyModalOpen() && (!data.require_qr || (state.debugMode && !IS_QR_TEST))) {
          if (data.require_qr) state.pendingQrCode = data.id;
          triggerUnseal(data.id);
        }
      } else {
        sealEl.classList.remove('in-range');
      }
    });
  }

  setStatus(
    state.debugMode
      ? `デバッグ位置: ${lat.toFixed(5)}, ${lon.toFixed(5)}`
      : `現在地取得済 (${lat.toFixed(5)}, ${lon.toFixed(5)})`,
  );
}

function startGeolocation() {
  if (!('geolocation' in navigator)) {
    autoEnableDebug();
    return;
  }
  setStatus('位置情報取得中…');
  navigator.geolocation.watchPosition(
    (pos) => updatePlayerPosition(pos.coords.latitude, pos.coords.longitude),
    (err) => {
      console.warn('Geolocation error:', err);
      setStatus(IS_DEV ? '位置情報拒否/失敗 — デバッグONで地図クリック' : '位置情報を取得できませんでした');
      autoEnableDebug();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function autoEnableDebug() {
  if (!IS_DEV) return;
  if (!state.debugMode) toggleDebug();
  updatePlayerPosition(AIZU_CASTLE.lat, AIZU_CASTLE.lon);
}

function centerOnPlayer() {
  if (state.playerPos) {
    map.setView([state.playerPos.lat, state.playerPos.lon], 17);
  } else {
    showToast('位置情報がまだ取得できていません');
  }
}

// --- Unseal flow --------------------------------------------
function isAnyModalOpen() {
  return document.querySelector('.modal-overlay.show') !== null;
}

const _unsealing = new Set();

async function triggerUnseal(youkaiId) {
  if (capturedIds.has(youkaiId) || rallyState.capturedIds.has(youkaiId) || _unsealing.has(youkaiId)) return;
  _unsealing.add(youkaiId);

  let detail;
  try {
    detail = await apiGet(`/youkai/${encodeURIComponent(youkaiId)}`);
  } catch {
    showToast('データ取得失敗');
    _unsealing.delete(youkaiId);
    return;
  }
  _unsealing.delete(youkaiId);

  state.pendingUnseal = detail;

  const talisman = document.getElementById('unseal-talisman');
  const nameEl = document.getElementById('unseal-name');
  talisman.classList.remove('breaking');
  nameEl.classList.remove('appear');

  const isSupernatural = currentFaction === 'supernatural';
  document.getElementById('unseal-headline').textContent = isSupernatural ? '妖 怪 共 存' : '封 印 解 除';
  talisman.textContent = isSupernatural ? '召' : '封';
  talisman.classList.toggle('supernatural', isSupernatural);

  document.getElementById('unseal-name').textContent = detail.name;
  document.getElementById('unseal-desc').textContent = detail.notes || detail.appearance || '(伝承不明)';
  document.getElementById('unseal-meta').textContent =
    `北緯 ${detail.lat.toFixed(5)}  東経 ${detail.lon.toFixed(5)}`;

  const btn = document.getElementById('btn-confirm-capture');
  btn.disabled = false;
  btn.textContent = isSupernatural ? '共 存 の 契 り を 結 ぶ' : '図 鑑 に 封 じ る';

  document.getElementById('unseal-modal').classList.add('show');

  requestAnimationFrame(() => {
    talisman.classList.add('breaking');
    nameEl.classList.add('appear');
  });
}

async function confirmCapture() {
  if (!state.pendingUnseal) return;
  const detail = state.pendingUnseal;

  if (!state.playerPos) {
    showToast('位置情報が取得できていません');
    return;
  }

  const isSupernatural = currentFaction === 'supernatural';
  const btn = document.getElementById('btn-confirm-capture');
  btn.disabled = true;
  btn.textContent = isSupernatural ? '契り結び中…' : '封じ込め中…';

  const captureBody = {
    deviceId: DEVICE_ID,
    youkaiId: detail.id,
    userLat: state.playerPos.lat,
    userLon: state.playerPos.lon,
    actionType: isSupernatural ? 'bond' : 'seal',
    faction: currentFaction ?? 'exorcist',
  };
  if (detail.rally_key) captureBody.rallyKey = detail.rally_key;
  if (state.pendingQrCode) captureBody.qrCode = state.pendingQrCode;

  const result = await apiPost('/capture', captureBody);

  if (!result.ok) {
    btn.disabled = false;
    btn.textContent = isSupernatural ? '共 存 の 契 り を 結 ぶ' : '図 鑑 に 封 じ る';
    if (result.status === 403) {
      showToast('位置が離れすぎています');
    } else {
      showToast('封印失敗: ' + (result.data?.error ?? 'エラー'));
    }
    return;
  }

  const isRally = !!detail.rally_key;
  if (isRally) {
    rallyState.capturedIds.add(detail.id);
    refreshRallyMarker(detail.id);
    updateRallyStats();
  } else {
    capturedIds.set(detail.id, isSupernatural ? 'bond' : 'seal');
    refreshMarker(detail.id);
    updateStats();
  }

  closeUnseal();
  state.pendingUnseal = null;

  if (isRally && rallyState.capturedIds.size === rallyState.yokai.length) {
    showToast('スタンプコンプリート！受付に図鑑を提示してください');
    setTimeout(() => openRallyCollection(), 1200);
  } else {
    showToast(isSupernatural
      ? `「${detail.name}」と共存の契りを結んだ`
      : `「${detail.name}」を図鑑に封じた`);
  }
}

function closeUnseal() {
  document.getElementById('unseal-modal').classList.remove('show');
  state.pendingUnseal = null;
  state.pendingQrCode = null;
}

// --- Detail modal -------------------------------------------
async function showDetail(youkaiId) {
  let detail;
  try {
    detail = await apiGet(`/youkai/${encodeURIComponent(youkaiId)}`);
  } catch {
    showToast('詳細データ取得失敗');
    return;
  }

  state.currentDetail = detail;

  document.getElementById('detail-name').textContent = detail.name;
  document.getElementById('detail-desc').textContent =
    detail.notes || detail.appearance || '(伝承不明)';
  const metaEl = document.getElementById('detail-meta');
  metaEl.textContent = `北緯 ${detail.lat.toFixed(5)}  東経 ${detail.lon.toFixed(5)}`;
  metaEl.style.cursor = 'pointer';
  metaEl.onclick = () => { closeDetail(); map.flyTo([detail.lat, detail.lon], 17); };

  const img = document.getElementById('detail-img');
  if (detail.camera_url) {
    img.src = detail.camera_url;
    img.style.display = 'block';
    img.onerror = () => { img.style.display = 'none'; };
  } else {
    img.style.display = 'none';
  }

  document.getElementById('detail-modal').classList.add('show');
}

function closeDetail() {
  document.getElementById('detail-modal').classList.remove('show');
}

// --- Yokai Camera -------------------------------------------
let _cameraStream = null;

// Overlay drag / pinch state
const _ov = {
  stage: null,
  x: 0, y: 0,       // center position within stage (px)
  w: 0,              // display width (px)
  corsImg: null,     // crossOrigin='anonymous' copy for canvas drawing
  drag: false,
  dragOx: 0, dragOy: 0,
  pinch: false,
  pinchDist0: 1,
  pinchW0: 0,
  pinchMx: 0, pinchMy: 0,
  pinchX0: 0, pinchY0: 0,
};

function _ovApply() {
  const el = document.getElementById('camera-youkai-overlay');
  el.style.left = `${_ov.x}px`;
  el.style.top  = `${_ov.y}px`;
  el.style.width = `${_ov.w}px`;
}

function _ovInit() {
  _ov.stage = document.getElementById('camera-stage');
  const sw = _ov.stage.offsetWidth;
  const sh = _ov.stage.offsetHeight;
  _ov.w = sw * 0.40;
  _ov.x = sw * 0.72;
  _ov.y = sh * 0.68;
  _ovApply();

  const el = document.getElementById('camera-youkai-overlay');
  el.addEventListener('touchstart',  _ovTouchStart,  { passive: false });
  el.addEventListener('touchmove',   _ovTouchMove,   { passive: false });
  el.addEventListener('touchend',    _ovTouchEnd);
  el.addEventListener('touchcancel', _ovTouchEnd);
  el.addEventListener('mousedown',   _ovMouseDown);
}

function _ovCleanup() {
  const el = document.getElementById('camera-youkai-overlay');
  el.removeEventListener('touchstart',  _ovTouchStart);
  el.removeEventListener('touchmove',   _ovTouchMove);
  el.removeEventListener('touchend',    _ovTouchEnd);
  el.removeEventListener('touchcancel', _ovTouchEnd);
  el.removeEventListener('mousedown',   _ovMouseDown);
  _ov.drag = false;
  _ov.pinch = false;
  _ov.stage = null;
  _ov.corsImg = null;
}

function _ovTouchStart(e) {
  e.preventDefault();
  const r = _ov.stage.getBoundingClientRect();
  if (e.touches.length === 1) {
    _ov.pinch = false;
    _ov.drag  = true;
    _ov.dragOx = _ov.x - (e.touches[0].clientX - r.left);
    _ov.dragOy = _ov.y - (e.touches[0].clientY - r.top);
  } else if (e.touches.length >= 2) {
    _ov.drag  = false;
    _ov.pinch = true;
    const t0 = e.touches[0], t1 = e.touches[1];
    _ov.pinchDist0 = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY) || 1;
    _ov.pinchW0    = _ov.w;
    _ov.pinchMx    = (t0.clientX + t1.clientX) / 2 - r.left;
    _ov.pinchMy    = (t0.clientY + t1.clientY) / 2 - r.top;
    _ov.pinchX0    = _ov.x;
    _ov.pinchY0    = _ov.y;
  }
}

function _ovTouchMove(e) {
  e.preventDefault();
  const r = _ov.stage.getBoundingClientRect();
  if (_ov.drag && e.touches.length === 1) {
    _ov.x = e.touches[0].clientX - r.left + _ov.dragOx;
    _ov.y = e.touches[0].clientY - r.top  + _ov.dragOy;
    _ovApply();
  } else if (_ov.pinch && e.touches.length >= 2) {
    const t0 = e.touches[0], t1 = e.touches[1];
    const dist  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const ratio = dist / _ov.pinchDist0;
    _ov.w = Math.max(60, Math.min(_ov.pinchW0 * ratio, _ov.stage.offsetWidth * 0.95));
    const mx = (t0.clientX + t1.clientX) / 2 - r.left;
    const my = (t0.clientY + t1.clientY) / 2 - r.top;
    _ov.x = _ov.pinchX0 + (mx - _ov.pinchMx);
    _ov.y = _ov.pinchY0 + (my - _ov.pinchMy);
    _ovApply();
  }
}

function _ovTouchEnd(e) {
  if (e.touches.length === 0) {
    _ov.drag = false;
    _ov.pinch = false;
  } else if (e.touches.length === 1 && _ov.pinch) {
    // ピンチ → ドラッグへ切り替え
    _ov.pinch = false;
    _ov.drag  = true;
    const r = _ov.stage.getBoundingClientRect();
    _ov.dragOx = _ov.x - (e.touches[0].clientX - r.left);
    _ov.dragOy = _ov.y - (e.touches[0].clientY - r.top);
  }
}

function _ovMouseDown(e) {
  e.preventDefault();
  _ov.drag = true;
  const r = _ov.stage.getBoundingClientRect();
  _ov.dragOx = _ov.x - (e.clientX - r.left);
  _ov.dragOy = _ov.y - (e.clientY - r.top);
  const onMove = (ev) => {
    const r2 = _ov.stage.getBoundingClientRect();
    _ov.x = ev.clientX - r2.left + _ov.dragOx;
    _ov.y = ev.clientY - r2.top  + _ov.dragOy;
    _ovApply();
  };
  const onUp = () => {
    _ov.drag = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup',   onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup',   onUp);
}

async function openCamera() {
  const detail = state.currentDetail;
  if (!detail) return;

  document.getElementById('camera-result').classList.remove('show');
  document.getElementById('camera-video').style.display = 'block';
  document.getElementById('btn-shutter').disabled = false;
  document.getElementById('camera-modal').classList.add('show');

  const overlay = document.getElementById('camera-youkai-overlay');
  if (detail.camera_url) {
    overlay.src = detail.camera_url;
    overlay.style.display = 'none'; // JS で位置確定後に表示
    requestAnimationFrame(() => {
      overlay.style.display = 'block';
      _ovInit();
    });
    // canvas 描画用: crossOrigin='anonymous' で別途ロード (tainted canvas 回避)
    const ci = new Image();
    ci.crossOrigin = 'anonymous';
    ci.src = detail.camera_url;
    _ov.corsImg = ci;
  } else {
    overlay.style.display = 'none';
    _ov.corsImg = null;
  }

  try {
    _cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const vid = document.getElementById('camera-video');
    vid.srcObject = _cameraStream;
    vid.play().catch(() => {});
  } catch {
    showToast('カメラの起動に失敗しました');
    closeCamera();
  }
}

async function capturePhoto() {
  const video   = document.getElementById('camera-video');
  const canvas  = document.getElementById('camera-canvas');
  const overlay = document.getElementById('camera-youkai-overlay');

  // ビデオフレームがまだ来ていない場合は待機を促す
  if (video.readyState < 2) {
    showToast('カメラ準備中… もう一度押してください');
    return;
  }

  const w = video.videoWidth  || 640;
  const h = video.videoHeight || 480;
  canvas.width  = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');

  try {
    // ミラー反転 (インカメ自然表示)
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();
  } catch (e) {
    showToast('撮影に失敗しました: ' + e.message);
    return;
  }

  // 妖怪オーバーレイ: crossOrigin 済み画像を使って tainted canvas を回避
  if (_ov.corsImg && _ov.stage) {
    await new Promise((resolve) => {
      const img = _ov.corsImg;
      const draw = () => {
        const sw = _ov.stage.offsetWidth;
        const sh = _ov.stage.offsetHeight;
        const scX = w / sw;
        const scY = h / sh;
        const cw  = _ov.w * scX;
        const ch  = (img.naturalHeight / img.naturalWidth) * cw;
        ctx.globalAlpha = 0.90;
        ctx.drawImage(img, _ov.x * scX - cw / 2, _ov.y * scY - ch / 2, cw, ch);
        ctx.globalAlpha = 1.0;
        resolve();
      };
      if (img.complete && img.naturalWidth > 0) {
        draw();
      } else {
        img.onload  = draw;
        img.onerror = () => resolve(); // 画像なしで続行
      }
    });
  }

  // ウォーターマーク
  const fs = Math.max(12, Math.round(h * 0.028));
  ctx.font      = `bold ${fs}px 'Shippori Mincho B1', serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.textAlign = 'left';
  ctx.fillText('妖怪コレクション', w * 0.025, h - fs * 0.6);

  document.getElementById('result-img').src = canvas.toDataURL('image/jpeg', 0.92);
  document.getElementById('camera-video').style.display = 'none';
  document.getElementById('camera-result').classList.add('show');
}

function retakePhoto() {
  document.getElementById('camera-result').classList.remove('show');
  document.getElementById('camera-video').style.display = 'block';
}

function savePhoto() {
  const canvas   = document.getElementById('camera-canvas');
  const name     = state.currentDetail?.name ?? 'yokai';
  const filename = `yokai_${name}_${Date.now()}.jpg`;

  canvas.toBlob((blob) => {
    if (navigator.share) {
      const file = new File([blob], filename, { type: 'image/jpeg' });
      navigator.share({ files: [file], title: `妖怪コレクション — ${name}` }).catch(() => {
        _openImageTab(blob);
      });
    } else {
      _openImageTab(blob);
    }
  }, 'image/jpeg', 0.92);
}

function _openImageTab(blob) {
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  // ポップアップブロック時はフォールバック
  if (!win) {
    const a = document.createElement('a');
    a.href     = url;
    a.download = `yokai_${Date.now()}.jpg`;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function closeCamera() {
  _ovCleanup();
  if (_cameraStream) {
    _cameraStream.getTracks().forEach((t) => t.stop());
    _cameraStream = null;
  }
  const video = document.getElementById('camera-video');
  video.srcObject = null;
  document.getElementById('camera-result').classList.remove('show');
  document.getElementById('camera-modal').classList.remove('show');
}

// --- Collection modal ---------------------------------------
function openCollection() {
  const content = document.getElementById('collection-content');
  let html = '<div class="collection-grid">';
  youkaiData.forEach((y) => {
    const captured = capturedIds.has(y.id);
    if (captured) {
      html += `
        <div class="collection-card" onclick="closeCollectionAndDetail('${y.id}')">
          <div class="ck-img"><img src="${y.camera_url}" alt="${y.name}" onerror="this.style.display='none'"></div>
          <div class="ck-name">${y.name}</div>
        </div>`;
    } else {
      html += `
        <div class="collection-card locked">
          <div class="ck-glyph">？</div>
          <div class="ck-name">？？？</div>
          <div class="ck-dist">○ 未発見</div>
        </div>`;
    }
  });
  html += '</div>';
  content.innerHTML = html;
  document.getElementById('collection-modal').classList.add('show');
}

function closeCollection() {
  document.getElementById('collection-modal').classList.remove('show');
}

async function closeCollectionAndDetail(id) {
  closeCollection();
  await showDetail(id);
}

// --- Misc ---------------------------------------------------
function updateStats() {
  document.getElementById('stat-captured').textContent = capturedIds.size;
}

function setStatus(msg) {
  document.getElementById('status-bar').textContent = msg;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function toggleDebug() {
  state.debugMode = !state.debugMode;
  const btn = document.getElementById('btn-debug');
  const label = document.getElementById('debug-state');
  if (state.debugMode) {
    btn.classList.add('active');
    label.textContent = 'ON';
    showToast('デバッグ ON: 地図をタップで現在地に');
  } else {
    btn.classList.remove('active');
    label.textContent = 'OFF';
    showToast('デバッグ OFF: GPSに切替');
    startGeolocation();
  }
}

async function clearCollection() {
  if (!confirm('図鑑データをすべてクリアしますか？\n（この操作はサーバーのデータも削除します）')) return;
  try {
    const res = await fetch(`${API_BASE_URL}/collection?deviceId=${encodeURIComponent(DEVICE_ID)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(await res.text());
    const { deleted } = await res.json();
    capturedIds = new Map();
    rallyState.capturedIds = new Set();
    // マーカーを未捕獲状態に更新
    Object.values(youkaiMarkers).forEach(({ marker, data }) => {
      const el = marker.getElement();
      if (el) el.classList.remove('captured');
    });
    Object.values(rallyMarkers).forEach(({ marker }) => {
      const el = marker.getElement();
      if (el) el.classList.remove('captured');
    });
    document.getElementById('stat-captured').textContent = '0';
    showToast(`図鑑クリア完了 (${deleted}件削除)`);
  } catch (e) {
    showToast('クリアに失敗しました: ' + e.message, true);
  }
}

function waitForLeaflet(callback, attempt = 0) {
  if (typeof L !== 'undefined' && L.map) { callback(); return; }
  if (attempt > 100) { setStatus('Leaflet読込失敗'); return; }
  setTimeout(() => waitForLeaflet(callback, attempt + 1), 100);
}

// --- Faction management ----------------------------------------
function updateFactionHUD() {
  const badge = document.getElementById('faction-badge');
  if (!badge) return;
  if (currentFaction === 'supernatural') {
    badge.textContent = '超自然派';
    badge.className = 'faction-badge supernatural';
  } else {
    badge.textContent = '祓い手';
    badge.className = 'faction-badge exorcist';
  }
}

function showFactionModal() {
  document.getElementById('faction-modal').classList.add('show');
}

function chooseFaction(f) {
  currentFaction = f;
  localStorage.setItem(FACTION_KEY, f);
  document.getElementById('faction-modal').classList.remove('show');
  updateFactionHUD();
  showToast(f === 'supernatural' ? '超自然派として歩む道を選んだ' : '祓い手として封印の道を歩む');
}

async function dismissIntro() {
  document.getElementById('intro').classList.add('hide');
  setTimeout(async () => {
    document.getElementById('intro').style.display = 'none';
    const ok = await loadData();
    if (!ok) return;
    waitForLeaflet(async () => {
      initMap();
      startGeolocation();
      await restoreRallyFromStorage();
    });
    if (!currentFaction) showFactionModal();
  }, 600);
}

// --- Stamp Rally ------------------------------------------------

function rallyMarkerHtml(youkai) {
  if (rallyState.capturedIds.has(youkai.id)) {
    if (youkai.camera_url) {
      return `<div class="rally-captured-marker" data-id="${youkai.id}">` +
        `<img src="${youkai.camera_url}" alt="${youkai.name}" ` +
        `onerror="this.parentElement.className='rally-captured-marker-fallback';this.remove();this.parentElement.textContent='${youkai.name.charAt(0)}'">` +
        `</div>`;
    }
    return `<div class="rally-captured-marker-fallback" data-id="${youkai.id}">${youkai.name.charAt(0)}</div>`;
  }
  return `<div class="rally-marker" data-id="${youkai.id}">★</div>`;
}

function addRallyMarker(youkai) {
  const isCaptured = rallyState.capturedIds.has(youkai.id);
  const icon = L.divIcon({
    className: 'youkai-icon-wrapper',
    html: rallyMarkerHtml(youkai),
    iconSize: isCaptured ? [44, 44] : [36, 36],
    iconAnchor: isCaptured ? [22, 22] : [18, 18],
  });
  const marker = L.marker([youkai.lat, youkai.lon], { icon }).addTo(map);
  marker.on('click', () => handleRallyMarkerTap(youkai));
  rallyMarkers[youkai.id] = { marker, data: youkai };
}

function refreshRallyMarker(youkaiId) {
  const item = rallyMarkers[youkaiId];
  if (!item) return;
  map.removeLayer(item.marker);
  delete rallyMarkers[youkaiId];
  addRallyMarker(item.data);
}

async function handleRallyMarkerTap(youkai) {
  if (rallyState.capturedIds.has(youkai.id)) {
    await showDetail(youkai.id);
    return;
  }
  if (!state.playerPos) { showToast('まず現在地を取得してください'); return; }
  const d = distanceMeters(state.playerPos.lat, state.playerPos.lon, youkai.lat, youkai.lon);
  if (d <= CAPTURE_RADIUS_M) {
    if (youkai.require_qr && (!state.debugMode || IS_QR_TEST)) {
      openQrScanner(youkai.id);
    } else {
      if (youkai.require_qr) state.pendingQrCode = youkai.id;
      await triggerUnseal(youkai.id);
    }
  } else {
    showToast(`封印まで残り ${Math.round(d)}m`);
  }
}

async function activateRallyMode(key, data) {
  rallyState.active = true;
  rallyState.key = key;
  rallyState.yokai = data.yokai;

  try {
    const col = await apiGet(`/rally/collection?deviceId=${encodeURIComponent(DEVICE_ID)}&key=${encodeURIComponent(key)}`);
    rallyState.capturedIds = new Set(col.map((c) => c.youkaiId));
  } catch {
    rallyState.capturedIds = new Set();
  }

  localStorage.setItem('rallyKey', key);
  rallyState.yokai.forEach((y) => addRallyMarker(y));
  updateRallyStats();
}

async function restoreRallyFromStorage() {
  const key = localStorage.getItem('rallyKey');
  if (!key) return;
  try {
    const data = await apiGet(`/rally?key=${encodeURIComponent(key)}`);
    await activateRallyMode(key, data);
  } catch {
    localStorage.removeItem('rallyKey');
  }
}

function updateRallyStats() {
  const btn = document.getElementById('btn-rally');
  const label = document.getElementById('rally-btn-label');
  if (rallyState.active) {
    btn.classList.add('active');
    label.textContent = `スタンプ ${rallyState.capturedIds.size}/${rallyState.yokai.length}`;
  } else {
    btn.classList.remove('active');
    label.textContent = 'スタンプラリー';
  }
}

function openRallyEntry() {
  if (rallyState.active) { openRallyCollection(); return; }
  document.getElementById('rally-key-input').value = '';
  document.getElementById('rally-entry-error').textContent = '';
  document.getElementById('rally-entry-modal').classList.add('show');
}

function closeRallyEntry() {
  document.getElementById('rally-entry-modal').classList.remove('show');
}

async function submitRallyKey() {
  const key = document.getElementById('rally-key-input').value.trim();
  if (!key) { document.getElementById('rally-entry-error').textContent = 'キーを入力してください'; return; }

  const btn = document.getElementById('btn-rally-join');
  btn.disabled = true;
  btn.textContent = '確認中…';
  document.getElementById('rally-entry-error').textContent = '';

  try {
    const data = await apiGet(`/rally?key=${encodeURIComponent(key)}`);
    await activateRallyMode(key, data);
    closeRallyEntry();
    showToast(`スタンプラリー開始！${data.yokai.length}体を集めよう`);
  } catch (e) {
    document.getElementById('rally-entry-error').textContent =
      e.message === '404' ? 'キーが無効です' : '通信エラーが発生しました';
  } finally {
    btn.disabled = false;
    btn.textContent = '参 加 す る';
  }
}

function openRallyCollection() {
  const total = rallyState.yokai.length;
  const done  = rallyState.capturedIds.size;
  const isComplete = total > 0 && done === total;

  document.getElementById('rally-progress').textContent = `${done} / ${total}`;
  document.getElementById('rally-complete-banner').style.display = isComplete ? 'block' : 'none';

  const content = document.getElementById('rally-collection-content');
  let html = '<div class="collection-grid">';
  rallyState.yokai.forEach((y) => {
    if (rallyState.capturedIds.has(y.id)) {
      html += `<div class="collection-card" onclick="closeRallyCollectionAndDetail('${y.id}')">
        <div class="ck-img"><img src="${y.camera_url}" alt="${y.name}" onerror="this.style.display='none'"></div>
        <div class="ck-name">${y.name}</div>
        <span class="ck-stamp-overlay">★</span>
      </div>`;
    } else {
      html += `<div class="collection-card locked">
        <div class="ck-glyph">？</div>
        <div class="ck-name">？？？</div>
      </div>`;
    }
  });
  html += '</div>';
  content.innerHTML = html;

  document.getElementById('rally-collection-modal').classList.add('show');
  if (isComplete) _requestWakeLock();
}

function closeRallyCollection() {
  document.getElementById('rally-collection-modal').classList.remove('show');
  _releaseWakeLock();
}

async function closeRallyCollectionAndDetail(id) {
  closeRallyCollection();
  await showDetail(id);
}

function exitRallyMode() {
  Object.values(rallyMarkers).forEach(({ marker }) => map.removeLayer(marker));
  rallyMarkers = {};
  rallyState.active = false;
  rallyState.key = null;
  rallyState.yokai = [];
  rallyState.capturedIds.clear();
  localStorage.removeItem('rallyKey');
  updateRallyStats();
  closeRallyCollection();
  showToast('スタンプラリーを終了しました');
}

async function _requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { _wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
}
function _releaseWakeLock() {
  _wakeLock?.release();
  _wakeLock = null;
}

// --- QR Scanner ------------------------------------------------
let _qrStream = null;
let _qrTargetId = null;
let _qrAnimFrame = null;

function openQrScanner(youkaiId) {
  _qrTargetId = youkaiId;
  document.getElementById('qr-status').textContent = '';
  document.getElementById('qr-modal').classList.add('show');
  _startQrCamera();
}

async function _startQrCamera() {
  try {
    _qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    if (!_qrTargetId) { _qrStream.getTracks().forEach((t) => t.stop()); _qrStream = null; return; }
    const video = document.getElementById('qr-video');
    video.srcObject = _qrStream;
    await video.play();
    _qrAnimFrame = requestAnimationFrame(_scanQrFrame);
  } catch {
    showToast('カメラの起動に失敗しました');
    closeQrScanner();
  }
}

function _scanQrFrame() {
  if (!_qrTargetId) return;
  const video = document.getElementById('qr-video');
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const canvas = document.getElementById('qr-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
    if (code) {
      if (code.data === _qrTargetId) {
        const targetId = _qrTargetId;
        state.pendingQrCode = code.data;
        closeQrScanner();
        triggerUnseal(targetId);
        return;
      } else {
        document.getElementById('qr-status').textContent = 'このQRコードは対象外です';
      }
    }
  }
  _qrAnimFrame = requestAnimationFrame(_scanQrFrame);
}

function closeQrScanner() {
  cancelAnimationFrame(_qrAnimFrame);
  _qrAnimFrame = null;
  if (_qrStream) {
    _qrStream.getTracks().forEach((t) => t.stop());
    _qrStream = null;
  }
  _qrTargetId = null;
  document.getElementById('qr-modal').classList.remove('show');
}

updateFactionHUD();

// モーダル背景クリックで閉じる
document.querySelectorAll('.modal-overlay').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m) {
      if (m.id === 'qr-modal') { closeQrScanner(); return; }
      m.classList.remove('show');
    }
  });
});
