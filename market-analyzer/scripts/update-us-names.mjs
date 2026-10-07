// 米国株の日本語名（カタカナ）の一覧を、証券会社が公開している取扱銘柄の一覧から作る（GitHub Actions で実行）
// → data/us-names.json （サイトの米国株の検索で使う）
import fs from 'node:fs/promises';

const SOURCES = [
  // マネックス証券：米国株の取扱銘柄一覧（CSV）
  'https://mxp1.monex.co.jp/pc/pdfroot/public/50/99/Monex_US_STOCK_LIST.csv',
  // 楽天証券：米国株の銘柄検索の結果（CSV）
  'https://www.trkd-asia.com/rakutensec/exportcsvus?all=on&vall=on&r1=on&forwarding=na&target=0&theme=na&returns=na&head_office=na&name=&code=&sector=na&pageNo=&c=us&p=result',
];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', Accept: 'text/csv,*/*', 'Accept-Language': 'ja' };

function decode(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return (utf8.match(/�/g) || []).length > 5 ? new TextDecoder('shift_jis').decode(buf) : utf8;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// どの列がティッカーで、どの列が日本語名かを、中身から見分ける
export function pickColumns(rows) {
  const sample = rows.slice(1, 300);
  const score = (fn) => (i) => sample.filter((r) => fn(r[i] || '')).length;
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  const cols = [...Array(width).keys()];
  const tick = cols.map(score((v) => /^[A-Z][A-Z.\-]{0,5}$/.test(v)));
  const kana = cols.map(score((v) => /[ァ-ヶー]/.test(v)));
  const t = tick.indexOf(Math.max(...tick)), n = kana.indexOf(Math.max(...kana));
  if (tick[t] < sample.length * 0.5 || kana[n] < sample.length * 0.3) return null;
  return { t, n };
}

const items = new Map();
for (const url of SOURCES) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseCsv(decode(Buffer.from(await res.arrayBuffer())));
    console.log(`${url}: ${rows.length}行。先頭:`, JSON.stringify(rows.slice(0, 3)));
    const c = pickColumns(rows);
    if (!c) { console.log('  ティッカーと日本語名の列が見つかりませんでした'); continue; }
    let n = 0;
    for (const r of rows.slice(1)) {
      const symbol = (r[c.t] || '').trim(), name = (r[c.n] || '').normalize('NFKC').trim();
      if (/^[A-Z][A-Z.\-]{0,5}$/.test(symbol) && name && !items.has(symbol)) { items.set(symbol, { symbol: symbol.replace('.', '-'), name }); n++; }
    }
    console.log(`  ${n}銘柄を読み取りました`);
  } catch (e) {
    console.log(`${url}: 取得できませんでした（${e.message}）`);
  }
}

if (items.size >= 300) {
  const list = [...items.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const file = new URL('../data/us-names.json', import.meta.url);
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* 初回 */ }
  if (prev && JSON.stringify(prev.items) === JSON.stringify(list)) console.log(`us-names.json: 変更なし（${list.length}銘柄）`);
  else { await fs.writeFile(file, JSON.stringify({ items: list, fetchedAt: Date.now() })); console.log(`us-names.json: 保存しました（${list.length}銘柄）`); }
} else {
  console.log(`米国株の日本語名：読み取れた銘柄が少ないため保存しません（${items.size}銘柄）`);
}
