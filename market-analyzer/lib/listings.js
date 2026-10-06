// 東証の全上場企業の一覧
// 日本取引所グループ（JPX）が毎月公開している「東証上場銘柄一覧」を読み込み、1日1回確認して最新にする。
// 前回の一覧になかった会社は「新しく上場した会社」として記録する。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

const LIST_URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls';
const NEW_URL = 'https://www.jpx.co.jp/listing/stocks/new/index.html';
const CACHE_FILE = path.join(process.env.DATA_DIR || os.tmpdir(), 'ma-listings.json');
const REFRESH_MS = 24 * 3600 * 1000;
const UA = 'Mozilla/5.0 (compatible; market-analyzer/1.0)';

let state = null; // { fetchedAt, items: [...], firstSeen: {code: date}, upcoming: [...] }
let loading = null;

// 市場の名前を短くする（ETF・REIT・PRO Market は対象外）
export function shortMarket(m) {
  const s = String(m || '');
  if (/ETF|ETN|REIT|インフラ|出資証券|PRO Market/i.test(s)) return null;
  if (s.includes('プライム')) return 'プライム';
  if (s.includes('スタンダード')) return 'スタンダード';
  if (s.includes('グロース')) return 'グロース';
  if (s.includes('外国')) return '外国株';
  return null;
}

// Excel の中身（行の配列）から会社の一覧を作る
export function parseListingRows(rows) {
  const h = rows.findIndex((r) => r.some((c) => String(c).trim() === 'コード'));
  if (h < 0) throw new Error('上場銘柄一覧の形式が変わったため読み込めませんでした');
  const header = rows[h].map((c) => String(c).trim());
  const col = (name) => header.findIndex((c) => c === name);
  const ci = { code: col('コード'), name: col('銘柄名'), market: col('市場・商品区分'), sector: col('33業種区分'), size: col('規模区分') };
  const items = [];
  for (const r of rows.slice(h + 1)) {
    const code = String(r[ci.code] ?? '').trim().toUpperCase();
    if (!/^[0-9][0-9A-Z]{3}$/.test(code)) continue;
    const market = shortMarket(r[ci.market]);
    if (!market) continue;
    const sector = String(r[ci.sector] ?? '').trim();
    items.push({
      code,
      // 全角の英数字（ＫＤＤＩ など）は読みやすい半角にする
      name: String(r[ci.name] ?? '').normalize('NFKC').trim(),
      market,
      sector: sector && sector !== '-' ? sector : 'その他',
      size: String(r[ci.size] ?? '').trim().replace(/^-$/, ''),
    });
  }
  return items;
}

// JPX の「新規上場会社情報」ページから、上場日・コード・会社名を拾う（取れなければ空）
export function parseNewListings(html) {
  const out = [];
  const rows = String(html).match(/<tr[\s\S]*?<\/tr>/g) || [];
  for (const tr of rows) {
    const text = tr.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const date = text.match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})/);
    const code = text.match(/(?:^|\s|（|\()([0-9][0-9A-Z]{3})(?:\s|）|\)|$)/);
    if (!date || !code) continue;
    const name = text
      .replace(date[0], '')
      .replace(code[1], '')
      .replace(/[（）()]/g, ' ')
      .split(' ')
      .filter((w) => w && !/^\d/.test(w) && !/上場|市場|プライム|スタンダード|グロース|日$/.test(w))[0] || '';
    out.push({ date: `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`, code: code[1], name });
  }
  const seen = new Set();
  return out.filter((x) => (seen.has(x.code) ? false : seen.add(x.code)));
}

async function download() {
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`上場銘柄一覧を取得できませんでした (HTTP ${res.status})`);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  const items = parseListingRows(rows);
  if (items.length < 1000) throw new Error('上場銘柄一覧の件数が少なすぎます');
  return items;
}

async function downloadUpcoming() {
  try {
    const res = await fetch(NEW_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    return parseNewListings(await res.text());
  } catch {
    return [];
  }
}

export function mergeListing(prev, items, upcoming, today) {
  const firstSeen = { ...(prev?.firstSeen || {}) };
  if (prev?.items?.length) {
    const known = new Set(prev.items.map((x) => x.code));
    for (const it of items) if (!known.has(it.code) && !firstSeen[it.code]) firstSeen[it.code] = today;
  }
  return { fetchedAt: Date.now(), items, firstSeen, upcoming };
}

async function refresh() {
  const [items, upcoming] = await Promise.all([download(), downloadUpcoming()]);
  state = mergeListing(state, items, upcoming, new Date().toISOString().slice(0, 10));
  try { await fs.writeFile(CACHE_FILE, JSON.stringify(state)); } catch { /* 保存できなくても動かす */ }
  return state;
}

export async function getListings() {
  if (!state) {
    try { state = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')); } catch { state = null; }
  }
  const stale = !state || Date.now() - state.fetchedAt > REFRESH_MS;
  if (stale && !loading) {
    loading = refresh().finally(() => { loading = null; });
  }
  if (!state) await loading; // 初回は読み込み終わるまで待つ
  else if (loading) loading.catch((e) => console.error('上場銘柄一覧の更新に失敗:', e.message));
  return state;
}

// 読み込み済みの一覧から会社名を引く（待たずにすぐ返す）
export function nameFromCache(code) {
  return state?.items?.find((x) => x.code === code)?.name?.normalize('NFKC') || null;
}

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

export async function searchListings(q, limit = 20) {
  const { items } = await getListings();
  const n = norm(q);
  if (!n) return [];
  const starts = [], contains = [];
  for (const it of items) {
    if (it.code.toLowerCase().startsWith(n) || norm(it.name).startsWith(n)) starts.push(it);
    else if (norm(it.name).includes(n)) contains.push(it);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

export async function listingMeta() {
  const s = await getListings();
  const since = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);
  const byCode = new Map(s.items.map((x) => [x.code, x]));
  const recent = Object.entries(s.firstSeen)
    .filter(([, d]) => d >= since)
    .map(([code, date]) => ({ code, date, name: byCode.get(code)?.name || '', market: byCode.get(code)?.market || '' }));
  const upcoming = (s.upcoming || []).map((u) => ({ ...u, name: byCode.get(u.code)?.name || u.name, market: byCode.get(u.code)?.market || '' }));
  const seen = new Set();
  const newListings = [...upcoming, ...recent]
    .filter((x) => (seen.has(x.code) ? false : seen.add(x.code)))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 40);
  const sectors = [...new Set(s.items.map((x) => x.sector))].sort((a, b) => a.localeCompare(b, 'ja'));
  const markets = {};
  for (const it of s.items) markets[it.market] = (markets[it.market] || 0) + 1;
  return { count: s.items.length, updatedAt: s.fetchedAt, sectors, markets, newListings };
}
