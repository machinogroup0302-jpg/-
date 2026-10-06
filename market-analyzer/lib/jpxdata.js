// 日本取引所（JPX）の公開ファイルの読み取り（決算発表予定日・信用取引残高）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_RAW = 'https://raw.githubusercontent.com/machinogroup0302-jpg/-/claude/trusting-planck-dsasvf/market-analyzer/data/';

// Excel の日付（日付型・数値・文字）を YYYY-MM-DD にする
export function toDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // Excel の日付は日本時間の 0 時なので、ずれないように 12 時間足して日付を取る
    return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && v > 30000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v ?? '').normalize('NFKC');
  let m = s.match(/(20\d{2})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(20\d{2})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function headerIndex(rows, must) {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const cells = rows[r].map((c) => String(c).normalize('NFKC').replace(/\s/g, ''));
    if (must.every((m) => cells.some((c) => c.includes(m)))) return r;
  }
  return -1;
}

const col = (header, ...names) => header.findIndex((c) => names.some((n) => c.includes(n)));

// 決算発表予定日：発表予定日・コード・会社名・決算期末・業種名・種別・市場区分
export function parseEarningsRows(rows) {
  const h = headerIndex(rows, ['コード']);
  if (h < 0) return [];
  const header = rows[h].map((c) => String(c).normalize('NFKC').replace(/\s/g, ''));
  const ci = {
    date: col(header, '発表予定日', '予定日', '発表日'),
    code: col(header, 'コード'),
    name: col(header, '会社名', '銘柄名'),
    period: col(header, '決算期末', '決算期'),
    sector: col(header, '業種'),
    kind: col(header, '種別', '区分'),
    market: col(header, '市場'),
  };
  const out = [];
  for (const r of rows.slice(h + 1)) {
    let code = String(r[ci.code] ?? '').normalize('NFKC').trim().toUpperCase();
    if (/^[0-9][0-9A-Z]{3}0$/.test(code)) code = code.slice(0, 4); // 5けた表記（末尾0）は4けたにする
    const date = toDate(r[ci.date]);
    if (!/^[0-9][0-9A-Z]{3}$/.test(code) || !date) continue;
    const period = ci.period >= 0 ? String(r[ci.period] ?? '').normalize('NFKC').trim() : '';
    out.push({
      date,
      code,
      name: String(r[ci.name] ?? '').normalize('NFKC').trim(),
      period: toDate(period) ? toDate(period).slice(0, 7) : period,
      sector: ci.sector >= 0 ? String(r[ci.sector] ?? '').trim() : '',
      kind: ci.kind >= 0 ? String(r[ci.kind] ?? '').normalize('NFKC').trim() : '',
      market: ci.market >= 0 ? String(r[ci.market] ?? '').normalize('NFKC').trim() : '',
    });
  }
  return out;
}

const num = (v) => {
  const n = Number(String(v ?? '').normalize('NFKC').replace(/[,\s]/g, '').replace(/^▲|^△/, '-'));
  return Number.isFinite(n) ? n : null;
};

// 信用取引の週末残高：コード・売残高・買残高（合計の列を使う）
export function parseMarginRows(rows) {
  const h = headerIndex(rows, ['コード']);
  if (h < 0) return [];
  // 見出しが2行に分かれていることがあるので、下の行と合わせて読む
  const header = rows[h].map((c, i) => `${c}${rows[h + 1]?.[i] ?? ''}`.normalize('NFKC').replace(/\s/g, ''));
  const ci = { code: col(header, 'コード'), name: col(header, '銘柄名', '銘柄'), sell: col(header, '売残'), buy: col(header, '買残') };
  if (ci.sell < 0 || ci.buy < 0) return [];
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const code = String(r[ci.code] ?? '').normalize('NFKC').trim().toUpperCase().slice(0, 4);
    const buy = num(r[ci.buy]), sell = num(r[ci.sell]);
    if (!/^[0-9][0-9A-Z]{3}$/.test(code) || buy == null || sell == null) continue;
    out.push({ code, name: String(r[ci.name] ?? '').trim(), buy, sell });
  }
  return out;
}

// 信用残のPDF（行ごとの文字）から読む。並び方を確認してから仕上げる
export function parseMarginLines(lines) {
  const out = [];
  for (const l of lines) {
    const code = l.find((x) => /^[0-9][0-9A-Z]{3}0?$/.test(x));
    if (!code) continue;
    const nums = l.map((x) => num(x)).filter((v) => v != null);
    if (nums.length < 4) continue;
    out.push({ code: code.slice(0, 4), raw: l });
  }
  return out;
}

// サーバー：GitHub に保存したデータを読む（なければ同梱のファイル）
const cache = new Map();
export async function loadRepoData(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.data;
  let data = null;
  try {
    const res = await fetch(REPO_RAW + name, { signal: AbortSignal.timeout(20000) });
    if (res.ok) data = await res.json();
  } catch { /* 次へ */ }
  if (!data) {
    try { data = JSON.parse(await fs.readFile(path.join(here, '..', 'data', name), 'utf8')); } catch { data = null; }
  }
  if (data) cache.set(name, { at: Date.now(), data });
  return data;
}
