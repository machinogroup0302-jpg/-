// 日本取引所（JPX）の公開データを取ってきて data/ に保存する（GitHub Actions で実行）
// ・決算発表予定日（Excel） → data/earnings.json
// ・銘柄別信用取引週末残高（ファイルの形式を確認して、読めれば data/margin.json）
import fs from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { parseEarningsRows, parseMarginRows } from '../lib/jpxdata.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en;q=0.8',
};
const DATA = new URL('../data/', import.meta.url);

async function get(url, asText = true) {
  const res = await fetch(url, { headers: { ...HEADERS, Referer: url }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

function links(html, base, re) {
  return [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => re.test(h)).map((h) => new URL(h, base).href))];
}

function sheetRows(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  return wb.SheetNames.flatMap((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }));
}

async function save(name, data) {
  await fs.mkdir(DATA, { recursive: true });
  const file = new URL(name, DATA);
  let prev = null;
  try { prev = await fs.readFile(file, 'utf8'); } catch { /* 初回 */ }
  const body = JSON.stringify(data.items);
  if (prev && JSON.stringify(JSON.parse(prev).items) === body) {
    console.log(`${name}: 変更なし（${data.items.length}件）`);
    return;
  }
  await fs.writeFile(file, JSON.stringify({ ...data, fetchedAt: Date.now() }));
  console.log(`${name}: 保存しました（${data.items.length}件）`);
}

// ---- 決算発表予定日 ----
try {
  const page = 'https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html';
  const files = links(await get(page), page, /\.xlsx?$/i);
  console.log('決算発表予定日のファイル:', files);
  const items = [];
  for (const f of files) {
    const rows = sheetRows(await get(f, false));
    console.log(`  ${f}: ${rows.length}行。先頭:`, JSON.stringify(rows.slice(0, 6)));
    items.push(...parseEarningsRows(rows));
  }
  const seen = new Set();
  const uniq = items.filter((x) => { const k = `${x.date}|${x.code}|${x.kind}`; return seen.has(k) ? false : seen.add(k); })
    .sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  if (uniq.length) await save('earnings.json', { items: uniq });
  else console.log('決算発表予定日: 読み取れた行がありません');
} catch (e) {
  console.log('決算発表予定日の取得に失敗:', e.message);
}

// ---- 銘柄別信用取引週末残高 ----
try {
  const page = 'https://www.jpx.co.jp/markets/statistics-equities/margin/01.html';
  const html = await get(page);
  const all = links(html, page, /\.(xlsx?|csv|pdf)$/i);
  console.log('信用残のページにあるファイル:', all.slice(0, 20));
  const xls = all.filter((f) => /\.(xlsx?|csv)$/i.test(f));
  if (xls.length) {
    const rows = sheetRows(await get(xls[0], false));
    console.log(`  ${xls[0]}: ${rows.length}行。先頭:`, JSON.stringify(rows.slice(0, 10)));
    const items = parseMarginRows(rows);
    if (items.length > 100) await save('margin.json', { items, source: xls[0] });
    else console.log('信用残: 読み取れた行が少なすぎます', items.length);
  } else {
    console.log('信用残: Excel/CSVのファイルが見つかりません（PDFのみ）');
  }
} catch (e) {
  console.log('信用残の取得に失敗:', e.message);
}
