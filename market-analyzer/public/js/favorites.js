// お気に入り（為替・日本株・米国株で別々に保存）
import { store, api } from './util.js';

export const DEFAULT_FAVS = {
  fx: [
    { code: 'USDJPY', name: 'ドル円' }, { code: 'EURJPY', name: 'ユーロ円' }, { code: 'GBPJPY', name: 'ポンド円' },
    { code: 'AUDJPY', name: '豪ドル円' }, { code: 'MXNJPY', name: 'メキシコペソ円' }, { code: 'EURUSD', name: 'ユーロドル' },
  ],
  stock: [
    { code: '^N225', name: '日経平均' }, { code: '7203', name: 'トヨタ自動車' }, { code: '9984', name: 'ソフトバンクG' },
    { code: '6758', name: 'ソニーG' }, { code: '8306', name: '三菱UFJ' }, { code: '7974', name: '任天堂' },
  ],
  us: [
    { code: '^GSPC', name: 'S&P500' }, { code: '^IXIC', name: 'ナスダック' }, { code: 'AAPL', name: 'アップル' },
    { code: 'NVDA', name: 'エヌビディア' }, { code: 'MSFT', name: 'マイクロソフト' }, { code: 'TSLA', name: 'テスラ' }, { code: 'AMZN', name: 'アマゾン' },
  ],
};

const isFxCode = (c) => /^[A-Z]{6}(=X)?$/i.test(c);

export function getFavs(mode) {
  const own = store.get(`favs_${mode}`, null);
  if (own) return own;
  // 以前の共通のお気に入りは、為替と日本株に振り分けて引き継ぐ
  const old = store.get('favs', null);
  if (old && mode !== 'us') {
    const mine = old.filter((f) => (mode === 'fx' ? isFxCode(f.code) : !isFxCode(f.code)));
    if (mine.length) return mine;
  }
  return DEFAULT_FAVS[mode];
}

export function setFavs(mode, list) {
  store.set(`favs_${mode}`, list);
  markDirty(`favs_${mode}`);
}

// ---- パソコンとスマホでお気に入り・あなたの設定を共有する ----
// 端末ごとに「最後にサーバーとそろえた時刻（ts）」と「まだ送っていない変更があるか（dirty）」を覚えておく
const MODES = ['fx', 'stock', 'us'];
const KEYS = [...MODES.map((m) => `favs_${m}`), ...MODES.map((m) => `holdings_${m}`), 'profile'];
const localValue = (key) => (key.startsWith('favs_') ? getFavs(key.slice(5)) : store.get(key, null));
let pushTimer = null;
let syncing = null;
let onSynced = () => {};
export const syncState = { durable: null, error: '', last: 0, lastBackupAt: 0, lastAlertAt: 0 };

export function onFavsSynced(fn) { onSynced = fn; }

function markDirty(key) {
  const meta = store.get(`sync_${key}`, {});
  store.set(`sync_${key}`, { ...meta, dirty: true, rev: (meta.rev || 0) + 1 });
  schedulePush();
}

// あなたの設定（メール・予算など）
export const DEFAULT_PROFILE = { email: '', budget: 0, riskPct: 2, maxPos: 3, notify: { fx: true, stock: true, us: true } };
export function getProfile() {
  return { ...DEFAULT_PROFILE, ...(store.get('profile', null) || {}) };
}
// 自分で持っている株・通貨
export function getHoldings(mode) { return store.get(`holdings_${mode}`, []) || []; }
export function setHoldings(mode, list) {
  store.set(`holdings_${mode}`, list);
  markDirty(`holdings_${mode}`);
}

export function setProfile(p) {
  store.set('profile', p);
  markDirty('profile');
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushDirty().catch((e) => { syncState.error = e.message; }), 800);
}

async function pushDirty() {
  for (const key of KEYS) {
    const meta = store.get(`sync_${key}`, {});
    if (!meta.dirty) continue;
    const value = localValue(key);
    if (value == null) { store.set(`sync_${key}`, { ...meta, dirty: false }); continue; }
    const r = await api('/api/prefs', { method: 'PUT', body: { key, value } });
    // 送っている間にまた変わっていたら、dirty のまま残して次に送る
    const now = store.get(`sync_${key}`, {});
    store.set(`sync_${key}`, { ts: r.ts, rev: now.rev || 0, dirty: (now.rev || 0) !== (meta.rev || 0) });
  }
}

const union = (a, b) => {
  const seen = new Set(a.map((f) => favCode(f.code)));
  return [...a, ...b.filter((f) => !seen.has(favCode(f.code)))];
};

// サーバーの最新と、この端末のお気に入り・設定をそろえる
export function syncFavs() {
  syncing ||= (async () => {
    try {
      const { items, durable, lastBackupAt, lastAlertAt } = await api('/api/prefs');
      syncState.durable = durable;
      syncState.lastBackupAt = lastBackupAt || 0;
      syncState.lastAlertAt = lastAlertAt || 0;
      syncState.error = '';
      let changed = false;
      for (const key of KEYS) {
        const remote = items[key];
        const meta = store.get(`sync_${key}`, null);
        const own = store.get(key, null);
        if (!meta) {
          // 初めてそろえる端末：今までのお気に入りは消さずに、サーバーのものと合わせる
          if (remote && own && key.startsWith('favs_')) { store.set(key, union(remote.value, own)); changed = true; }
          else if (remote) { store.set(key, remote.value); changed = true; }
          store.set(`sync_${key}`, { ts: remote?.ts || 0, dirty: !!own && (key.startsWith('favs_') || !remote) });
        } else if (meta.dirty) {
          // この端末で変えたものがまだ送れていない → こちらを送る
        } else if (remote && remote.ts > (meta.ts || 0)) {
          store.set(key, remote.value);
          store.set(`sync_${key}`, { ts: remote.ts, dirty: false });
          changed = true;
        }
      }
      await pushDirty();
      syncState.last = Date.now();
      if (changed) onSynced();
    } catch (e) {
      syncState.error = e.message;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// 銘柄（USDJPY=X / 7203.T / AAPL）をお気に入りのコード（USDJPY / 7203 / AAPL）にする
export function favCode(symbol) {
  return String(symbol || '').replace(/=X$|\.T$/i, '').toUpperCase();
}

export function isFav(mode, symbol) {
  const code = favCode(symbol);
  return getFavs(mode).some((f) => favCode(f.code) === code);
}

export function toggleFav(mode, symbol, name) {
  const code = favCode(symbol);
  const list = getFavs(mode);
  const next = list.some((f) => favCode(f.code) === code) ? list.filter((f) => favCode(f.code) !== code) : [...list, { code, name: name || code }];
  setFavs(mode, next);
  return next;
}

export function removeFav(mode, code) {
  const next = getFavs(mode).filter((f) => favCode(f.code) !== favCode(code));
  setFavs(mode, next);
  return next;
}
