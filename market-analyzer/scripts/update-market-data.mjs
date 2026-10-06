// 日本取引所（JPX）の公開データを取ってきて data/ に保存する（GitHub Actions で実行）
// ・決算発表予定日（Excel） → data/earnings.json
// ・銘柄別信用取引残高（毎日のPDF） → data/margin.json
import fs from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { parseEarningsRows, parseMarginRows, parseMarginLines } from '../lib/jpxdata.js';

// PDF の文字を、行ごと（同じ高さの文字のまとまり）に取り出す
async function pdfLines(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      // ページが横向きに回転しているので、同じ横位置（x）の文字を1社分としてまとめる
      const x = Math.round(it.transform[4]);
      const key = [...rows.keys()].find((k) => Math.abs(k - x) <= 2) ?? x;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ y: it.transform[5], s: it.str.trim() });
    }
    [...rows.entries()].sort((a, b) => a[0] - b[0]).forEach(([, items]) => out.push(items.sort((a, b) => b.y - a.y).map((i) => i.s)));
  }
  return out;
}

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
    const pdfs = all.filter((f) => /mtall\.pdf$/i.test(f));
    console.log('信用残: PDFを読みます', pdfs[0]);
    if (pdfs.length) {
      const lines = await pdfLines(await get(pdfs[0], false));
      const items = parseMarginLines(lines);
      console.log(`  読み取れた銘柄: ${items.length}件`, JSON.stringify(items.filter((x) => x.code === '7203')));
      if (items.length > 500) await save('margin.json', { items, source: pdfs[0], date: (pdfs[0].match(/(\d{8})_mtall/) || [])[1] });
    }
  }
} catch (e) {
  console.log('信用残の取得に失敗:', e.message);
}
