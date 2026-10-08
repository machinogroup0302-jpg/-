// 価格データの取得（Yahoo Finance のチャートAPI）
// 為替: USDJPY=X のように末尾に =X、日本株: 7203.T のように末尾に .T

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

// 画面で選べる時間足 → Yahoo の interval / range
export const TIMEFRAMES = {
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '1mo' },
  '1h': { interval: '60m', range: '3mo' },
  '4h': { interval: '60m', range: '1y', aggregate: 4 },
  '1d': { interval: '1d', range: '2y' },
  '1wk': { interval: '1wk', range: '10y' },
};

const cache = new Map();
const CACHE_MS = 60 * 1000;

// 日本語の名前（指数）
export const INDEX_NAMES = { '^N225': '日経平均', '^TOPX': 'TOPIX', '1306.T': 'TOPIX連動ETF' };

export function normalizeSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) throw new Error('銘柄が空です');
  if (!/^[A-Z0-9^.=\-]{1,20}$/.test(s)) throw new Error('銘柄コードの形式が正しくありません');
  // 4桁の数字だけなら日本株とみなす
  if (/^\d{4}$/.test(s) || /^\d{3}[A-Z]$/.test(s)) return `${s}.T`;
  // USDJPY のような6文字の通貨ペア
  if (/^[A-Z]{6}$/.test(s)) return `${s}=X`;
  return s;
}

async function fetchJson(path) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      // 返事が来ないときに、ずっと待ち続けないように（12秒であきらめて次の場所を試す）
      const res = await fetch(host + path, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`データ取得に失敗しました (HTTP ${res.status})`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// 1時間足を4時間足などにまとめる
export function aggregateCandles(candles, n) {
  const out = [];
  const bucketSec = n * 3600;
  let cur = null;
  for (const c of candles) {
    const key = Math.floor(c.time / bucketSec) * bucketSec;
    if (!cur || cur.time !== key) {
      if (cur) out.push(cur);
      cur = { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function parseChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r) {
    const msg = json?.chart?.error?.description || '銘柄が見つかりません';
    throw new Error(msg);
  }
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some((v) => v == null || Number.isNaN(v))) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] || 0 });
  }
  return {
    symbol: r.meta?.symbol,
    name: r.meta?.shortName || r.meta?.longName || r.meta?.symbol,
    currency: r.meta?.currency,
    price: r.meta?.regularMarketPrice,
    candles,
  };
}

export async function getChart(rawSymbol, tf = '1h') {
  const symbol = normalizeSymbol(rawSymbol);
  const conf = TIMEFRAMES[tf];
  if (!conf) throw new Error('時間足の指定が正しくありません');
  const key = `${symbol}|${tf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${conf.interval}&range=${conf.range}&includePrePost=false`;
  const data = parseChart(await fetchJson(path));
  if (conf.aggregate) data.candles = aggregateCandles(data.candles, conf.aggregate);
  data.timeframe = tf;
  cache.set(key, { at: Date.now(), data });
  return data;
}

// 過去の決まった期間の値動き（取引分析で「持っていた間の値動き」を調べるため）
const HISTORY_IV = { '5m': 59 * 86400, '60m': 729 * 86400, '1d': 20 * 365 * 86400 };
export async function getHistory(rawSymbol, interval, from, to) {
  const symbol = normalizeSymbol(rawSymbol);
  if (!HISTORY_IV[interval]) throw new Error('足の指定が正しくありません');
  const now = Math.floor(Date.now() / 1000);
  const p1 = Math.max(Math.floor(Number(from)) || 0, now - HISTORY_IV[interval]);
  const p2 = Math.min(Math.floor(Number(to)) || now, now);
  if (!(p2 > p1)) throw new Error('期間の指定が正しくありません');
  const key = `h|${symbol}|${interval}|${Math.floor(p1 / 3600)}|${Math.floor(p2 / 3600)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const data = parseChart(await fetchJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${p1}&period2=${p2}&includePrePost=false`));
  const out = { symbol: data.symbol, interval, candles: data.candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })) };
  if (cache.size > 400) cache.delete(cache.keys().next().value); // 古いものから捨てる
  cache.set(key, { at: Date.now(), data: out });
  return out;
}
