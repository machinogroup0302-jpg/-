// 証券会社のCSV（楽天証券の「保有商品一覧」・LION FXの「建玉一覧」など）から、持っている株を取り出す
// 列の名前から、銘柄・数量・平均の値段・売り買い・信用かどうかを探す（会社によって並び方が違っても読めるように）
import { parseCsv, toNumber, parseDate } from './trades.js';

const COL = {
  code: /銘柄コード|コード|ティッカー|シンボル/,
  name: /銘柄名|^銘柄$|銘柄（|通貨ペア|^銘柄/,
  qty: /保有数量|保有株数|残高数量|^数量|株数|Lot数|ロット|建玉数量|残数量|建玉残|^数量（/,
  price: /平均取得価額|平均取得単価|取得単価|取得価額|平均建単価|建単価|建値|新規約定値|約定価格|約定レート|平均レート/,
  side: /売買|売\/買|建区分|^区分$/,
  kind: /口座|預り区分|取引区分|種別|信用区分/,
  date: /建日|新規約定日|取得日|約定日/,
};
const findCol = (header, re, not = -1) => header.findIndex((c, i) => i !== not && re.test(String(c).trim()));

function modeOf(code, name, isFx) {
  const n = String(name).normalize('NFKC').toUpperCase();
  if (isFx || /[A-Z]{3}\s*\/\s*[A-Z]{3}/.test(n) || /^[A-Z]{6}$/.test(n)) return 'fx';
  if (/^\d{3}[0-9A-Z]$/.test(code)) return 'stock';
  if (/^[A-Z][A-Z.\-]{0,6}$/.test(code)) return 'us';
  return null;
}

const FX_JA = { 米ドル: 'USD', ドル: 'USD', ユーロ: 'EUR', ポンド: 'GBP', 豪ドル: 'AUD', NZドル: 'NZD', カナダドル: 'CAD', スイスフラン: 'CHF', 南アフリカランド: 'ZAR', ランド: 'ZAR', メキシコペソ: 'MXN', ペソ: 'MXN', トルコリラ: 'TRY', 円: 'JPY' };
function fxCode(name) {
  const n = String(name).normalize('NFKC').toUpperCase();
  const m = n.match(/([A-Z]{3})\s*\/?\s*([A-Z]{3})/);
  if (m) return `${m[1]}${m[2]}`;
  const parts = String(name).normalize('NFKC').split(/[\/／]/).map((x) => x.trim());
  if (parts.length === 2 && FX_JA[parts[0]] && FX_JA[parts[1]]) return `${FX_JA[parts[0]]}${FX_JA[parts[1]]}`;
  return null;
}

/** text：CSVの中身 → { stock: [...], us: [...], fx: [...] } */
export function parseHoldingsCsv(text, { lotSize = 10000 } = {}) {
  const rows = parseCsv(text);
  const out = { stock: [], us: [], fx: [] };
  for (let i = 0; i < rows.length; i++) {
    const h = rows[i].map((c) => String(c || '').trim());
    const qi = findCol(h, COL.qty), pi = findCol(h, COL.price);
    const ci = findCol(h, COL.code);
    let ni = findCol(h, /銘柄名|^銘柄$|銘柄（|通貨ペア/);
    if (ni < 0) ni = findCol(h, /^銘柄/, ci);
    if (qi < 0 || pi < 0 || (ni < 0 && ci < 0)) continue;
    // 見出しの行が見つかった：その下を、空の行か次の見出しまで読む
    const si = findCol(h, COL.side), ki = findCol(h, COL.kind), di = findCol(h, COL.date);
    // 「信用区分」「建玉」の列がある表は、信用の建玉の一覧（楽天証券の「信用建玉一覧」など）
    const mi = findCol(h, /信用区分|弁済期限/);
    const isMarginTable = mi >= 0 || h.some((c) => /建玉数量|建単価/.test(c));
    const isFx = h.some((c) => /通貨ペア/.test(c));
    const isLot = /Lot|ロット/i.test(h[qi]);
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j];
      if (!r || r.every((c) => !String(c || '').trim())) break;
      if (findCol(r.map((c) => String(c || '').trim()), COL.qty) >= 0 && findCol(r.map((c) => String(c || '').trim()), COL.price) >= 0) break;
      const name = String(r[ni >= 0 ? ni : ci] || '').trim();
      let code = String(r[ci >= 0 ? ci : ni] || '').normalize('NFKC').trim().toUpperCase().replace(/\.T$/, '');
      if (/合計|小計/.test(name)) continue;
      let qty = toNumber(r[qi]), price = toNumber(r[pi]);
      if (!(qty > 0) || !(price > 0)) continue;
      const mode = modeOf(code, name, isFx);
      if (!mode) continue;
      if (mode === 'fx') { code = fxCode(name) || fxCode(code); if (!code) continue; if (isLot) qty *= lotSize; }
      const sideText = si >= 0 ? String(r[si] || '') : '';
      const kindText = ki >= 0 ? String(r[ki] || '') : '';
      const side = /売/.test(sideText) || /売建|信用売|空売/.test(kindText) ? -1 : 1;
      const acct = mode === 'fx' ? 'cash' : (isMarginTable || /信用|制度|買建|売建/.test(kindText + sideText) || side < 0 ? 'margin' : 'cash');
      const d = di >= 0 ? parseDate(r[di]) : null;
      out[mode].push({ code, name: mode === 'fx' ? `${code.slice(0, 3)}/${code.slice(3)}` : name.replace(/^\d{3}[0-9A-Z]\s*/, '') || code, side, price, qty, acct, date: d ? d.toISOString().slice(0, 10) : '' });
    }
  }
  // 同じ銘柄・向き・口座は、平均の値段と合計の数量にまとめる
  for (const m of Object.keys(out)) {
    const map = new Map();
    for (const x of out[m]) {
      const k = `${x.code}|${x.side}|${x.acct}`;
      const y = map.get(k);
      if (!y) { map.set(k, { ...x }); continue; }
      const q = y.qty + x.qty;
      y.price = Math.round(((y.price * y.qty + x.price * x.qty) / q) * 10000) / 10000;
      y.qty = q;
      if (x.date && (!y.date || x.date < y.date)) y.date = x.date;
    }
    out[m] = [...map.values()];
  }
  return out;
}
