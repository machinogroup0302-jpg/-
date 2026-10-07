// 画面全体で使う小さな道具

// ログインしている人ごとに保存場所を分ける（index.html で window.MA_NS を決めている）
const NS = () => 'ma_' + ((typeof window !== 'undefined' && window.MA_NS) || '');
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(NS() + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(NS() + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  clear() {
    try {
      // 持ち主の分を消すときに、ほかの人の分（ma_u_…）は消さない
      const ns = NS();
      Object.keys(localStorage).filter((k) => k.startsWith(ns) && (ns !== 'ma_' || !k.startsWith('ma_u_'))).forEach((k) => localStorage.removeItem(k));
    } catch { /* 保存できない環境では何もしない */ }
  },
};

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* 空の応答 */ }
  if (res.status === 401 && path !== '/api/login') {
    location.reload();
  }
  if (!res.ok) throw new Error(data?.error || `通信エラー (${res.status})`);
  return data;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function $(id) {
  return document.getElementById(id);
}

let toastTimer;
export function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// 価格の桁数（ドル円 150.123 → 3桁、ユーロドル 1.08765 → 5桁、株 3,000 → 1桁）
export function digitsFor(price) {
  if (price >= 1000) return 1;
  if (price >= 20) return 3;
  return 5;
}

export function fmtPrice(v, digits) {
  if (v == null || Number.isNaN(v)) return '—';
  const d = digits ?? digitsFor(Math.abs(v));
  return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtYen(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const r = Math.round(v);
  return `${r > 0 ? '+' : ''}${r.toLocaleString('ja-JP')}円`;
}

export function signalClass(s) {
  return /買|上昇|強気/.test(s) ? 'buy' : /売|下落|下降|弱気/.test(s) ? 'sell' : 'neutral';
}

export function busy(btn, on, label = '処理中…') {
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span> ${esc(label)}`;
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.label || btn.innerHTML;
    btn.disabled = false;
  }
}

// 画像を読み込み、AIに送る大きさ（長い辺1568px）に縮めて data URL にする
export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = url;
  });
}

export function imageToDataUrl(img, maxSide = 1568) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

// チャートの時刻を日本時間で表示するためのずらし
export const JST = 9 * 3600;

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
