// あなたの予算に合わせて「どれだけ買うか」「損切りはどこか」を計算する
// ・1回の取引で減ってもいい額 ＝ 予算 × リスク（%）
// ・1銘柄に使うお金の上限 ＝ 予算 ÷ 同時に持つ数
// ・日本株は100株単位、米国株は1株単位、為替は1,000通貨単位（証拠金はレバレッジ25倍で計算）

export const FX_LEVERAGE = 25;

// ---------------- 取引のしかた ----------------
// 日本株・米国株は「現物」か「信用」か（信用なら、使えるお金の約3.3倍・米国株は約2倍まで買える）
// 為替は「1回に何ロット取引するか」（空欄＝おまかせ：損切りの幅から量を計算）。証拠金は国内の決まりで25倍
export const LEV_LIMIT = { stock: 3.3, us: 2, fx: 25 };
// ロスカット（強制決済）になる目安：口座のお金が、取引している金額のこの割合を下回ると強制決済
// 日本株の信用は保証金維持率20%、米国株の信用は25%、為替（国内FX）は証拠金維持率100%（＝取引金額の4%）
export const MAINT = { stock: 0.2, us: 0.25, fx: 1 / FX_LEVERAGE };
export function levFor(profile, mode) {
  if (mode === 'fx') return FX_LEVERAGE;
  const v = Number(profile?.[mode === 'us' ? 'levUs' : 'levStock']);
  return v > 1 ? LEV_LIMIT[mode] || 1 : 1;
}
// sizePosition に渡す「取引のしかた」
export function sizeOpts(profile, mode) {
  const o = { leverage: levFor(profile, mode) };
  if (mode === 'fx' && Number(profile?.fxLots) > 0) { o.fxLots = Number(profile.fxLots); o.fxLotSize = Number(profile.fxLotSize) || 10000; }
  return o;
}
// 日本株：'cash'（現物だけ）・'margin'（信用だけ）・'both'（予算を現物と信用に分ける）。米国株は現物か信用か
export function acctOf(profile, mode) {
  if (mode === 'fx') return 'fx';
  if (mode === 'us') return Number(profile?.levUs) > 1 ? 'margin' : 'cash';
  const a = profile?.stockAcct;
  return a === 'cash' || a === 'margin' || a === 'both' ? a : Number(profile?.levStock) > 1 ? 'margin' : 'cash';
}
// 予算のうち、現物に使うお金と信用（保証金）に使うお金
export function splitBudget(profile, mode, budget) {
  const a = acctOf(profile, mode);
  if (a === 'cash' || a === 'fx') return { cash: budget, margin: 0 };
  if (a === 'margin') return { cash: 0, margin: budget };
  const m = Number(profile?.stockMarginBudget);
  const margin = Math.min(budget, m > 0 ? m : budget / 2);
  return { cash: budget - margin, margin };
}
// どちら向きの売買をするか：'both'・'long'（買いだけ）・'short'（売りだけ）
export function sidesFor(profile, mode) {
  if (mode === 'fx') return ['both', 'long', 'short'].includes(profile?.fxSides) ? profile.fxSides : 'both';
  if (mode === 'stock' && acctOf(profile, mode) !== 'cash' && profile?.stockShort) return 'both';
  return 'long';
}
export const SIDES_TEXT = { both: '買いも売りも', long: '買いだけ', short: '売りだけ' };
// 信用の金利・貸株料（1年あたりの目安。楽天証券の制度信用くらい）
export const CARRY = { long: 0.028, short: 0.011 };

// あなたの設定で「どの口座で・どれだけ」入るか（日本株で両方のときは、まず現物、足りなければ信用）
export function sizeFor(profile, mode, side, args) {
  if (mode === 'fx') return sizePosition({ ...args, mode, ...sizeOpts(profile, mode) });
  const acct = acctOf(profile, mode);
  const { cash, margin } = splitBudget(profile, mode, args.budget);
  const tryAcct = (k) => {
    const b = k === 'margin' ? margin : cash;
    if (!(b > 0)) return null;
    const z = sizePosition({ ...args, mode, leverage: k === 'margin' ? LEV_LIMIT[mode] : 1, capBudget: b });
    return z && { ...z, acct: k, acctText: k === 'margin' ? '信用' : '現物' };
  };
  if (side < 0) {
    if (mode !== 'stock' || acct === 'cash') return { qty: 0, why: '空売りは信用でしかできません（設定で信用にすると使えます）' };
    return tryAcct('margin');
  }
  if (acct === 'margin') return tryAcct('margin');
  const z = tryAcct('cash');
  if (acct === 'both' && !(z?.qty > 0)) { const m = tryAcct('margin'); if (m?.qty > 0) return m; }
  return z;
}
// 「現物で買う：100株」「信用で空売り：100株」「2ロット（20,000通貨）買う」のような書き方
export function orderText(side, s) {
  const amount = s.lots ? `${s.lots}ロット（${s.qty.toLocaleString()}${s.unitLabel}）` : `${s.qty.toLocaleString()}${s.unitLabel}`;
  if (!s.acct) return `${side > 0 ? '買う' : '売る'}：${amount}`;
  return `${s.acctText}で${side > 0 ? '買う' : '空売り'}：${amount}`;
}
export const kindText = (profile, mode) => {
  if (mode === 'fx') return `${Number(profile?.fxLots) > 0 ? `毎回${profile.fxLots}ロット（1ロット＝${(Number(profile.fxLotSize) || 10000).toLocaleString()}通貨）` : 'ロット数はおまかせ'}・${SIDES_TEXT[sidesFor(profile, mode)]}`;
  const a = acctOf(profile, mode);
  const short = mode === 'stock' && a !== 'cash' ? (profile?.stockShort ? '・空売りもする' : '・空売りはしない') : '';
  return (a === 'both' ? '現物と信用（予算を分ける）' : a === 'margin' ? '信用' : '現物') + short;
};
const CCY = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'ZAR', 'MXN', 'TRY', 'CNH', 'HKD', 'SGD', 'NOK', 'SEK'];

// 為替：値段の単位（決済通貨）が1動いたら何円か。例：EURUSD → USDJPY の値段
export function quoteToJpy(symbol, prices) {
  const code = symbol.replace(/=X$/, '');
  const quote = code.slice(3, 6);
  if (quote === 'JPY') return 1;
  const direct = prices[`${quote}JPY=X`];
  if (direct) return direct;
  const inv = prices[`JPY${quote}=X`];
  return inv ? 1 / inv : null;
}

/**
 * @param {object} p { mode, symbol, price, stop, side, budget, riskPct, maxPos, prices, usdjpy }
 */
export function sizePosition({ mode, symbol, price, stop, budget, riskPct, maxPos, prices = {}, usdjpy = null, leverage = null, fxLots = 0, fxLotSize = 10000, capBudget = null }) {
  const riskYen = budget * riskPct / 100;
  // 1銘柄に使えるお金。レバレッジをかけると、その倍の金額まで取引できる
  const lev = leverage ?? (mode === 'fx' ? FX_LEVERAGE : 1);
  const cap = ((capBudget ?? budget) / maxPos) * lev;
  const dist = Math.abs(price - stop);
  if (!(price > 0) || !(dist > 0)) return null;
  let unit, unitLabel, costPerUnit, lossPerUnit, kindLabel;
  if (mode === 'stock') {
    unit = 100; unitLabel = '株'; kindLabel = lev > 1 ? '必要な保証金（信用）' : '必要なお金';
    costPerUnit = price * 100; lossPerUnit = dist * 100;
  } else if (mode === 'us') {
    if (!usdjpy) return null;
    unit = 1; unitLabel = '株'; kindLabel = lev > 1 ? '必要な保証金（信用）' : '必要なお金';
    costPerUnit = price * usdjpy; lossPerUnit = dist * usdjpy;
  } else {
    const q = quoteToJpy(symbol, prices);
    if (!q) return null;
    unit = 1000; unitLabel = '通貨'; kindLabel = '必要な証拠金';
    costPerUnit = price * 1000 * q; lossPerUnit = dist * 1000 * q;
  }
  // 為替でロット数を決めているとき：その量で取引し、証拠金が足りるか・損切りでいくら減るかを出す
  if (mode === 'fx' && fxLots > 0) {
    const qty = Math.round(fxLots * fxLotSize);
    const k = qty / unit;
    const notional = k * costPerUnit, maxLoss = k * lossPerUnit, cost = notional / FX_LEVERAGE;
    const res = { unit, unitLabel, kindLabel, costPerUnit, lossPerUnit, riskYen, cap, lev: FX_LEVERAGE, lots: fxLots, effLev: budget ? notional / budget : null };
    if (cost > budget / maxPos) return { ...res, qty: 0, why: `${fxLots}ロットだと証拠金が約${Math.round(cost).toLocaleString()}円必要（1銘柄に使える${Math.round(budget / maxPos).toLocaleString()}円を超える）` };
    return { ...res, qty, cost, notional, maxLoss, perPrice: maxLoss / dist, over: maxLoss > riskYen };
  }
  const byRisk = Math.floor(riskYen / lossPerUnit);
  const byCash = Math.floor(cap / costPerUnit);
  const n = Math.min(byRisk, byCash);
  // 実際に必要なお金：現物は取引する金額そのもの、信用・為替は取引する金額 ÷ レバレッジ（為替は国内の決まりで25倍で計算）
  const need = (x) => (mode === 'fx' ? x / FX_LEVERAGE : x / lev);
  const res = { unit, unitLabel, kindLabel, costPerUnit, lossPerUnit, riskYen, cap, lev };
  if (n < 1) {
    return { ...res, qty: 0, why: byCash < 1 ? `最低${unit.toLocaleString()}${unitLabel}で${Math.round(need(costPerUnit)).toLocaleString()}円必要（1銘柄に使える${lev > 1 ? (mode === 'fx' ? '証拠金の範囲' : '保証金の範囲') : `${Math.round(cap).toLocaleString()}円`}を超える）` : `損切りまでの幅が大きく、最低${unit.toLocaleString()}${unitLabel}でも${Math.round(lossPerUnit).toLocaleString()}円減る可能性がある（1回で減ってもいい${Math.round(riskYen).toLocaleString()}円を超える）` };
  }
  return { ...res, qty: n * unit, cost: need(n * costPerUnit), notional: n * costPerUnit, maxLoss: n * lossPerUnit, perPrice: (n * lossPerUnit) / dist };
}

/**
 * 過去1年の取引を、あなたの予算・ルールでやり直したらどうなったか
 * trades: { entryDate, exitDate, ret, stopPct, odds? }
 */
export function replayWithBudget(trades, { budget, riskPct, maxPos, minOdds = 0, leverage = 0, maint = 0, notionalOf = null, capLev = 1, carry = null }) {
  // leverage を入れると「1銘柄に 予算÷同時に持つ数 × レバレッジ の金額で入る」計算にする（損切りの幅で量を減らさない）
  const list = trades.filter((t) => !minOdds || (t.odds && t.odds.p >= minOdds)).slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const open = [];
  let equity = 0, peak = 0, maxDD = 0, taken = 0, wins = 0, skipped = 0, losscuts = 0, broke = false, longYen = 0, shortYen = 0, longN = 0, shortN = 0;
  const settle = (upTo) => {
    open.sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    while (open.length && (upTo == null || open[0].exitDate <= upTo)) {
      const x = open.shift();
      equity += x.yen;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak - equity);
      if (budget + equity <= 0) broke = true;
    }
  };
  for (const t of list) {
    settle(t.entryDate);
    if (broke) break;
    if (open.length >= maxPos) { skipped++; continue; }
    const alloc = budget / maxPos;
    let yen;
    if (leverage || notionalOf) {
      // notionalOf があれば、その取引の金額（為替で毎回同じロット数など）
      const notional = notionalOf ? notionalOf(t) : alloc * leverage;
      // 証拠金（保証金）が足りなくて、そもそも入れない取引は飛ばす
      if (!(notional > 0) || notional * maint >= alloc) { skipped++; continue; }
      // 持っている間に一番不利だったとき、その銘柄に分けたお金が「維持率」を割ったらロスカット
      const limit = -alloc + notional * maint; // これより損が大きくなると強制決済（マイナスの数）
      if (t.mae != null && notional * t.mae <= limit) { yen = limit; losscuts++; } else yen = t.ret * notional;
      if (carry && t.exitTime && t.entryTime) yen -= notional * (t.side < 0 ? carry.short : carry.long) * Math.max(1, (t.exitTime - t.entryTime) / 86400) / 365;
    } else {
      // capLev：信用・為替なら、1銘柄に使えるお金のその倍まで（量はふだん損切りの幅で決まる）
      const size = Math.min(alloc * capLev, t.stopPct > 0 ? (budget * riskPct / 100) / t.stopPct : alloc);
      yen = t.ret * size;
      // 信用の金利・貸株料（持っていた日数分）
      if (carry && t.exitTime && t.entryTime) yen -= size * (t.side < 0 ? carry.short : carry.long) * Math.max(1, (t.exitTime - t.entryTime) / 86400) / 365;
    }
    open.push({ ...t, yen });
    taken++;
    if (yen > 0) wins++;
    if (t.side < 0) { shortYen += yen; shortN++; } else { longYen += yen; longN++; }
  }
  settle(null);
  return { total: equity, pct: budget ? equity / budget : 0, trades: taken, winRate: taken ? wins / taken : null, maxDD, skipped, losscuts, broke, longYen, shortYen, longN, shortN };
}

// 候補の一覧（日本株）：値段だけから「現物なら・信用なら・空売りなら」をひとことで
export function lotNote(profile, side, price, bestKey = null) {
  const budget = Number(profile?.budget) || 0;
  if (!budget || !(price > 0)) return '';
  const per = budget / (Number(profile?.maxPos) || 3);
  const lot = price * 100;
  const y = (v) => `${Math.round(v).toLocaleString()}円`;
  const best = bestKey ? WAYS.stock.find((w) => w.key === bestKey) : null;
  if (side < 0) {
    const can = per * LEV_LIMIT.stock >= lot ? `空売りするなら信用で100株（約${y(lot)}分）` : `100株で約${y(lot)}分：空売りでも1銘柄に使えるお金では足りない`;
    return `持っていたら売る候補／${can}${best ? (best.key === 'short' ? '（おすすめのやり方に空売りが入っています）' : '（おすすめのやり方では空売りしません）') : ''}`;
  }
  if (per >= lot) return `現物で買える（100株 約${y(lot)}）`;
  if (per * LEV_LIMIT.stock >= lot) return `現物では足りないが、信用なら買える（100株 約${y(lot)}）${best && best.key === 'cash' ? '・おすすめは現物なので見送りでもOK' : ''}`;
  return `100株 約${y(lot)}：1銘柄に使えるお金では買えない`;
}

// ---------------- やり方を自動で選ぶ ----------------
// 設定で決めるのではなく、全部のやり方で過去1年をやり直して、一番良かったものを使う
export const WAYS = {
  stock: [
    { key: 'cash', label: '現物・買いだけ', sides: 'long' },
    { key: 'margin', label: '信用・買いだけ', sides: 'long' },
    { key: 'short', label: '信用・買い＋空売り', sides: 'both' },
  ],
  us: [
    { key: 'cash', label: '現物・買いだけ', sides: 'long' },
    { key: 'margin', label: '信用・買いだけ', sides: 'long' },
  ],
  fx: [
    { key: 'long', label: '買いだけ', sides: 'long' },
    { key: 'short', label: '売りだけ', sides: 'short' },
    { key: 'both', label: '買いも売りも', sides: 'both' },
  ],
};
export const DEFAULT_WAY = { stock: 'cash', us: 'cash', fx: 'both' };
export const wayOf = (mode, key) => WAYS[mode].find((w) => w.key === key) || WAYS[mode].find((w) => w.key === DEFAULT_WAY[mode]);
export const waySides = (mode) => [...new Set(WAYS[mode].map((w) => w.sides))];

// そのやり方で計算するための設定（あなたの予算・ロット数などはそのまま）
export function wayProfile(pf, mode, key) {
  const w = wayOf(mode, key);
  if (mode === 'fx') return { ...pf, fxSides: w.sides };
  if (mode === 'us') return { ...pf, levUs: w.key === 'cash' ? 1 : LEV_LIMIT.us };
  return { ...pf, stockAcct: w.key === 'cash' ? 'cash' : 'margin', levStock: w.key === 'cash' ? 1 : LEV_LIMIT.stock, stockShort: w.key === 'short' };
}

/**
 * 全部のやり方で比べて、一番いいものを選ぶ
 * tradesBy: { long: [...], short: [...], both: [...] }（向きごとの過去の取引）
 */
export function compareWays(tradesBy, mode, pf, budget, prices = {}) {
  const base = { budget, riskPct: pf.riskPct || 2, maxPos: pf.maxPos || 3, minOdds: 0 };
  const lots = mode === 'fx' && pf.fxLots > 0 ? pf.fxLots : 0;
  const rows = WAYS[mode].filter((w) => tradesBy[w.sides]).map((w) => {
    let opt;
    if (mode === 'fx') {
      const size = pf.fxLotSize || 10000;
      opt = lots ? { ...base, notionalOf: (t) => lots * size * t.entryPrice * (quoteToJpy(t.symbol, prices) || 0), maint: MAINT.fx } : { ...base, capLev: FX_LEVERAGE };
    } else opt = w.key === 'cash' ? { ...base, capLev: 1 } : { ...base, capLev: LEV_LIMIT[mode], carry: CARRY };
    return { ...w, r: replayWithBudget(tradesBy[w.sides], opt) };
  });
  if (!rows.length) return { rows, best: null };
  // おすすめ：途中で資金がなくならず、一番減ったときが予算の35%以内のもの。
  // 簡単なやり方から順に見て、はっきり（予算の2%か1割以上）良いときだけ、手間やリスクの多いやり方を選ぶ
  const ok = rows.filter((x) => !x.r.broke && x.r.maxDD <= budget * 0.35);
  let best = null;
  for (const x of ok) if (!best || x.r.total > best.r.total + Math.max(budget * 0.02, Math.abs(best.r.total) * 0.1)) best = x;
  if (!best) best = rows.slice().sort((a, b) => a.r.maxDD - b.r.maxDD)[0];
  return { rows, best };
}

// 比べた結果の説明（「信用にすると…」「空売りを入れると…」）
export function wayNotes(cmp, mode, budget) {
  const y0 = (v) => `${Math.round(Math.abs(v)).toLocaleString()}円`;
  const yen = (v) => `${v >= 0 ? '+' : '−'}${y0(v)}`;
  const get = (k) => cmp.rows.find((x) => x.key === k)?.r;
  const notes = [];
  if (mode === 'fx') {
    const l = get('long'), s = get('short'), b = get('both');
    if (l && s) notes.push(`買いだけだと${yen(l.total)}、売りだけだと${yen(s.total)}、両方やると${b ? yen(b.total) : '—'}でした。`);
    if (b) notes.push(`「買いも売りも」のうち、買いの分は${yen(b.longYen)}（${b.longN}回）、売りの分は${yen(b.shortYen)}（${b.shortN}回）です。${b.shortYen < 0 && b.longYen > 0 ? '売りが足を引っぱっているので、買いだけの方が良さそうです。' : b.longYen < 0 && b.shortYen > 0 ? '買いが足を引っぱっているので、売りだけの方が良さそうです。' : ''}`);
    return notes;
  }
  const c = get('cash'), m = get('margin'), sh = get('short');
  if (c && m) {
    notes.push(m.total > c.total + budget * 0.02
      ? `信用で買うと、現物より約${y0(m.total - c.total)}多く増えました（金利の目安も差し引き済み）。ただ、一番減ったときも${y0(c.maxDD)}→${y0(m.maxDD)}に大きくなります。`
      : `信用にしても現物とくらべて${m.total > c.total ? 'あまり増えず' : '増えず'}、金利もかかるので、現物だけで十分です。`);
  }
  if (sh && m) {
    notes.push(sh.total > m.total + budget * 0.02 && sh.shortYen > 0
      ? `空売りも入れると、さらに約${y0(sh.total - m.total)}多く増えました（空売りの分だけで${yen(sh.shortYen)}・${sh.shortN}回）。`
      : `空売りを入れても${sh.total < m.total ? `成績は約${y0(m.total - sh.total)}悪くなりました` : 'あまり変わりませんでした'}（空売りの分だけで${yen(sh.shortYen)}・${sh.shortN}回）。空売りはおすすめしません。`);
  }
  if (mode === 'us') notes.push('米国株は空売りなしで計算しています。');
  return notes;
}
