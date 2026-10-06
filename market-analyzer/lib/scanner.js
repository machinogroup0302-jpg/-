// 全上場企業をまとめてチェックする（日足・約6か月分）
// Yahoo Finance の「spark」で20社ずつまとめて取得し、使えないときは1社ずつ取得する
import { getListings } from './listings.js';
import { technicalSummary } from '../public/js/indicators.js';
import { stopInfo } from '../public/js/limits.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const BATCH = 20;
const KEEP_MS = 30 * 60 * 1000; // 30分以内のチェック結果は使い回す

let job = null;

async function getJson(pathAndQuery) {
  let last;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + pathAndQuery, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// spark の2種類の形式（v8 と v7）を、{ 記号: { timestamps, closes } } にそろえる
export function parseSpark(json) {
  const out = {};
  const list = json?.spark?.result;
  if (Array.isArray(list)) {
    for (const r of list) {
      const resp = r.response?.[0];
      if (resp) out[r.symbol] = { timestamps: resp.timestamp || [], closes: resp.indicators?.quote?.[0]?.close || [] };
    }
    return out;
  }
  for (const [sym, v] of Object.entries(json || {})) {
    if (v && Array.isArray(v.close)) out[sym] = { timestamps: v.timestamp || [], closes: v.close };
  }
  return out;
}

async function fetchSpark(symbols) {
  const q = `?symbols=${symbols.map(encodeURIComponent).join(',')}&range=6mo&interval=1d`;
  try {
    return parseSpark(await getJson('/v8/finance/spark' + q));
  } catch {
    return parseSpark(await getJson('/v7/finance/spark' + q));
  }
}

async function fetchOne(symbol) {
  const json = await getJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`);
  const r = json?.chart?.result?.[0];
  return { timestamps: r?.timestamp || [], closes: r?.indicators?.quote?.[0]?.close || [] };
}

// 終値だけから、指標の計算に使うローソク足をつくる
export function closesToCandles(timestamps, closes) {
  const candles = [];
  let prev = null;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (c == null || Number.isNaN(c)) continue;
    const o = prev ?? c;
    candles.push({ time: timestamps[i] || i, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 0 });
    prev = c;
  }
  return candles;
}

export function evaluate(company, series) {
  const candles = closesToCandles(series.timestamps, series.closes);
  if (candles.length < 2) return null;
  const price = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2].close;
  const tech = candles.length >= 60 ? technicalSummary(candles) : null;
  const month = candles.length > 21 ? price / candles[candles.length - 22].close - 1 : 0;
  return {
    code: company.code,
    symbol: `${company.code}.T`,
    name: company.name,
    market: company.market,
    sector: company.sector,
    price,
    changePct: (price / prevClose - 1) * 100,
    monthPct: month * 100,
    label: tech?.label || 'データ不足',
    score: tech ? Math.round(tech.ratio * 100) : 0,
    reasons: tech ? tech.rows.filter((r) => r.signal !== '中立').slice(0, 3).map((r) => ({ key: r.key, name: r.name, signal: r.signal })) : [],
    stop: stopInfo(prevClose, price),
  };
}

async function run(j) {
  const { items } = await getListings();
  const universe = items.filter((it) => !j.markets.length || j.markets.includes(it.market));
  j.total = universe.length;
  const batches = [];
  for (let i = 0; i < universe.length; i += BATCH) batches.push(universe.slice(i, i + BATCH));
  let sparkWorks = true;

  async function worker() {
    while (batches.length) {
      const batch = batches.shift();
      let data = {};
      if (sparkWorks) {
        try {
          data = await fetchSpark(batch.map((c) => `${c.code}.T`));
          if (!Object.keys(data).length) throw new Error('empty');
        } catch {
          sparkWorks = false;
        }
      }
      for (const c of batch) {
        let s = data[`${c.code}.T`];
        if (!s) {
          try { s = await fetchOne(`${c.code}.T`); } catch { s = null; }
        }
        const r = s ? evaluate(c, s) : null;
        if (r) j.results.push(r); else j.failed++;
        j.done++;
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
}

export function startScan({ markets = [] } = {}) {
  const key = [...markets].sort().join(',');
  if (job && job.status === 'running') return job;
  if (job && job.status === 'done' && job.key === key && Date.now() - job.finishedAt < KEEP_MS) return job;
  job = { id: Date.now(), key, markets, status: 'running', total: 0, done: 0, failed: 0, results: [], startedAt: Date.now() };
  const j = job;
  run(j)
    .then(() => { j.status = 'done'; j.finishedAt = Date.now(); })
    .catch((e) => { j.status = 'error'; j.error = e.message; j.finishedAt = Date.now(); });
  return job;
}

const VIEWS = {
  buy: (r) => r.score > 15,
  sell: (r) => r.score < -15,
  stopHigh: (r) => r.stop?.status === 'ストップ高' || r.stop?.status === 'ストップ高に近い',
  stopLow: (r) => r.stop?.status === 'ストップ安' || r.stop?.status === 'ストップ安に近い',
  up: (r) => r.changePct > 0,
  down: (r) => r.changePct < 0,
  all: () => true,
};
const SORTS = {
  buy: (a, b) => b.score - a.score || b.monthPct - a.monthPct,
  sell: (a, b) => a.score - b.score || a.monthPct - b.monthPct,
  stopHigh: (a, b) => b.stop.ratio - a.stop.ratio,
  stopLow: (a, b) => a.stop.ratio - b.stop.ratio,
  up: (a, b) => b.changePct - a.changePct,
  down: (a, b) => a.changePct - b.changePct,
  all: (a, b) => a.code.localeCompare(b.code),
};

export function scanStatus({ view = 'buy', sector = '', minPrice = 0, maxPrice = 0, limit = 100 } = {}) {
  if (!job) return { status: 'none' };
  const base = { status: job.status, total: job.total, done: job.done, failed: job.failed, error: job.error, finishedAt: job.finishedAt };
  if (job.status !== 'done') return base;
  const pick = VIEWS[view] || VIEWS.buy;
  const list = job.results
    .filter((r) => (!sector || r.sector === sector) && (!minPrice || r.price >= minPrice) && (!maxPrice || r.price <= maxPrice))
    .filter(pick)
    .sort(SORTS[view] || SORTS.buy);
  return { ...base, matched: list.length, results: list.slice(0, Math.min(Number(limit) || 100, 300)) };
}
