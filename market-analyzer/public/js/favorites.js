// お気に入り（為替・日本株・米国株で別々に保存）
import { store } from './util.js';

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
