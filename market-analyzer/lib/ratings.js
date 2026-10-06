// レーティング（証券会社のアナリストによる投資判断・目標株価）
// ・Yahoo Finance のアナリスト集計（主に米国株・日本の大型株）
// ・Google ニュースから「目標株価」「格上げ」などのニュース（日本株向け）
import { getNews } from './news.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
let session = null; // { cookie, crumb, at }

// Yahoo の詳しいデータには「クッキー」と「クラム」という通行証が必要
async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < 3600 * 1000) return session;
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const setCookie = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') || ''];
  const cookie = setCookie.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(15000) });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 50) throw new Error('アナリスト情報の取得に失敗しました');
  session = { cookie, crumb, at: Date.now() };
  return session;
}

const GRADES = [
  [/strong buy/i, '強い買い', 2], [/buy|outperform|overweight|accumulate|positive|add/i, '買い', 1],
  [/strong sell/i, '強い売り', -2], [/sell|underperform|underweight|reduce|negative/i, '売り', -1],
  [/hold|neutral|equal|market perform|sector perform|in-line|peer perform|mixed/i, '中立', 0],
];
export function gradeJa(g) {
  for (const [re, ja] of GRADES) if (re.test(g || '')) return ja;
  return g || '—';
}
const ACTIONS = { up: '格上げ', down: '格下げ', init: '新しく評価を開始', main: '評価を据え置き', reit: '評価を据え置き' };

const FIRMS = [
  [/morgan stanley/i, 'モルガン・スタンレー'], [/goldman/i, 'ゴールドマン・サックス'], [/jp ?morgan/i, 'JPモルガン'], [/bank of america|bofa/i, 'バンク・オブ・アメリカ'],
  [/citi/i, 'シティグループ'], [/barclays/i, 'バークレイズ'], [/ubs/i, 'UBS'], [/deutsche/i, 'ドイツ銀行'], [/wells fargo/i, 'ウェルズ・ファーゴ'],
  [/jefferies/i, 'ジェフリーズ'], [/mizuho/i, 'みずほ証券'], [/nomura/i, '野村証券'], [/daiwa/i, '大和証券'], [/smbc|nikko/i, 'SMBC日興証券'],
  [/bernstein/i, 'バーンスタイン'], [/evercore/i, 'エバーコア'], [/piper/i, 'パイパー・サンドラー'], [/raymond james/i, 'レイモンド・ジェームズ'],
  [/rbc/i, 'RBCキャピタル'], [/td cowen|cowen/i, 'TDコーエン'], [/oppenheimer/i, 'オッペンハイマー'], [/wedbush/i, 'ウェドブッシュ'],
  [/needham/i, 'ニーダム'], [/truist/i, 'トゥルーイスト'], [/hsbc/i, 'HSBC'], [/macquarie/i, 'マッコーリー'], [/bmo/i, 'BMOキャピタル'], [/keybanc/i, 'キーバンク'],
];
export function firmJa(f) {
  for (const [re, ja] of FIRMS) if (re.test(f || '')) return ja;
  return f || '';
}

const raw = (v) => (v && typeof v === 'object' ? v.raw : v) ?? null;

export function parseSummary(json) {
  const r = json?.quoteSummary?.result?.[0];
  if (!r) return null;
  const fd = r.financialData || {};
  const trend = (r.recommendationTrend?.trend || []).find((t) => t.period === '0m') || r.recommendationTrend?.trend?.[0] || null;
  const history = (r.upgradeDowngradeHistory?.history || []).slice(0, 12).map((h) => ({
    date: new Date(raw(h.epochGradeDate) * 1000).toISOString().slice(0, 10),
    firm: firmJa(h.firm),
    from: h.fromGrade ? gradeJa(h.fromGrade) : '',
    to: gradeJa(h.toGrade),
    action: ACTIONS[h.action] || '評価',
    up: h.action === 'up', down: h.action === 'down',
  }));
  const mean = raw(fd.recommendationMean);
  return {
    price: raw(fd.currentPrice),
    target: { mean: raw(fd.targetMeanPrice), high: raw(fd.targetHighPrice), low: raw(fd.targetLowPrice) },
    analysts: raw(fd.numberOfAnalystOpinions),
    // 1=強い買い 〜 5=強い売り
    mean,
    consensus: mean == null ? null : mean <= 1.5 ? '強い買い' : mean <= 2.5 ? '買い' : mean <= 3.5 ? '中立' : mean <= 4.5 ? '売り' : '強い売り',
    counts: trend ? { strongBuy: trend.strongBuy || 0, buy: trend.buy || 0, hold: trend.hold || 0, sell: trend.sell || 0, strongSell: trend.strongSell || 0 } : null,
    history,
  };
}

async function fetchSummary(symbol) {
  const modules = 'financialData,recommendationTrend,upgradeDowngradeHistory';
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(s.crumb)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) continue; // 通行証の期限切れ → 取り直す
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseSummary(await res.json());
  }
  return null;
}

const RATING_WORDS = /目標株価|レーティング|格上げ|格下げ|投資判断|強気|弱気|オーバーウエート|アンダーウエート|買い推奨|新規カバレッジ/;

const cache = new Map();

export async function getRatings(symbol, name) {
  const key = `${symbol}|${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const isJp = /\.T$/.test(symbol);
  const [summary, news] = await Promise.all([
    fetchSummary(symbol).catch(() => null),
    isJp && name
      ? getNews(`${name} 目標株価`).then((n) => n.items.filter((x) => RATING_WORDS.test(x.title) && x.verdict !== '除外').slice(0, 10)).catch(() => [])
      : Promise.resolve([]),
  ]);
  const data = { symbol, summary, news };
  cache.set(key, { at: Date.now(), data });
  return data;
}
