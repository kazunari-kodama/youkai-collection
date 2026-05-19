'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let adminKey = '';
let allYoukai = [];
let currentFilter = 'all';
let editingId = null; // null = new, string = editing existing

// ── Auth ───────────────────────────────────────────────────────────────────
function login() {
  const key = document.getElementById('key-input').value.trim();
  if (!key) return;
  adminKey = key;
  loadYoukai();
}

document.getElementById('key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});

// ── API helpers ────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': adminKey,
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) {
    document.getElementById('login-error').textContent = 'キーが違います';
    showLogin();
    throw new Error('Unauthorized');
  }
  return res;
}

// ── Load ───────────────────────────────────────────────────────────────────
async function loadYoukai() {
  let res;
  try {
    res = await apiFetch('/admin/youkai');
  } catch {
    return;
  }
  if (!res.ok) {
    showToast('読み込みに失敗しました', true);
    return;
  }
  const data = await res.json();
  allYoukai = data.sort((a, b) => {
    // rally items last, then alphabetical by yokai_id
    const ra = a.rally_key ? 1 : 0;
    const rb = b.rally_key ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return (a.yokai_id ?? '').localeCompare(b.yokai_id ?? '');
  });

  showApp();
  renderTable();
}

// ── Render table ───────────────────────────────────────────────────────────
function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderTable();
}

function renderTable() {
  const q = (document.getElementById('search-input').value ?? '').toLowerCase();
  const tbody = document.getElementById('table-body');

  const visible = allYoukai.filter((y) => {
    if (currentFilter === 'rally' && !y.rally_key) return false;
    if (currentFilter === 'normal' && y.rally_key) return false;
    if (q) {
      const hay = `${y.yokai_id} ${y.name ?? ''} ${y.kana ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  document.getElementById('count-label').textContent = `${visible.length} 件`;

  if (!visible.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">該当する妖怪がいません</td></tr>';
    return;
  }

  tbody.innerHTML = visible.map((y) => {
    const iconUrl = y._icon_url || iconImageKeyUrl(y);
    const imgHtml = iconUrl
      ? `<img src="${escHtml(iconUrl)}" alt="${escHtml(y.name ?? '')}">`
      : '<span style="color:#ccc;font-size:20px;">？</span>';
    const rallyBadge = y.rally_key
      ? `<span class="badge-rally">ラリー</span>`
      : '';
    const nightBadge = y.night_only
      ? `<span class="badge-night">🌙夜のみ</span>`
      : '';
    const qrBadge = y.require_qr
      ? `<span class="badge-qr">📷QR</span>`
      : '';
    const originalBadge = y.is_original
      ? `<span class="badge-original">🎨創作</span>`
      : '';
    const rawId = y.yokai_id ?? '';
    const id = escHtml(rawId);
    const idAttr = escHtml(JSON.stringify(rawId)); // &quot;uuid&quot; — safe inside onclick=""
    return `<tr>
      <td class="cell-img">${imgHtml}</td>
      <td class="cell-id">${id}</td>
      <td>
        <div class="cell-name">${escHtml(y.name ?? '')}</div>
        <div class="cell-kana">${escHtml(y.kana ?? '')}</div>
      </td>
      <td class="cell-coords">${num(y.latitude)}, ${num(y.longitude)}</td>
      <td>${rallyBadge}${nightBadge}${qrBadge}${originalBadge}</td>
      <td>
        <button class="btn-edit" onclick="openForm(${idAttr})">編集</button>
        <button class="btn-delete" onclick="confirmDelete(${idAttr})">削除</button>
      </td>
    </tr>`;
  }).join('');
}

function iconImageKeyUrl(y) {
  const base = y._images_base_url ?? '';
  if (!base || !y.images?.length) return null;
  if (y.image_types?.length) {
    const idx = y.image_types.indexOf('icon');
    if (idx !== -1) return `${base}/${y.images[idx]}`;
  }
  return `${base}/${y.images[0]}`;
}

function num(v) {
  return typeof v === 'number' ? v.toFixed(5) : '—';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Form open/close ────────────────────────────────────────────────────────
// cameraKey: the S3 key for the uploaded camera image, e.g. "youkai/samukarou_camera.png"
// null = no camera image (yet)
let cameraKey = null;

function generateUUID() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

function regenId() {
  document.getElementById('f-id').value = generateUUID();
}

function openForm(id) {
  editingId = id;
  cameraKey = null;

  const isNew = id === null;
  document.getElementById('form-title').textContent = isNew ? '新規追加' : '妖怪を編集';
  document.getElementById('btn-regen-id').style.display = isNew ? '' : 'none';
  document.getElementById('f-id-hint').textContent = isNew ? '自動生成されます（↺で再生成）' : '';

  if (isNew) {
    clearForm();
    document.getElementById('f-id').value = generateUUID();
  } else {
    const y = allYoukai.find((x) => x.yokai_id === id);
    if (!y) return;
    document.getElementById('f-id').value = y.yokai_id ?? '';
    document.getElementById('f-rally-key').value = y.rally_key ?? '';
    document.getElementById('f-name').value = y.name ?? '';
    document.getElementById('f-kana').value = y.kana ?? '';
    document.getElementById('f-lat').value = y.latitude ?? '';
    document.getElementById('f-lon').value = y.longitude ?? '';
    document.getElementById('f-notes').value = y.notes ?? '';
    document.getElementById('f-appearance').value = y.appearance ?? '';
    document.getElementById('f-regions').value = (y.regions ?? []).join(', ');
    document.getElementById('f-category-tags').value = (y.category_tags ?? []).join(', ');
    document.getElementById('f-night-only').checked = y.night_only === true;
    document.getElementById('f-require-qr').checked = y.require_qr === true;
    document.getElementById('f-youryoku').value = String(y.youryoku ?? 1);
    document.getElementById('f-is-original').checked = y.is_original === true;

    // Derive existing camera key from _icon_url (which is the camera URL)
    if (y._icon_url) {
      const base = y._images_base_url ?? '';
      cameraKey = base ? y._icon_url.replace(base + '/', '') : null;
    }
  }

  renderCameraPreview();
  document.getElementById('upload-progress').textContent = '';
  document.getElementById('upload-file').value = '';
  document.getElementById('form-modal').classList.add('open');
}

function closeForm() {
  document.getElementById('form-modal').classList.remove('open');
}

function clearForm() {
  document.getElementById('f-night-only').checked = false;
  document.getElementById('f-require-qr').checked = false;
  document.getElementById('f-is-original').checked = false;
  ['f-rally-key', 'f-name', 'f-kana', 'f-lat', 'f-lon',
   'f-notes', 'f-appearance', 'f-regions', 'f-category-tags'].forEach((fid) => {
    document.getElementById(fid).value = '';
  });
}

// ── Image upload ───────────────────────────────────────────────────────────
async function uploadImage() {
  const fileInput = document.getElementById('upload-file');
  const file = fileInput.files[0];
  if (!file) { showToast('ファイルを選択してください', true); return; }

  const yokaiId = document.getElementById('f-id').value.trim();
  if (!yokaiId) { showToast('先に妖怪IDを入力してください', true); return; }

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
  const key = `youkai/${yokaiId}_camera.${ext}`;

  const btn = document.getElementById('btn-do-upload');
  const prog = document.getElementById('upload-progress');
  btn.disabled = true;
  prog.textContent = 'アップロード中…';

  try {
    const res = await apiFetch('/admin/upload-url', {
      method: 'POST',
      body: JSON.stringify({ key, contentType: file.type }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { url } = await res.json();

    const putRes = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
    });
    if (!putRes.ok) throw new Error('S3 PUT failed');

    cameraKey = key;
    renderCameraPreview();
    prog.textContent = '✓ アップロード完了';
    fileInput.value = '';
  } catch (e) {
    prog.textContent = 'エラー: ' + e.message;
    showToast('アップロード失敗', true);
  } finally {
    btn.disabled = false;
  }
}

function renderCameraPreview() {
  const el = document.getElementById('camera-preview');
  if (!cameraKey) {
    el.innerHTML = '<span class="no-image">画像なし</span>';
    return;
  }
  const base = (allYoukai.find((x) => x._images_base_url)?._images_base_url) ?? '';
  const imgUrl = base ? `${base}/${cameraKey}` : cameraKey;
  el.innerHTML = `<img src="${escHtml(imgUrl)}" alt="camera preview"><span class="preview-label">${escHtml(cameraKey)}</span>`;
}

// ── Save ───────────────────────────────────────────────────────────────────
async function saveYoukai() {
  const id = document.getElementById('f-id').value.trim();
  const name = document.getElementById('f-name').value.trim();
  const lat = parseFloat(document.getElementById('f-lat').value);
  const lon = parseFloat(document.getElementById('f-lon').value);

  if (!id) { showToast('妖怪IDは必須です', true); return; }
  if (!name) { showToast('名前は必須です', true); return; }
  if (isNaN(lat) || isNaN(lon)) { showToast('座標を正しく入力してください', true); return; }

  const toArray = (val) =>
    val.split(',').map((s) => s.trim()).filter(Boolean);

  // Determine images array: use uploaded camera key, or preserve existing from DB
  let images;
  let image_types;
  if (cameraKey) {
    images = [cameraKey];
    image_types = ['camera'];
  } else if (editingId !== null) {
    const existing = allYoukai.find((x) => x.yokai_id === editingId);
    images = existing?.images ?? [];
    image_types = existing?.image_types ?? [];
  }

  const body = {
    yokai_id: id,
    name,
    kana: document.getElementById('f-kana').value.trim(),
    latitude: lat,
    longitude: lon,
    notes: document.getElementById('f-notes').value.trim(),
    appearance: document.getElementById('f-appearance').value.trim(),
    rally_key: document.getElementById('f-rally-key').value.trim(),
    regions: toArray(document.getElementById('f-regions').value),
    category_tags: toArray(document.getElementById('f-category-tags').value),
    night_only: document.getElementById('f-night-only').checked || undefined,
    require_qr: document.getElementById('f-require-qr').checked || undefined,
    youryoku: Number(document.getElementById('f-youryoku').value) || 1,
    is_original: document.getElementById('f-is-original').checked || undefined,
    ...(images !== undefined ? { images, image_types } : {}),
  };

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  try {
    const res = await apiFetch('/admin/youkai', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    showToast('保存しました');
    closeForm();
    await loadYoukai();
  } catch (e) {
    showToast('保存に失敗しました', true);
  } finally {
    btn.disabled = false;
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────
let deleteTargetId = null;

function confirmDelete(id) {
  deleteTargetId = id;
  document.getElementById('confirm-msg').innerHTML =
    `<strong class="confirm-id">${escHtml(id)}</strong> を削除してもよろしいですか？<br>この操作は元に戻せません。`;
  document.getElementById('confirm-modal').classList.add('open');
}

function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('open');
  deleteTargetId = null;
}

async function doDelete() {
  if (!deleteTargetId) return;
  const id = deleteTargetId;
  document.getElementById('btn-confirm-delete').disabled = true;
  try {
    const res = await apiFetch(`/admin/youkai/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    showToast('削除しました');
    closeConfirm();
    await loadYoukai();
  } catch {
    showToast('削除に失敗しました', true);
  } finally {
    document.getElementById('btn-confirm-delete').disabled = false;
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
  adminKey = '';
}

let _toastTimer;
function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  requestAnimationFrame(() => {
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  });
}

// Close modal on backdrop click
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('open');
    }
  });
});
