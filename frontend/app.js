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
let capturedIds  = new Map(); // youkaiId → actionType ('seal' | 'bond' | 'in_progress')
let sealProgress = new Map(); // youkaiId → { progress, required }
let trueNameLearned = new Set(); // youkaiId — bond 済みで言霊術使用済み

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

const ROLE_KEY = 'yokai_role';
let currentRole = localStorage.getItem(ROLE_KEY) || null;

const QUIZ_QUESTIONS = [
  { id:1, phase:'F',
    situation:'山深き村の祭りに、そなたは招かれた。\n村人らは皆、何かに怯えておるように見える。\nされど、祭りは行われる。',
    question:'そなたは、いかにする。',
    options:[
      {text:'村の長に話を聞き、何に怯えておるのかを、まず知る', v:'E'},
      {text:'怯える老人の傍らに座し、ただ静かに寄り添う', v:'E'},
      {text:'祭りの中心に立ち、神楽の音に耳を澄ます', v:'S'},
      {text:'怯えの源を確かめんと、一人、夜の山へ分け入る', v:'S'},
    ]},
  { id:2, phase:'F',
    situation:'廃れた神社の前を、そなたは通りかかった。\n鳥居は朽ち、扉は半ば開いておる。\n内より、微かな気配が漂う。',
    question:'そなたは、いかにする。',
    options:[
      {text:'鳥居の前に一礼し、扉を静かに閉じて立ち去る', v:'E'},
      {text:'塩を撒き、結界を張り直して、その場を後にする', v:'E'},
      {text:'扉を開け放ち、しばし、内なる気配と向き合う', v:'S'},
      {text:'内へと足を踏み入れ、そこに在る者を確かめる', v:'S'},
    ]},
  { id:3, phase:'F',
    situation:'親しき友が、近頃、様子がおかしい。\n問えば、「夜ごと、誰かに呼ばれておる気がする」と言う。',
    question:'そなたは、いかにする。',
    options:[
      {text:'護符を渡し、しばし祈祷に通い、友を護る', v:'E'},
      {text:'信頼できる社に連れゆき、祓いを受けさせる', v:'E'},
      {text:'友と共に、その「誰か」が何者であるかを聴きにゆく', v:'S'},
      {text:'友の感覚を否定せず、その意味を共に考える', v:'S'},
    ]},
  { id:4, phase:'F',
    situation:'古の書物に、妖を扱う術が記されておる。\n読み解けば力を得られよう。されど、術には危うさが伴う。',
    question:'そなたは、いかにする。',
    options:[
      {text:'全体を分析し、危うきを避ける道筋から学ぶ', v:'E'},
      {text:'必要な時に必要な箇所のみを読み、深入りはせぬ', v:'E'},
      {text:'書物を信ずる師に預け、共に少しずつ読み解く', v:'S'},
      {text:'危うさも含めて全てを読み、己の内に取り込む', v:'S'},
    ]},
  { id:5, phase:'S',
    situation:'目の前に、人ならぬ者が現れた。\n害をなす気配はない。されど、人ではない。',
    question:'そなたは、いかにする。',
    options:[
      {text:'その性質を観察し、何者であるかを見極める', v:'C'},
      {text:'距離を保ち、向こうから語りかけてくるのを待つ', v:'X'},
      {text:'名を問い、何を求めて在るのかを聴く', v:'T'},
      {text:'同じ目線まで近づき、その存在を感じ取らんとする', v:'X'},
    ]},
  { id:6, phase:'S',
    situation:'',
    question:'力を得るとは、そなたにとって、いかなることか。',
    options:[
      {text:'法則を理解し、この世の理を読み解けるようになること', v:'C'},
      {text:'目の前の誰かを、確かに支えられるようになること', v:'X'},
      {text:'力に頼らずに済む生き方を、見出すこと', v:'T'},
      {text:'己自身が、これまでとは違う何ものかへと変じてゆくこと', v:'T'},
    ]},
  { id:7, phase:'S',
    situation:'もし、明治の御代より前のごとく、\n妖と人が隣り合うて暮らす世が再び訪れるとせば——',
    question:'そなたは、いかに思う。',
    options:[
      {text:'それは混乱を招く。境は保たれておるべきである', v:'C'},
      {text:'一部は戻りてもよし。されど線引きは慎重であるべき', v:'X'},
      {text:'喜ばしきこと。失われた豊かさが戻ろう', v:'T'},
      {text:'完全な共存こそ、本来の在り方であった', v:'X'},
    ]},
  { id:8, phase:'S',
    situation:'',
    question:'そなたが「視える者」として、最も恐るることは何か。',
    options:[
      {text:'誤れる判断にて、人や妖を傷つけてしまうこと', v:'C'},
      {text:'助くべき相手を、助けられぬこと', v:'X'},
      {text:'力を持つことに、慣れてしまうこと', v:'T'},
      {text:'己が「己」でなくなりてゆくこと', v:'T'},
    ]},
];

const ROLE_INFO = {
  onmyoji:    {kanji:'陰陽師', reading:'おんみょうじ', faction:'exorcist',    factionName:'祓い手', emblem:'陰', color:'#1e5fa8', tagline:'暦と式で秩序を読む者',         desc:'世界には法則がある。星の運行、五行の巡り、暦の節目——すべては読み解ける。妖怪もまた、その法則の中にある現象に過ぎない。理解できれば、制御できる。感情より論理、式神は道具——それが陰陽師の道。'},
  kitoshi:    {kanji:'祈祷師', reading:'きとうし',     faction:'exorcist',    factionName:'祓い手', emblem:'祈', color:'#e8e0d0', tagline:'個別の祈りで穢れを祓う者',   desc:'理屈ではなく、祈りの力で人と土地を守る。一軒の家、一人の病者、一つの土地——目の前の具体的な誰かのために、術を尽くす。派手な術より、毎日の祈祷の積み重ねを重んじる——それが祈祷師の道。'},
  miko:       {kanji:'神子',   reading:'みこ',         faction:'exorcist',    factionName:'祓い手', emblem:'神', color:'#c8302a', tagline:'神意を聴き、判別し、橋渡す者', desc:'神意を聴き、判別し、人と神の境を結ぶ。自らの意志を前に出すことはないが、何を伝え、何を留めるかを判別する鋭さを持つ。「これは神の声か、自分の声か」——その問いを生涯問い続ける者。'},
  yojutsushi: {kanji:'妖術師', reading:'ようじゅつし', faction:'supernatural', factionName:'招き手', emblem:'妖', color:'#b8860b', tagline:'妖の力を借り、契約する者',   desc:'妖怪は契約相手だ。互いに利のある取り決めをすれば、共に在れる。使役でも服従でもなく、交渉——それが妖術師の矜持。妖怪を「取引相手」として尊重する。情に流されない、契約は契約。'},
  yamabushi:  {kanji:'山伏',   reading:'やまぶし',     faction:'supernatural', factionName:'招き手', emblem:'山', color:'#2d6e3e', tagline:'自ら山に分け入り、近づく者', desc:'山に入り、滝に打たれ、火を焚く中で、人は妖に近づく。妖もまた、人に近づく。人と妖の境など、本来なかった。自らが変容することで、世界の縫い目に近づく——それが山伏の道。'},
  jujutsushi: {kanji:'呪術師', reading:'じゅじゅつし', faction:'supernatural', factionName:'招き手', emblem:'呪', color:'#8b2fc9', tagline:'呪を編み、世界を書き換える者', desc:'言葉と象徴には力がある。呪を編み、紋を描き、名を与えることで世界は書き換えられる。妖の力もまた、写し取れる。陰陽師が「読み解く」なら、呪術師は「書き換える」——描くほど、世界はずれていく。'},
};

let _quiz = null;

let map, playerMarker, rangeCircle;
let youkaiMarkers = {};  // id -> { marker, data }

// --- API helpers --------------------------------------------
async function apiGet(path) {
  const res = await fetch(API_BASE_URL + path);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const payload = state.debugMode ? { ...body, debug: true } : body;
  const res = await fetch(API_BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
    capturedIds  = new Map(collection.map((c) => [c.youkaiId, c.actionType ?? 'seal']));
    sealProgress = new Map(
      collection
        .filter((c) => c.actionType === 'in_progress' && c.seal_progress != null)
        .map((c) => [c.youkaiId, { progress: c.seal_progress, required: c.seal_required }])
    );
    trueNameLearned = new Set(
      collection.filter((c) => c.true_name_learned).map((c) => c.youkaiId)
    );
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

function _hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function capturedMarkerHtml(youkai, actionType) {
  const isBond = actionType === 'bond';
  const roleInfo = currentRole && ROLE_INFO[currentRole];
  const border  = roleInfo ? roleInfo.color : (isBond ? '#9b59f0' : '#c8302a');
  const glow    = _hexToRgba(border, 0.7);
  const ringStyle = `border:2px solid ${border};box-shadow:0 0 14px ${glow},0 4px 8px rgba(0,0,0,0.6)`;
  const ring = isBond ? 'bond' : 'seal';
  console.log('[marker]', youkai.id, actionType, ring, border);
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
  const isCaptured = actionType === 'seal' || actionType === 'bond';
  const isInProgress = actionType === 'in_progress';
  const prog = sealProgress.get(youkai.id);

  let markerHtml;
  if (isCaptured) {
    markerHtml = capturedMarkerHtml(youkai, actionType);
  } else if (isInProgress && prog) {
    const pct = Math.round((prog.progress / prog.required) * 100);
    markerHtml = `<div class="hitodama-marker" data-id="${youkai.id}" style="position:relative">` +
      `<img src="assets/images/hitodama.png" alt="">` +
      `<div class="marker-progress-wrap"><div class="marker-progress-fill" style="width:${pct}%"></div></div>` +
      `</div>`;
  } else {
    markerHtml = `<div class="hitodama-marker" data-id="${youkai.id}"><img src="assets/images/hitodama.png" alt=""></div>`;
  }

  const icon = L.divIcon({
    className: 'youkai-icon-wrapper',
    html: markerHtml,
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
  // 飛翔式神モード中はこのマーカーを目標に発射
  if (state.hishoMode) {
    await _launchHishoTo(youkai.id);
    return;
  }
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
  } else if (d <= DOKAISHU_RANGE_M && currentRole === 'onmyoji') {
    _showDokaishuOption(youkai, Math.round(d));
  } else {
    showToast(`封印まで残り ${Math.round(d)}m`);
  }
}

// --- Player position ----------------------------------------
function updatePlayerPosition(lat, lon) {
  _onWalkPosition(lat, lon);
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
  const at = capturedIds.get(youkaiId);
  if ((at === 'seal' || at === 'bond') || rallyState.capturedIds.has(youkaiId) || _unsealing.has(youkaiId)) return;
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
    } else if (result.status === 402) {
      const cur = result.data?.current ?? 0;
      const req = result.data?.required ?? 0;
      showToast(`術力不足（${cur}/${req}）— 歩くか時間を置いて回復`);
      _jutsu.current = cur;
      _renderJutsuHUD();
    } else {
      showToast('封印失敗: ' + (result.data?.error ?? 'エラー'));
    }
    return;
  }

  const isRally   = !!detail.rally_key;
  const resData   = result.data ?? {};
  const isSealed  = resData.sealed === true;
  const inProgress = resData.sealed === false;

  if (inProgress) {
    // 封印途中 — 進捗を更新してマーカーゲージを再描画
    sealProgress.set(detail.id, { progress: resData.progress, required: resData.required });
    capturedIds.set(detail.id, 'in_progress');
    refreshMarker(detail.id);
    closeUnseal();
    state.pendingUnseal = null;
    showToast(`封印進行中 ${resData.progress}/${resData.required}（${resData.rank_name ?? ''}）`, 2500);
    return;
  }

  if (isRally) {
    rallyState.capturedIds.add(detail.id);
    refreshRallyMarker(detail.id);
    updateRallyStats();
  } else {
    capturedIds.set(detail.id, isSupernatural ? 'bond' : 'seal');
    sealProgress.delete(detail.id);
    refreshMarker(detail.id);
    updateStats();
  }

  closeUnseal();
  state.pendingUnseal = null;

  if (isRally && rallyState.capturedIds.size === rallyState.yokai.length) {
    showToast('スタンプコンプリート！受付に図鑑を提示してください');
    setTimeout(() => openRallyCollection(), 1200);
  } else {
    const rankLabel = resData.rank_name ? `【${resData.rank_name}】` : '';
    showToast(isSupernatural
      ? `${rankLabel}「${detail.name}」と共存の契りを結んだ`
      : `${rankLabel}「${detail.name}」を図鑑に封じた`);
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

  // 妖怪別勢力メーター（非同期・失敗しても表示に影響しない）
  loadYokaiStats(youkaiId);
}

function closeDetail() {
  document.getElementById('detail-modal').classList.remove('show');
}

async function loadYokaiStats(youkaiId) {
  const wrap = document.getElementById('yokai-meter-wrap');
  wrap.style.display = 'none';
  try {
    const s = await apiGet(`/youkai/${encodeURIComponent(youkaiId)}/stats`);
    const total = (s.seal_count || 0) + (s.bond_count || 0);
    if (total === 0) {
      document.getElementById('yokai-meter-counts').textContent = 'まだ記録なし';
      document.getElementById('yokai-meter-fill').style.width = '50%';
    } else {
      const sealPct = Math.round((s.seal_count / total) * 100);
      document.getElementById('yokai-meter-fill').style.width = sealPct + '%';
      document.getElementById('yokai-meter-counts').textContent =
        `封印 ${s.seal_count}件  /  共存 ${s.bond_count}件`;
    }
    wrap.style.display = 'block';
  } catch {
    // サーバーエラー時は非表示のまま
  }
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

// --- 魂問診断 (Role Quiz) --------------------------------------
function showRoleQuiz() {
  _quiz = { idx:0, fV:{E:0,S:0}, sV:{C:0,X:0,T:0}, tbF:null, tbS:null, result:null };
  document.getElementById('role-quiz-modal').classList.add('show');
  _rqShow('rq-intro');
}

function _rqShow(id) {
  ['rq-intro','rq-question','rq-transition','rq-result'].forEach(s => {
    document.getElementById(s).style.display = s === id ? 'flex' : 'none';
  });
}

function startQuiz() {
  _rqShow('rq-question');
  _rqRender();
}

function _rqRender() {
  const q = QUIZ_QUESTIONS[_quiz.idx];
  const isFact = _quiz.idx < 4;
  document.getElementById('rq-num').textContent = q.id;
  document.getElementById('rq-phase-label').textContent = isFact ? '陣営の問い' : '心の問い';
  const situEl = document.getElementById('rq-situation');
  situEl.textContent = q.situation;
  situEl.style.display = q.situation ? '' : 'none';
  document.getElementById('rq-question-text').textContent = q.question;

  const opts = document.getElementById('rq-options');
  opts.innerHTML = '';
  q.options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'rq-option';
    btn.textContent = opt.text;
    btn.onclick = () => _rqSelect(opt.v);
    opts.appendChild(btn);
  });
}

function _rqSelect(v) {
  if (_quiz.idx < 4) {
    _quiz.fV[v]++;
    if (_quiz.idx === 3) _quiz.tbF = v;
  } else {
    _quiz.sV[v]++;
    if (_quiz.idx === 7) _quiz.tbS = v;
  }
  _quiz.idx++;

  if (_quiz.idx === 4) {
    _rqShow('rq-transition');
    setTimeout(() => { _rqShow('rq-question'); _rqRender(); }, 2400);
  } else if (_quiz.idx === 8) {
    _rqCalcResult();
  } else {
    _rqRender();
  }
}

function _rqCalcResult() {
  const { fV, sV, tbF, tbS } = _quiz;

  let faction;
  if (fV.E !== fV.S)       faction = fV.E > fV.S ? 'exorcist' : 'supernatural';
  else                      faction = tbF === 'E' ? 'exorcist' : 'supernatural';

  const maxS = Math.max(sV.C, sV.X, sV.T);
  const nTied = Object.values(sV).filter(v => v === maxS).length;
  let style;
  if (nTied === 1)          style = sV.C === maxS ? 'control' : sV.X === maxS ? 'coexist' : 'transform';
  else                      style = tbS === 'C' ? 'control' : tbS === 'X' ? 'coexist' : 'transform';

  const ROLE_MAP = {
    'exorcist-control':'onmyoji', 'exorcist-coexist':'kitoshi', 'exorcist-transform':'miko',
    'supernatural-control':'yojutsushi', 'supernatural-coexist':'yamabushi', 'supernatural-transform':'jujutsushi',
  };
  const role = ROLE_MAP[`${faction}-${style}`];
  _quiz.result = { role, faction };

  const info = ROLE_INFO[role];
  const emblemEl = document.getElementById('rq-emblem');
  emblemEl.textContent = info.emblem;
  emblemEl.style.color = info.color;
  emblemEl.style.borderColor = info.color;
  document.getElementById('rq-role-name').textContent = info.kanji;
  document.getElementById('rq-role-reading').textContent = `（${info.reading}）`;
  const factionEl = document.getElementById('rq-role-faction');
  factionEl.textContent = info.factionName + '陣営';
  factionEl.style.color = faction === 'exorcist' ? '#c8302a' : '#9b59f0';
  document.getElementById('rq-role-tagline').textContent = info.tagline;
  document.getElementById('rq-role-desc').textContent = info.desc;

  _rqShow('rq-result');
}

function confirmRole() {
  const { role, faction } = _quiz.result;
  currentRole    = role;
  currentFaction = faction;
  localStorage.setItem(ROLE_KEY,    role);
  localStorage.setItem(FACTION_KEY, faction);
  document.getElementById('role-quiz-modal').classList.remove('show');
  updateFactionHUD();
  _initSkillUI();
  showToast(`${ROLE_INFO[role].kanji}の道を歩む`);
}

function retakeQuiz() {
  _quiz = { idx:0, fV:{E:0,S:0}, sV:{C:0,X:0,T:0}, tbF:null, tbS:null, result:null };
  _rqShow('rq-intro');
}

function browseOtherRole() {
  if (!_quiz?.result) return;
  const roles = Object.keys(ROLE_INFO);
  const idx = roles.indexOf(_quiz.result.role);
  const next = roles[(idx + 1) % roles.length];
  const info = ROLE_INFO[next];
  _quiz.result = { role: next, faction: info.faction };
  const emblemEl = document.getElementById('rq-emblem');
  emblemEl.textContent = info.emblem;
  emblemEl.style.color = info.color;
  emblemEl.style.borderColor = info.color;
  document.getElementById('rq-role-name').textContent = info.kanji;
  document.getElementById('rq-role-reading').textContent = `（${info.reading}）`;
  const factionEl = document.getElementById('rq-role-faction');
  factionEl.textContent = info.factionName + '陣営';
  factionEl.style.color = info.faction === 'exorcist' ? '#c8302a' : '#9b59f0';
  document.getElementById('rq-role-tagline').textContent = info.tagline;
  document.getElementById('rq-role-desc').textContent = info.desc;
}

// --- 全国勢力メーター ------------------------------------------
async function refreshGlobalStats() {
  try {
    const s = await apiGet('/stats/global');
    const total = s.total || 0;
    const meter = document.getElementById('faction-meter');
    if (total === 0) return;

    const exPct  = Math.round((s.exorcist / total) * 100);
    const suPct  = 100 - exPct;

    document.getElementById('fm-seg-ex').style.flex = exPct;
    document.getElementById('fm-seg-su').style.flex = suPct;
    document.getElementById('fm-pct-ex').textContent = exPct + '%';
    document.getElementById('fm-pct-su').textContent = suPct + '%';
    meter.classList.add('loaded');
  } catch {
    // 失敗時はメーターを非表示のまま
  }
}

// --- Debug role switcher ----------------------------------------
function handleBadgeClick() {
  if (state.debugMode) {
    toggleDebugRolePanel();
  } else {
    showRoleQuiz();
  }
}

function toggleDebugRolePanel() {
  const panel = document.getElementById('debug-role-panel');
  if (panel.classList.contains('show')) {
    panel.classList.remove('show');
    return;
  }
  let html = '<div class="drp-title">ロール切替 [DEV]</div>';
  Object.entries(ROLE_INFO).forEach(([key, info]) => {
    const isActive = currentRole === key;
    html += `<button class="drp-btn${isActive ? ' drp-active' : ''}"
      style="border-color:${info.color}${isActive ? ';background:' + info.color + '22' : ''}"
      onclick="setRoleDebug('${key}')">
      <span class="drp-emblem" style="color:${info.color}">${info.emblem}</span>
      <span class="drp-name">${info.kanji}</span>
      <span class="drp-faction" style="color:${info.faction === 'exorcist' ? '#c8302a' : '#9b59f0'}">${info.factionName}</span>
    </button>`;
  });
  panel.innerHTML = html;
  panel.classList.add('show');
}

function setRoleDebug(role) {
  const info = ROLE_INFO[role];
  currentRole    = role;
  currentFaction = info.faction;
  localStorage.setItem(ROLE_KEY,    role);
  localStorage.setItem(FACTION_KEY, info.faction);
  document.getElementById('debug-role-panel').classList.remove('show');
  updateFactionHUD();
  _initSkillUI();
  Object.keys(capturedIds).length > 0 &&
    Object.values(youkaiMarkers).forEach(({ data }) => {
      if (capturedIds.has(data.id)) refreshMarker(data.id);
    });
  showToast(`[DEV] ${info.kanji}（${info.factionName}）に切替`);
}

// --- Faction management ----------------------------------------
function updateFactionHUD() {
  const badge = document.getElementById('faction-badge');
  if (!badge) return;
  const info = currentRole && ROLE_INFO[currentRole];
  if (info) {
    badge.textContent = info.kanji;
    badge.className   = 'faction-badge ' + (info.faction === 'supernatural' ? 'supernatural' : 'exorcist');
  } else if (currentFaction === 'supernatural') {
    badge.textContent = '招き手';
    badge.className   = 'faction-badge supernatural';
  } else {
    badge.textContent = '祓い手';
    badge.className   = 'faction-badge exorcist';
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
  showToast(f === 'supernatural' ? '招き手として縫い目を開く道を歩む' : '祓い手として封印の道を歩む');
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
    if (!currentRole) showRoleQuiz();
    refreshGlobalStats();
    setInterval(refreshGlobalStats, 5 * 60 * 1000);
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
    label.textContent = 'スタンプ';
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

// ============================================================
// スキルシステム
// ============================================================

const DOKAISHU_RANGE_M = 50;

// ---- 術力 HUD ------------------------------------------------
let _jutsu = { current: 100, max: 100 };

async function refreshJutsuHUD() {
  try {
    const p = await apiGet(`/player/profile?deviceId=${encodeURIComponent(DEVICE_ID)}`);
    _jutsu.current = p.jutsuriyoku ?? 100;
    _jutsu.max     = p.jutsuriyoku_max ?? 100;
  } catch { /* サイレント失敗 */ }
  _renderJutsuHUD();
}

function _renderJutsuHUD() {
  const hud  = document.getElementById('jutsu-hud');
  if (!currentRole) { hud.style.display = 'none'; return; }
  hud.style.display = '';
  const pct  = Math.min(100, Math.round(_jutsu.current / _jutsu.max * 100));
  document.getElementById('jutsu-bar-fill').style.width = pct + '%';
  document.getElementById('jutsu-val').textContent = `${_jutsu.current}/${_jutsu.max}`;
}

// ---- 歩行距離トラッキング ------------------------------------
let _lastWalkPos   = null;
let _walkBuffer    = 0;  // 未送信の累積距離(m)

function _onWalkPosition(lat, lon) {
  if (_lastWalkPos) {
    const d = distanceMeters(_lastWalkPos.lat, _lastWalkPos.lon, lat, lon);
    if (d > 1 && d < 200) {  // ノイズ除去: 1m未満・200m超は無視
      _walkBuffer += d;
      // 50m貯まるごとに送信
      if (_walkBuffer >= 50) {
        const meters = Math.floor(_walkBuffer);
        _walkBuffer -= meters;
        apiPost('/player/walk', { deviceId: DEVICE_ID, meters }).then(() => {
          // 術力が回復したかもしれないのでHUDを更新
          _jutsu.current = Math.min(_jutsu.max, _jutsu.current + Math.floor(meters / 50));
          _renderJutsuHUD();
        }).catch(() => {});
      }
    }
  }
  _lastWalkPos = { lat, lon };
}

const SKILL_DEFS = {
  onmyoji: [
    { id: 'shikigami', name: '式神術', desc: '術力を消費して式神を遠方へ飛ばし、妖怪を遠隔封印する。速度 1km=10分。地図上の妖怪マーカーをタップして発射。', locationBased: true },
    { id: 'kekkai',    name: '結界術', desc: '術力を消費して現在地に石を一つ置く。3つの石が三角形（面積1,000m²以上）を成すと結界が7日間張られる。ランクにより石の最大数・面積上限が変わる。', locationBased: true },
    { id: 'reveal',    name: '霊視',   desc: '式の眼で妖怪の真名・伝承・出没地を霊視する。封印・契約済みの妖怪からコレクション画面で発動。', locationBased: false },
  ],
  kitoshi: [
    { id: 'reveal',    name: '祈視',     desc: '祈りの力で妖怪の真名・伝承・出没地を見通す。封印・契約済みの妖怪からコレクション画面で発動。', locationBased: false },
  ],
  miko: [
    { id: 'reveal',    name: '神降',     desc: '神の力を借りて妖怪の真名・伝承・出没地を顕現させる。封印・契約済みの妖怪からコレクション画面で発動。', locationBased: false },
  ],
  yojutsushi: [
    { id: 'reveal',    name: '妖眼',     desc: '妖術の眼で妖怪の真の姿・伝承・出没地を看破する。封印・契約済みの妖怪からコレクション画面で発動。', locationBased: false },
  ],
  yamabushi: [
    { id: 'reveal',    name: '験視',     desc: '山岳修行で得た験力で妖怪の真名・伝承・出没地を見抜く。封印・契約済みの妖怪からコレクション画面で発動。', locationBased: false },
  ],
  jujutsushi: [
    { id: 'reveal',      name: '言霊術',    desc: '言霊の力で妖怪の真名・伝承・出没地を解き明かす。封印・契約済みの妖怪からコレクション画面で発動。', locationBased: false },
    { id: 'monyou',      name: '紋様術',    desc: '現在地に紋様を刻む。1日1回、地図左下のボタンから発動。', locationBased: true },
    { id: 'utsushidori', name: '写し取り',  desc: '契約した妖怪の力（属性キーワード）を己の内に写し取る。', locationBased: false },
  ],
};

const ROLE_JOB = {
  onmyoji: 'onmyoji', kitoshi: null, miko: null,
  yojutsushi: null, yamabushi: null, jujutsushi: 'jujutsushi',
};

function _currentJob() {
  if (!currentRole) return null;
  return ROLE_JOB[currentRole] ?? null;
}

function _initSkillUI() {
  const job = _currentJob();
  document.getElementById('btn-skills').style.display = currentRole ? '' : 'none';
  document.getElementById('btn-monyou').style.display = (job === 'jujutsushi') ? '' : 'none';
  if (job === 'onmyoji') {
    _loadKekkaiStones();
    _loadHisho();
    _startHishoTimer();
  }
  refreshJutsuHUD();
}

// ---- スキルパネル ------------------------------------------
function openSkillPanel() {
  if (!currentRole) return;
  const job = _currentJob();
  const info = ROLE_INFO[currentRole];
  document.getElementById('sp-emblem').textContent = info.emblem;
  document.getElementById('sp-emblem').style.borderColor = info.color;
  document.getElementById('sp-emblem').style.color = info.color;
  document.getElementById('sp-role-name').textContent = info.kanji;
  document.getElementById('sp-rank').textContent = `EXP積算中`;

  const defs = SKILL_DEFS[currentRole] ?? [];
  const SUPERNATURAL_ROLES = ['yojutsushi', 'yamabushi', 'jujutsushi'];
  let html = '';
  defs.forEach((sk) => {
    const isBtnColor = SUPERNATURAL_ROLES.includes(currentRole) ? 'juju-btn' : '';
    const locationNote = sk.locationBased
      ? '<div style="font-size:10px;color:#888;letter-spacing:0.05em;margin-top:4px;">※ 位置情報が必要</div>'
      : '';
    let actionBtn;
    if (sk.id === 'shikigami') {
      actionBtn = `<button class="skill-action-btn ${isBtnColor}" onclick="closeSkillPanel();activateHishoMode()">式神を飛ばす</button>`;
    } else if (sk.id === 'kekkai') {
      actionBtn = `<button class="skill-action-btn ${isBtnColor}" onclick="closeSkillPanel();activateKekkaiStone()">現在地に石を置く</button>`;
    } else if (sk.locationBased) {
      actionBtn = `<button class="skill-action-btn ${isBtnColor}" disabled>地図・ボタンから発動</button>`;
    } else {
      actionBtn = `<button class="skill-action-btn ${isBtnColor}" onclick="openCollectionForSkill('${sk.id}')">コレクションから発動</button>`;
    }

    html += `
      <div class="skill-card">
        <div class="skill-card-header">
          <div class="skill-name">${sk.name}</div>
          <div class="skill-badge ready">習得済</div>
        </div>
        <div class="skill-desc">${sk.desc}</div>
        ${locationNote}
        ${actionBtn}
      </div>`;
  });

  document.getElementById('skill-list').innerHTML = html;
  document.getElementById('skill-panel-modal').classList.add('show');
}

function closeSkillPanel() {
  document.getElementById('skill-panel-modal').classList.remove('show');
}

let _activeSkillId = null;

function openCollectionForSkill(skillId) {
  _activeSkillId = skillId;
  closeSkillPanel();
  openCollection(skillId);
}

// ---- スキル結果 -------------------------------------------
function showSkillResult(title, body) {
  document.getElementById('skill-result-title').textContent = title;
  document.getElementById('skill-result-body').textContent = body;
  document.getElementById('skill-result-overlay').style.display = 'flex';
}

function closeSkillResult() {
  document.getElementById('skill-result-overlay').style.display = 'none';
}

// ---- 読解術 (陰陽師・マーカータップ時) ----------------------
function _showDokaishuOption(youkai, dist) {
  const popup = L.popup({ closeButton: true, className: 'dokaishu-popup-wrap' })
    .setLatLng([youkai.lat, youkai.lon])
    .setContent(`
      <div class="dokaishu-popup">
        <div class="dokaishu-popup-title">陰陽師の視界（残り ${dist}m）</div>
        <button class="dokaishu-popup-btn" onclick="activateDokaishu('${youkai.id}')">読 解 す る</button>
        <div style="font-size:10px;color:#888;margin-top:4px;text-align:center;">
          封印は13m以内で可能
        </div>
      </div>`)
    .openOn(map);
}

async function activateDokaishu(youkaiId) {
  map.closePopup();
  if (!state.playerPos) { showToast('現在地不明'); return; }
  showToast('読解術を発動…');
  const res = await apiPost('/skill/dokaishu', {
    deviceId: DEVICE_ID,
    youkaiId,
    userLat: state.playerPos.lat,
    userLon: state.playerPos.lon,
  });
  if (!res.ok) {
    const msg = res.data?.error ?? 'エラー';
    showToast(`読解術失敗: ${msg}`);
    return;
  }
  const d = res.data;
  const tags = (d.category_tags ?? []).join('・') || 'なし';
  const kws  = (d.keywords ?? []).slice(0, 5).join('、') || 'なし';
  showSkillResult(
    `読 解 術 — ${d.name}`,
    `読み：${d.kana || '不明'}\n\n属性：${tags}\n\nキーワード：${kws}\n\n（EXP +${d.exp_gained}）`,
  );
}

// ---- 式神術 (コレクションから) ------------------------------
async function activateShikigami(youkaiId) {
  const res = await apiPost('/skill/shikigami', { deviceId: DEVICE_ID, youkaiId });
  if (!res.ok) {
    showToast(`式神術失敗: ${res.data?.error ?? 'エラー'}`);
    return;
  }
  const d = res.data;
  showSkillResult(
    '式 神 術 発 動',
    `式神として登録された。\n\n現在の式神数：${d.shikigami_count} / ${d.max_slots}\n\n（EXP +${d.exp_gained}）`,
  );
}

// ---- 結界術 (石設置・地図表示) -----------------------
let _kekkaiLayers = [];
let _kekkaiData = { stones: [], barriers: [] };

function _renderKekkaiStones() {
  _kekkaiLayers.forEach((l) => map.removeLayer(l));
  _kekkaiLayers = [];

  _kekkaiData.stones.forEach((s) => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="kekkai-stone-marker">石</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const m = L.marker([s.lat, s.lon], { icon })
      .bindPopup(`<div style="font-size:12px;text-align:center;">結界石<br><small>${new Date(s.placed_at).toLocaleDateString('ja-JP')}</small></div>`)
      .addTo(map);
    _kekkaiLayers.push(m);
  });

  _kekkaiData.barriers.forEach((b) => {
    const pts = b.lats.map((lat, i) => [lat, b.lons[i]]);
    const poly = L.polygon(pts, {
      color: '#1e5fa8',
      fillColor: '#1e5fa8',
      fillOpacity: 0.14,
      weight: 2,
      dashArray: '6 4',
    }).addTo(map);
    _kekkaiLayers.push(poly);
  });

  const hint = document.querySelector('.kekkai-hint');
  const stoneCount   = _kekkaiData.stones.length;
  const barrierCount = _kekkaiData.barriers.length;
  if (stoneCount > 0 || barrierCount > 0) {
    const msg = [
      stoneCount   > 0 ? `石 ${stoneCount}個` : '',
      barrierCount > 0 ? `結界 ${barrierCount}陣 展開中` : '',
    ].filter(Boolean).join(' / ');
    if (hint) {
      hint.textContent = msg;
    } else {
      const el = document.createElement('div');
      el.className = 'kekkai-hint';
      el.textContent = msg;
      document.body.appendChild(el);
    }
  } else if (hint) {
    hint.remove();
  }
}

async function _loadKekkaiStones() {
  if (currentRole !== 'onmyoji') return;
  const data = await apiGet(`/skill/kekkai/stones?deviceId=${encodeURIComponent(DEVICE_ID)}`).catch(() => null);
  if (!data) return;
  _kekkaiData = { stones: data.stones ?? [], barriers: data.barriers ?? [] };
  _renderKekkaiStones();
}

async function activateKekkaiStone() {
  if (!state.playerPos) { showToast('現在地が取得できません'); return; }
  showToast('石を設置中…');
  const res = await apiPost('/skill/kekkai/stone', {
    deviceId: DEVICE_ID,
    userLat:  state.playerPos.lat,
    userLon:  state.playerPos.lon,
  });
  if (!res.ok) {
    const msg = res.data?.error ?? 'エラー';
    if (res.status === 402) {
      showToast(`術力不足（必要: ${res.data?.required ?? '?'}）`);
    } else if (res.status === 409) {
      showToast(`石の上限に達しています（${res.data?.current}/${res.data?.max}）`);
    } else {
      showToast(`結界術失敗: ${msg}`);
    }
    return;
  }
  const d = res.data;
  if (d.barrier_formed) {
    const areaKm2 = (d.barrier.area_m2 / 1_000_000).toFixed(3);
    showSkillResult(
      '結界術 — 結 界 成 立',
      `三角結界が張られました。\n面積: ${(d.barrier.area_m2).toLocaleString()}m²（${areaKm2}km²）\n\n7日後に消滅します。`,
    );
  } else {
    showToast(`石を設置しました（${d.stones_count}/${d.max_stones}個）\n術力残: ${d.jutsu_remaining}`);
  }
  await _loadKekkaiStones();
}

// ---- 真名解明スキル (全ロール) ------------------------------
async function activateReveal(youkaiId) {
  const revealSkill = currentRole && (SKILL_DEFS[currentRole] ?? []).find((s) => s.id === 'reveal');
  const skillName = revealSkill?.name ?? '真名解明';
  const res = await apiPost('/skill/reveal', { deviceId: DEVICE_ID, youkaiId });
  if (!res.ok) {
    showToast(`${skillName}失敗: ${res.data?.error ?? 'エラー'}`);
    return;
  }
  const d = res.data;
  trueNameLearned.add(youkaiId);
  if (_activeSkillId) openCollection(_activeSkillId);

  const already = d.already_learned ? '（既習得）\n\n' : '';
  const loreText = d.notes ? `\n\n【伝承】\n${d.notes}` : '';
  const appearText = d.appearance ? `\n\n【出没場所・外見】\n${d.appearance}` : '';
  showSkillResult(
    `${skillName} — 真 名 解 明`,
    `${already}真名：${d.name || '不明'}（${d.kana || ''}）${loreText}${appearText}\n\n（EXP +${d.exp_gained ?? 0}）`,
  );
}

// ---- 紋様術 (地図フローティングボタン) ----------------------
async function activateMonyou() {
  if (!state.playerPos) { showToast('現在地を取得してください'); return; }
  if (currentRole !== 'jujutsushi') return;
  const res = await apiPost('/skill/monyou', {
    deviceId: DEVICE_ID,
    userLat: state.playerPos.lat,
    userLon: state.playerPos.lon,
  });
  if (!res.ok) {
    const msg = res.data?.error === 'Daily limit reached'
      ? '今日の紋様術はすでに発動した'
      : `紋様術失敗: ${res.data?.error ?? 'エラー'}`;
    showToast(msg);
    return;
  }
  const d = res.data;
  const exp = new Date(d.expires_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  showSkillResult(
    '紋 様 術 — 刻 印',
    `この地に紋様を刻んだ。\n\n有効期限：${exp} まで\n\n（EXP +${d.exp_gained}）`,
  );
  _renderNearbyMonyou();
}

async function _renderNearbyMonyou() {
  if (!state.playerPos) return;
  const { lat, lon } = state.playerPos;
  const data = await apiGet(`/skill/monyou/nearby?lat=${lat}&lon=${lon}&r=500`).catch(() => null);
  if (!data?.patterns?.length) return;
  data.patterns.forEach((p) => {
    L.circleMarker([p.lat, p.lon], {
      radius: 6,
      color: '#8b2fc9',
      fillColor: '#c87ef0',
      fillOpacity: 0.6,
      weight: 1,
    }).bindTooltip(`紋〔${p.author}〕`, { permanent: false }).addTo(map);
  });
}

// ---- 写し取り (コレクションから) ---------------------------
async function activateUtsushidori(youkaiId, keyword) {
  const res = await apiPost('/skill/utsushidori', { deviceId: DEVICE_ID, youkaiId, keyword });
  if (!res.ok) {
    showToast(`写し取り失敗: ${res.data?.error ?? 'エラー'}`);
    return;
  }
  const d = res.data;
  showSkillResult(
    '写 し 取 り',
    `${d.effect}\n\n現在の写し取り：\n${(d.copied_powers ?? []).join('、') || 'なし'}\n\n（EXP +${d.exp_gained}）`,
  );
}

// ---- コレクション改修（スキルボタン追加） -------------------
// openCollection を上書きしてスキルモードを追加
const _origOpenCollection = openCollection;
openCollection = function(skillId = null) {
  const job = _currentJob();
  const content = document.getElementById('collection-content');
  let html = '<div class="collection-grid">';

  youkaiData.forEach((y) => {
    const actionType = capturedIds.get(y.id);
    const captured = actionType !== undefined;
    if (!captured) {
      html += `
        <div class="collection-card locked">
          <div class="ck-glyph">？</div>
          <div class="ck-name">？？？</div>
          <div class="ck-dist">○ 未発見</div>
        </div>`;
      return;
    }

    // スキルボタン
    const SUPERNATURAL_ROLES = ['yojutsushi', 'yamabushi', 'jujutsushi'];
    const isSupernatural = SUPERNATURAL_ROLES.includes(currentRole);
    let skillBtn = '';
    if (skillId === 'reveal' && (actionType === 'seal' || actionType === 'bond')) {
      const btnColor = isSupernatural ? 'juju-btn' : '';
      skillBtn = `<button class="skill-action-btn ${btnColor}" style="margin-top:4px;font-size:10px;padding:5px"
        onclick="event.stopPropagation();activateReveal('${y.id}')">真名を解く</button>`;
    } else if (skillId === 'utsushidori' && actionType === 'bond' && job === 'jujutsushi') {
      skillBtn = `<button class="skill-action-btn juju-btn" style="margin-top:4px;font-size:10px;padding:5px"
        onclick="event.stopPropagation();openUtsushidoriPicker('${y.id}')">力を写し取る</button>`;
    }

    // bond 未解明は名前を隠す
    const nameRevealed = actionType !== 'bond' || trueNameLearned.has(y.id);
    const displayName  = nameRevealed ? y.name : '？？？';
    const statusBadge  = actionType === 'bond'
      ? `<div class="ck-status-badge bond">${trueNameLearned.has(y.id) ? '真名解明' : '契約済'}</div>`
      : actionType === 'seal' ? '<div class="ck-status-badge seal">封印済</div>' : '';

    html += `
      <div class="collection-card" ${!skillId ? `onclick="closeCollectionAndDetail('${y.id}')"` : ''}>
        <div class="ck-img"><img src="${y.camera_url}" alt="${displayName}" onerror="this.style.display='none'"></div>
        <div class="ck-name">${displayName}</div>
        ${statusBadge}
        ${skillBtn}
      </div>`;
  });

  html += '</div>';
  if (skillId) {
    const revealSkillName = currentRole && (SKILL_DEFS[currentRole] ?? []).find((s) => s.id === 'reveal')?.name;
    const SKILL_NAMES = { shikigami:'式神術', reveal: revealSkillName || '真名解明', utsushidori:'写し取り' };
    html = `<div style="font-family:'Shippori Mincho B1',serif;font-size:13px;letter-spacing:0.15em;color:var(--gold);text-align:center;margin-bottom:12px;">
      ${SKILL_NAMES[skillId] || ''} — 対象を選べ</div>` + html;
  }
  content.innerHTML = html;
  document.getElementById('collection-modal').classList.add('show');
};

// ---- 写し取り対象キーワード選択 ----------------------------
async function openUtsushidoriPicker(youkaiId) {
  const detail = await apiGet(`/youkai/${encodeURIComponent(youkaiId)}`).catch(() => null);
  if (!detail?.keywords?.length) { showToast('この妖怪にはキーワードがありません'); return; }

  const keywords = detail.keywords.slice(0, 6);
  let btnHtml = keywords.map((kw) =>
    `<button class="skill-action-btn juju-btn" style="margin-bottom:6px"
      onclick="activateUtsushidori('${youkaiId}','${kw.replace(/'/g, '')}')">
      ${kw}
    </button>`).join('');

  showSkillResult(
    '写 し 取 る 力 を 選 べ',
    '',
  );
  document.getElementById('skill-result-body').innerHTML = btnHtml;
}

// ---- 飛翔式神 (陰陽師: 遠隔封印) --------------------------------
let _hishoLayers   = [];   // 地図上の描画レイヤ
let _hishoTimerId  = null; // アニメーションタイマー
let _hishoData     = [];   // 現在飛行中の式神リスト

function _hishoProgress(item) {
  const start = new Date(item.launched_at).getTime();
  const end   = new Date(item.arrives_at).getTime();
  return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
}

function _hishoCurrentPos(item) {
  const p = _hishoProgress(item);
  return [
    item.launch_lat + (item.target_lat - item.launch_lat) * p,
    item.launch_lon + (item.target_lon - item.launch_lon) * p,
  ];
}

function _renderHisho() {
  _hishoLayers.forEach((l) => map.removeLayer(l));
  _hishoLayers = [];

  _hishoData.forEach((item) => {
    const progress = _hishoProgress(item);
    if (progress >= 1) return;

    const [curLat, curLon] = _hishoCurrentPos(item);

    // 飛行ルート（点線）
    const line = L.polyline(
      [[item.launch_lat, item.launch_lon], [item.target_lat, item.target_lon]],
      { color: '#c8a84b', weight: 1.5, dashArray: '5 6', opacity: 0.7 },
    ).addTo(map);
    _hishoLayers.push(line);

    // 残り時間
    const remainSec = Math.max(0, Math.ceil((new Date(item.arrives_at).getTime() - Date.now()) / 1000));
    const remainStr = remainSec >= 3600
      ? `${Math.floor(remainSec / 3600)}h${Math.floor((remainSec % 3600) / 60)}m`
      : remainSec >= 60
        ? `${Math.floor(remainSec / 60)}m${remainSec % 60}s`
        : `${remainSec}s`;

    // 式神アイコン（近距離点滅）
    const blinking = remainSec < 60 ? 'hisho-blink' : '';
    const icon = L.divIcon({
      html: `<div class="hisho-marker ${blinking}">式</div><div class="hisho-eta">${remainStr}</div>`,
      className: '',
      iconSize: [32, 52],
      iconAnchor: [14, 14],
    });
    const marker = L.marker([curLat, curLon], { icon, zIndexOffset: 500 }).addTo(map);
    _hishoLayers.push(marker);
  });
}

async function _loadHisho() {
  if (currentRole !== 'onmyoji') return;
  try {
    const data = await apiGet(`/skill/hisho-shikigami?deviceId=${encodeURIComponent(DEVICE_ID)}`);
    _hishoData = data.shikigami ?? [];
  } catch { _hishoData = []; }
  _renderHisho();
}

function _startHishoTimer() {
  if (_hishoTimerId) return;
  _hishoTimerId = setInterval(async () => {
    if (!_hishoData.length) return;
    _renderHisho();

    // 到達済みチェック
    for (const item of [..._hishoData]) {
      if (_hishoProgress(item) < 1) continue;
      _hishoData = _hishoData.filter((i) => i.shikigami_id !== item.shikigami_id);
      try {
        const res = await apiPost('/skill/hisho-shikigami/arrive', {
          deviceId: DEVICE_ID,
          shikigamiId: item.shikigami_id,
        });
        if (res.ok) {
          const d = res.data;
          let msg;
          if (!d.trial_success) {
            msg = `式神、跳ね返された…（${d.progress ?? 0}/${d.required} EXP +${d.exp_gained}）`;
          } else if (d.sealed) {
            msg = `式神が封印を完了！（EXP +${d.exp_gained}）`;
          } else {
            msg = `式神が一撃加えた（${d.progress}/${d.required} EXP +${d.exp_gained}）`;
          }
          showToast(msg);
          if (d.sealed) refreshYoukaiMarker(item.target_youkai_id, 'seal');
          else if (d.trial_success) refreshYoukaiMarker(item.target_youkai_id, 'in_progress');
        }
      } catch { /* 次回リトライ */ }
    }
  }, 5000);
}

// 飛翔式神モード: 地図上で目標をタップ
function activateHishoMode() {
  if (!state.playerPos) { showToast('現在地不明'); return; }
  state.hishoMode = true;
  map.closePopup();
  showToast('目標の妖怪マーカーをタップせよ', 3000);
  document.getElementById('map').style.cursor = 'crosshair';
}

function _cancelHishoMode() {
  state.hishoMode = false;
  document.getElementById('map').style.cursor = '';
}

async function _launchHishoTo(youkaiId) {
  _cancelHishoMode();
  showToast('式神を飛ばしています…');
  const res = await apiPost('/skill/hisho-shikigami', {
    deviceId:       DEVICE_ID,
    targetYoukaiId: youkaiId,
    userLat:        state.playerPos.lat,
    userLon:        state.playerPos.lon,
  });
  if (!res.ok) {
    const err = res.data?.error ?? 'エラー';
    showToast(`飛翔式神失敗: ${err}`);
    return;
  }
  const d = res.data;
  const etaMin = d.flight_minutes;
  const etaStr = etaMin >= 60
    ? `${Math.floor(etaMin / 60)}時間${etaMin % 60}分`
    : `${etaMin}分`;
  const knownMsg = d.shinmei_known ? '（真名既知：成功率90%）' : '（真名未知：成功率40%）';
  showSkillResult(
    '飛 翔 式 神 発 動',
    `距離：${d.distance_km}km\n到達まで：${etaStr}\n\n${knownMsg}\n\nスロット：${d.flying_count} / ${d.max_slots}`,
  );
  _hishoData.push({
    shikigami_id:     d.shikigami_id,
    launch_lat:       d.launch_lat,
    launch_lon:       d.launch_lon,
    target_lat:       d.target_lat,
    target_lon:       d.target_lon,
    target_youkai_id: d.target_youkai_id,
    launched_at:      d.launched_at,
    arrives_at:       d.arrives_at,
    status:           'flying',
  });
  _renderHisho();
  _startHishoTimer();
}

// 全 const/関数が定義された後でスキルUIを初期化
_initSkillUI();
