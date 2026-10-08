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
    return { ...res, qty: 0, why: byCash < 1 ? `最低${unit.toLocaleString()}${unitLabel}で${Math.round(need(costPerUnit)).toLocaleString()}円必要（1銘柄に使える${lev > 1 ? '保証金の範囲' : `${Math.round(cap).toLocaleString()}円`}を超える）` : `損切りまでの幅が大きく、最低${unit.toLocaleString()}${unitLabel}でも${Math.round(lossPerUnit).toLocaleString()}円減る可能性がある（1回で減ってもいい${Math.round(riskYen).toLocaleString()}円を超える）` };
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

// 候補の一覧（日本株）：値段だけから「あなたの設定で入れるか」をひとことで
export function lotNote(profile, side, price) {
  const budget = Number(profile?.budget) || 0;
  if (!budget || !(price > 0)) return '';
  const maxPos = Number(profile?.maxPos) || 3;
  const { cash, margin } = splitBudget(profile, 'stock', budget);
  const lot = price * 100;
  const y = (v) => `${Math.round(v).toLocaleString()}円`;
  if (side < 0) {
    if (acctOf(profile, 'stock') === 'cash' || !profile?.stockShort) return `持っていたら売る候補（空売りは設定でオフ）`;
    return margin / maxPos * LEV_LIMIT.stock >= lot ? `信用で空売りできる（100株で約${y(lot)}分）` : `100株で約${y(lot)}分：信用に使うお金では足りない`;
  }
  if (cash / maxPos >= lot) return `現物で買える（100株 約${y(lot)}）`;
  if (margin / maxPos * LEV_LIMIT.stock >= lot) return `信用なら買える（100株 約${y(lot)}）`;
  return `100株 約${y(lot)}：1銘柄に使えるお金では買えない`;
}
