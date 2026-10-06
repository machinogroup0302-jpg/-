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
  const meta = store.get(`sync_favs_${mode}`, {});
  store.set(`sync_favs_${mode}`, { ...meta, dirty: true, rev: (meta.rev || 0) + 1 });
  schedulePush();
}

// ---- パソコンとスマホでお気に入りを共有する ----
// 端末ごとに「最後にサーバーとそろえた時刻（ts）」と「まだ送っていない変更があるか（dirty）」を覚えておく
const MODES = ['fx', 'stock', 'us'];
let pushTimer = null;
let syncing = null;
let onSynced = () => {};
export const syncState = { durable: null, error: '', last: 0 };

export function onFavsSynced(fn) { onSynced = fn; }

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushDirty().catch(() => {}), 800);
}

async function pushDirty() {
  for (const mode of MODES) {
    const key = `favs_${mode}`;
    const meta = store.get(`sync_${key}`, {});
    if (!meta.dirty) continue;
    const r = await api('/api/prefs', { method: 'PUT', body: { key, value: getFavs(mode) } });
    // 送っている間にまた変わっていたら、dirty のまま残して次に送る
    const now = store.get(`sync_${key}`, {});
    store.set(`sync_${key}`, { ts: r.ts, rev: now.rev || 0, dirty: (now.rev || 0) !== (meta.rev || 0) });
    syncState.durable = r.durable;
  }
}

const union = (a, b) => {
  const seen = new Set(a.map((f) => favCode(f.code)));
  return [...a, ...b.filter((f) => !seen.has(favCode(f.code)))];
};

// サーバーの最新と、この端末のお気に入りをそろえる
export function syncFavs() {
  syncing ||= (async () => {
    try {
      const { items, durable, error } = await api('/api/prefs');
      syncState.durable = durable;
      syncState.error = error || '';
      let changed = false;
      for (const mode of MODES) {
        const key = `favs_${mode}`;
        const remote = items[key];
        const meta = store.get(`sync_${key}`, null);
        const own = store.get(key, null);
        if (!meta) {
          // 初めてそろえる端末：今までのお気に入りは消さずに、サーバーのものと合わせる
          if (remote && own) { store.set(key, union(remote.value, own)); changed = true; }
          else if (remote) { store.set(key, remote.value); changed = true; }
          store.set(`sync_${key}`, { ts: remote?.ts || 0, dirty: !!own });
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
