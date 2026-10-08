// 取引履歴CSVの読み込みと成績の集計
// iSPEED（楽天証券）・LION FX（ヒロセ通商）など、列名が日本語のCSVを自動で判別する

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

// 列名の候補（上にあるものほど優先）
export const FIELD_HINTS = {
  date: ['決済約定日時', '決済日時', '約定日時', '約定日', '取引日時', '取引日', '日時', '受渡日', '注文日時', 'date', 'time'],
  symbol: ['通貨ペア', '銘柄名', '銘柄', '銘柄コード', 'シンボル', 'symbol'],
  side: ['売買', '売買区分', '取引区分', '売/買', '売買方向', '取引', '区分', 'side', 'type'],
  qty: ['Lot数', '約定数量', '数量', '取引数量', '株数', 'Lot', 'ロット', '枚数', 'quantity'],
  price: ['決済約定値', '決済レート', '売却/決済単価', '約定レート', '約定価格', '約定単価', '約定値', '単価', '価格', 'price'],
  pnl: ['決済損益', '実現損益[円]', '実現損益', '損益合計', '売買損益', '損益金額', '確定損益', '損益', 'profit', 'pnl'],
  swap: ['スワップ', 'スワップ損益', 'swap'],
  fee: ['手数料', '手数料等', 'commission', 'fee'],
};

export const FIELD_LABELS = { date: '日時', symbol: '銘柄・通貨ペア', side: '売買', qty: '数量', price: '価格', pnl: '損益', swap: 'スワップ', fee: '手数料' };

// 先頭の説明行を飛ばして、列名が並んだ行を探す
export function findHeader(rows) {
  let best = 0, bestScore = -1;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const score = Object.values(FIELD_HINTS).filter((hints) => rows[r].some((c) => hints.some((h) => c.toLowerCase().includes(h.toLowerCase())))).length;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

export function guessMapping(header) {
  const map = {};
  const used = new Set();
  const norm = (c) => String(c).normalize('NFKC').toLowerCase().replace(/\s/g, '');
  for (const [field, hints] of Object.entries(FIELD_HINTS)) {
    for (const h of hints) {
      const hh = norm(h);
      // まず列名がぴったり同じもの、なければ含むもの
      let idx = header.findIndex((c, i) => !used.has(i) && norm(c) === hh);
      if (idx < 0) idx = header.findIndex((c, i) => !used.has(i) && norm(c).includes(hh));
      if (idx >= 0) { map[field] = idx; used.add(idx); break; }
    }
  }
  return map;
}

// どの会社のCSVかを見分ける
export function detectFormat(header) {
  const h = header.join('|');
  if (/ポジション番号|pip損益|新規約定値/.test(h)) return { id: 'lion', name: 'LION FX（ヒロセ通商）の決済履歴' };
  if (/実現損益/.test(h)) return { id: 'rakuten', name: '楽天証券の実現損益' };
  return { id: 'generic', name: '取引履歴' };
}

// 損益の列が「合計の損益」（スワップや手数料をすでに含む）かどうか
export function isTotalPnl(headerText) {
  return /決済損益|実現損益|損益合計/.test(String(headerText || ''));
}

export function toNumber(s) {
  if (s == null) return NaN;
  const t = String(s).replace(/[,，円¥\s]/g, '').replace(/[▲△]/g, '-').replace(/^\((.*)\)$/, '-$1').replace(/[＋+]/g, '').replace(/[－−]/g, '-');
  if (t === '' || t === '-') return NaN;
  return Number(t);
}

export function parseDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/(\d{2,4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  // 20260901 や 20260901103000 のような詰めた書き方
  if (!m) {
    const c = t.match(/^(20\d{2})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/);
    if (c) m = [c[0], c[1], c[2], c[3], c[4], c[5], c[6]];
  }
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 100) y += 2000;
  return new Date(y, Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
}

function normSide(s) {
  const t = String(s || '');
  if (/売|sell|short/i.test(t)) return '売';
  if (/買|buy|long/i.test(t)) return '買';
  return '不明';
}

export function rowsToTrades(rows, headerIndex, map) {
  const header = rows[headerIndex] || [];
  // 「決済損益」「実現損益」はスワップ・手数料を含んだ合計なので、足し引きしない
  const total = isTotalPnl(header[map.pnl]);
  // LION FX は新規と決済の値段から、買いで持っていたか売りで持っていたかを判定する
  const entryCol = header.findIndex((c) => /新規約定値|取得価額|取得単価/.test(c));
  // 新規の日時（持ち始めた時刻）と銘柄コードがあれば、詳しい分析に使う
  const openCol = header.findIndex((c, i) => i !== map.date && /新規約定日時|新規約定日|建玉日時|新規日時|建日/.test(c));
  const codeCol = header.findIndex((c, i) => i !== map.symbol && /銘柄コード|ティッカー/.test(c));
  const trades = [];
  for (const r of rows.slice(headerIndex + 1)) {
    if (r.some((c) => /^(総?合計|小計|計)$/.test(String(c).trim()))) continue; // 合計の行は取引ではない
    const date = map.date != null ? parseDate(r[map.date]) : null;
    if (!date) continue;
    const pnl = map.pnl != null ? toNumber(r[map.pnl]) : NaN;
    const swap = map.swap != null ? toNumber(r[map.swap]) : NaN;
    const fee = map.fee != null ? toNumber(r[map.fee]) : NaN;
    const price = map.price != null ? toNumber(r[map.price]) || 0 : 0;
    const entry = entryCol >= 0 ? toNumber(r[entryCol]) : NaN;
    let side = map.side != null ? normSide(r[map.side]) : '不明';
    if (!Number.isNaN(entry) && price && !Number.isNaN(pnl) && pnl !== 0 && price !== entry && /新規約定値/.test(header[entryCol])) {
      side = (price - entry) * pnl > 0 ? '買' : '売';
    }
    // 株：現物か、信用の買いか、空売り（信用の売り）か（楽天証券などの「取引」「区分」の書き方から見分ける）
    const rowText = r.join(' ');
    const kind = /返済買|売建|売埋|信用新規売/.test(rowText) ? 'short' : /信用|返済売|買建|買埋/.test(rowText) ? 'margin' : /現物|特定|NISA|売付/.test(rowText) ? 'cash' : '';
    trades.push({
      kind,
      date: date.toISOString(),
      symbol: map.symbol != null ? String(r[map.symbol] || '').normalize('NFKC') : '',
      side,
      qty: map.qty != null ? toNumber(r[map.qty]) || 0 : 0,
      price,
      entry: Number.isNaN(entry) ? null : entry,
      openDate: openCol >= 0 ? parseDate(r[openCol])?.toISOString() || null : null,
      code: codeCol >= 0 ? String(r[codeCol] || '').normalize('NFKC').trim() : '',
      pnl: Number.isNaN(pnl) ? null : total ? pnl : pnl + (Number.isNaN(swap) ? 0 : swap) - (Number.isNaN(fee) ? 0 : Math.abs(fee)),
    });
  }
  return trades;
}

// ファイルの中身から、同じファイルかどうかを見分ける印を作る
export function fileId(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function decodeFile(buffer) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  // 文字化け（�）が多ければ Shift_JIS とみなす
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > 3) return new TextDecoder('shift_jis').decode(buffer);
  return utf8.replace(/^﻿/, '');
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function group(list, keyFn) {
  const m = new Map();
  for (const t of list) {
    const k = keyFn(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m.entries()].map(([key, ts]) => {
    const wins = ts.filter((t) => t.pnl > 0).length;
    return { key, count: ts.length, winRate: wins / ts.length, pnl: ts.reduce((s, t) => s + t.pnl, 0) };
  });
}

export function computeStats(allTrades) {
  const closed = allTrades.filter((t) => t.pnl != null && t.pnl !== 0)
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  if (!closed.length) return null;
  const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  let equity = 0, peak = 0, maxDD = 0, streak = 0, maxLossStreak = 0;
  const curve = [];
  for (const t of closed) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    streak = t.pnl < 0 ? streak + 1 : 0;
    maxLossStreak = Math.max(maxLossStreak, streak);
    curve.push({ date: t.date, equity });
  }
  const dated = closed.filter((t) => t.date);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  return {
    count: closed.length,
    winRate: wins.length / closed.length,
    totalPnl: equity,
    avgWin,
    avgLoss,
    payoff: avgLoss ? avgWin / avgLoss : null,
    profitFactor: grossLoss ? grossWin / grossLoss : null,
    maxDrawdown: maxDD,
    maxLossStreak,
    bestTrade: Math.max(...closed.map((t) => t.pnl)),
    worstTrade: Math.min(...closed.map((t) => t.pnl)),
    from: dated[0]?.date || null,
    to: dated[dated.length - 1]?.date || null,
    curve,
    bySymbol: group(closed, (t) => t.symbol || '不明').sort((a, b) => b.count - a.count),
    bySide: group(closed, (t) => t.side),
    byWeekday: group(dated, (t) => WEEKDAYS[new Date(t.date).getDay()]).sort((a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key)),
    byHour: group(dated, (t) => new Date(t.date).getHours()).sort((a, b) => a.key - b.key),
  };
}

// 数字から分かる癖を、ルールベースで文章にする
export function insights(s) {
  const out = [];
  const yen = (v) => `${Math.round(v).toLocaleString()}円`;
  if (s.payoff != null && s.payoff < 1 && s.winRate > 0.5) out.push(`勝率は${Math.round(s.winRate * 100)}%と高いのに、平均損失（${yen(s.avgLoss)}）が平均利益（${yen(s.avgWin)}）より大きい「負けるときは大きく、勝つときは小さい」傾向（損大利小）があります。損切りを早めに、利確を少し伸ばすと改善しやすいです。`);
  if (s.payoff != null && s.payoff >= 1.5 && s.winRate < 0.4) out.push('利益は大きく伸ばせていますが勝率が低めです。エントリーの条件を絞ると成績が安定しやすいです。');
  if (s.profitFactor != null) out.push(s.profitFactor >= 1.3 ? `プロフィットファクター${s.profitFactor.toFixed(2)}で、トータルではしっかり勝てています（利益の合計が損失の合計の${s.profitFactor.toFixed(2)}倍）。` : s.profitFactor >= 1 ? `プロフィットファクター${s.profitFactor.toFixed(2)}で、トントンに近い状態です。` : `プロフィットファクター${s.profitFactor.toFixed(2)}で、トータルでは負け越しています。`);
  if (s.maxLossStreak >= 5) out.push(`最大${s.maxLossStreak}連敗があります。連敗中に取引量を増やしていないか見直しましょう（3連敗したらその日は休む、などのルールが有効です）。`);
  if (Math.abs(s.worstTrade) > s.avgLoss * 4 && s.avgLoss > 0) out.push(`1回の最大損失（${yen(s.worstTrade)}）が平均損失の4倍以上です。損切り注文を必ず入れる習慣をつけると大きな負けを防げます。`);
  const goodSym = s.bySymbol.filter((g) => g.count >= 5).sort((a, b) => b.pnl - a.pnl);
  if (goodSym.length >= 2) {
    out.push(`得意: ${goodSym[0].key}（${yen(goodSym[0].pnl)}）／苦手: ${goodSym[goodSym.length - 1].key}（${yen(goodSym[goodSym.length - 1].pnl)}）`);
  }
  const hours = s.byHour.filter((g) => g.count >= 3).sort((a, b) => a.pnl - b.pnl);
  if (hours.length >= 3 && hours[0].pnl < 0) out.push(`${hours[0].key}時台の取引は負けやすい傾向です（${yen(hours[0].pnl)}）。`);
  return out;
}
