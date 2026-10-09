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
// 予算：現物の予算と、信用・空売りの予算（信用口座の保証金）。信用の予算が空なら、現物と同じお金から使う
export function budgets(pf) {
  const cash = Number(pf?.budget) || 1_000_000;
  const sep = Number(pf?.marginBudget) > 0;
  const margin = sep ? Number(pf.marginBudget) : cash;
  return { cash, margin, sep, total: sep ? cash + margin : cash };
}

// 買うときの口座：'cash'（現物）・'margin'（信用）・'mix'（現物で買える分は現物、足りない分は信用）
export function acctOf(profile, mode) {
  if (mode === 'fx') return 'fx';
  const a = mode === 'us' ? profile?.usAcct : profile?.stockAcct;
  if (a === 'cash' || a === 'margin' || a === 'mix') return a;
  if (a === 'both') return 'mix';
  return Number(mode === 'us' ? profile?.levUs : profile?.levStock) > 1 ? 'margin' : 'cash';
}
// 予算のうち、現物に使うお金と信用（保証金）に使うお金（候補の一覧で使う）
export function splitBudget(profile, mode, budget) {
  const a = acctOf(profile, mode);
  if (a === 'cash' || a === 'fx') return { cash: budget, margin: 0 };
  if (a === 'margin') return { cash: 0, margin: budget };
  return { cash: budget, margin: budget };
}
// どちら向きの売買をするか：'both'・'long'（買いだけ）・'short'（売りだけ）
export function sidesFor(profile, mode) {
  if (mode === 'fx') return ['both', 'long', 'short'].includes(profile?.fxSides) ? profile.fxSides : 'both';
  if (mode === 'us') return 'long';
  if (['both', 'long', 'short'].includes(profile?.stockSides)) return profile.stockSides;
  return profile?.stockShort ? 'both' : 'long';
}
export const SIDES_TEXT = { both: '買いも売りも', long: '買いだけ', short: '売りだけ' };
// 信用の金利・貸株料（1年あたりの目安。楽天証券の制度信用くらい）
export const CARRY = { long: 0.028, short: 0.011 };

// やり方に合わせて「どの口座で・どれだけ」入るか
export function sizeFor(profile, mode, side, args) {
  if (mode === 'fx') { const z = sizePosition({ ...args, mode, ...sizeOpts(profile, mode) }); return z && { ...z, lotSize: Number(profile?.fxLotSize) || 10000 }; }
  const acct = acctOf(profile, mode);
  const L = LEV_LIMIT[mode];
  // args.budget は現物の予算。信用・空売りの予算が別にあれば、そちらを信用の上限に使う（1回で減ってもいい額は合計から）
  const sep = Number(profile?.marginBudget) > 0;
  const mb = sep ? Number(profile.marginBudget) : args.budget;
  const riskBase = sep ? args.budget + mb : args.budget;
  const cashZ = () => { const z = sizePosition({ ...args, mode, budget: riskBase, capBudget: args.budget, leverage: 1 }); return z && { ...z, acct: 'cash', acctText: '現物' }; };
  const marginZ = () => { const z = sizePosition({ ...args, mode, budget: riskBase, capBudget: mb, leverage: L }); return z && { ...z, acct: 'margin', acctText: '信用' }; };
  if (side < 0) {
    if (mode !== 'stock' || !profile?.stockShort) return { qty: 0, why: mode === 'us' ? '米国株は空売りしない計算です' : 'このやり方では空売りしません' };
    return marginZ();
  }
  if (acct === 'margin') return marginZ();
  const c = cashZ();
  if (acct !== 'mix') return c;
  const m = marginZ();
  if (!(m?.qty > 0) || (c?.qty > 0 && m.qty <= c.qty)) return c;
  if (!(c?.qty > 0)) return m;
  // 現物で買える分は現物、足りない分は信用で買い足す
  // 信用の分の保証金は、現物で買った株を担保（代用・評価は8割）にして出す
  const per = m.notional / m.qty;
  const maxExtra = Math.floor((((sep ? mb / (args.maxPos || 3) : 0) + c.notional * 0.8) * L) / per / m.unit) * m.unit;
  const extra = Math.min(m.qty - c.qty, maxExtra);
  if (!(extra > 0)) return c;
  const qty = c.qty + extra;
  return { ...m, acct: 'mix', acctText: '現物＋信用', qty, cashQty: c.qty, marginQty: extra, notional: qty * per, cost: c.cost, maxLoss: (m.maxLoss / m.qty) * qty, perPrice: (m.perPrice / m.qty) * qty,
    kindLabel: '必要なお金（現物の分。信用の分は、買った株を担保にします）' };
}
// 「現物で買う：100株」「信用で空売り：100株」「2ロット（20,000通貨）買う」のような書き方
export function orderText(side, s) {
  const amount = s.lots ? `${s.lots}ロット（${s.qty.toLocaleString()}${s.unitLabel}）` : s.lotSize ? `${Math.round((s.qty / s.lotSize) * 10) / 10}ロット（${s.qty.toLocaleString()}${s.unitLabel}）` : `${s.qty.toLocaleString()}${s.unitLabel}`;
  if (!s.acct) return `${side > 0 ? '買う' : '売る'}：${amount}`;
  if (s.acct === 'mix') return `現物で買う：${s.cashQty.toLocaleString()}${s.unitLabel}＋信用で買う：${s.marginQty.toLocaleString()}${s.unitLabel}（合計${s.qty.toLocaleString()}${s.unitLabel}）`;
  return `${s.acctText}で${side > 0 ? '買う' : '空売り'}：${amount}`;
}
export const kindText = (profile, mode) => {
  if (mode === 'fx') return `${Number(profile?.fxLots) > 0 ? `毎回${profile.fxLots}ロット（1ロット＝${(Number(profile.fxLotSize) || 10000).toLocaleString()}通貨）` : 'ロット数はおまかせ'}・${SIDES_TEXT[sidesFor(profile, mode)]}`;
  const acct = acctOf(profile, mode), sides = sidesFor(profile, mode);
  const w = WAYS[mode].find((x) => x.long === acct && x.sides === sides && !!x.short === (mode === 'stock' && !!profile?.stockShort));
  return w ? w.label : acct === 'cash' ? '現物' : '信用';
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
export function replayWithBudget(trades, { budget, riskPct, maxPos, minOdds = 0, leverage = 0, maint = 0, notionalOf = null, capLev = 1, carry = null, acct = null }) {
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
    } else if (acct) {
      // 株：買いは口座（現物・信用・現物＋信用）ごとの上限まで、空売りは信用。量はふだん損切りの幅で決まる
      const risk = t.stopPct > 0 ? (budget * riskPct / 100) / t.stopPct : alloc;
      const kind = t.side < 0 ? 'margin' : acct.long;
      // 現物の予算・信用の予算から、1銘柄に使える上限（現物＋信用は、買った株も担保に8割で使う）
      const cA = (acct.cash ?? budget) / maxPos, mA = (acct.margin ?? budget) / maxPos;
      const cap = kind === 'cash' ? cA : kind === 'margin' ? mA * acct.L : cA + ((acct.sep ? mA : 0) + cA * 0.8) * acct.L;
      const size = Math.min(cap, risk);
      yen = t.ret * size;
      // 信用の金利・貸株料：信用で入った分だけ（現物＋信用なら、現物で足りない分だけ）
      const onMargin = kind === 'margin' ? size : kind === 'mix' ? Math.max(0, size - cA) : 0;
      if (onMargin && t.exitTime && t.entryTime) yen -= onMargin * (t.side < 0 ? CARRY.short : CARRY.long) * Math.max(1, (t.exitTime - t.entryTime) / 86400) / 365;
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
    return `持っていたら売る候補／${can}${best ? (best.short ? '（おすすめのやり方に空売りが入っています）' : '（おすすめのやり方では空売りしません）') : ''}`;
  }
  if (per >= lot) return `現物で買える（100株 約${y(lot)}）`;
  if (per * LEV_LIMIT.stock >= lot) return `現物では足りないが、信用なら買える（100株 約${y(lot)}）${best && best.long === 'cash' ? '・おすすめは現物だけなので見送りでもOK' : ''}`;
  return `100株 約${y(lot)}：1銘柄に使えるお金では買えない`;
}

// ---------------- やり方を自動で選ぶ ----------------
// 設定で決めるのではなく、全部のやり方（組み合わせ）で過去1年をやり直して、一番良かったものを使う
// 並び順は「簡単・安全な順」。はっきり成績が良いときだけ、後ろのやり方を選ぶ
export const WAYS = {
  stock: [
    { key: 'cash', label: '現物で買うだけ', sides: 'long', long: 'cash' },
    { key: 'mix', label: '現物＋信用で買う', sides: 'long', long: 'mix' },
    { key: 'margin', label: '信用で買うだけ', sides: 'long', long: 'margin' },
    { key: 'cashShort', label: '現物で買う＋信用で空売り', sides: 'both', long: 'cash', short: true },
    { key: 'mixShort', label: '現物＋信用で買う＋空売り', sides: 'both', long: 'mix', short: true },
    { key: 'short', label: '信用で買う＋空売り', sides: 'both', long: 'margin', short: true },
    { key: 'shortOnly', label: '信用で空売りだけ', sides: 'short', long: 'margin', short: true },
  ],
  us: [
    { key: 'cash', label: '現物で買うだけ', sides: 'long', long: 'cash' },
    { key: 'mix', label: '現物＋信用で買う', sides: 'long', long: 'mix' },
    { key: 'margin', label: '信用で買うだけ', sides: 'long', long: 'margin' },
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
  if (mode === 'us') return { ...pf, usAcct: w.long, levUs: w.long === 'cash' ? 1 : LEV_LIMIT.us };
  return { ...pf, stockAcct: w.long, stockShort: !!w.short, stockSides: w.sides, levStock: w.long === 'cash' ? 1 : LEV_LIMIT.stock };
}

// そのやり方で過去をやり直すときの条件
export function replayOpts(mode, w, pf, prices = {}) {
  const b = budgets(pf);
  const base = { budget: mode === 'fx' ? b.cash : b.total, riskPct: pf.riskPct || 2, maxPos: pf.maxPos || 3 };
  if (mode !== 'fx') return { ...base, acct: { long: w.long, L: LEV_LIMIT[mode], cash: b.cash, margin: b.margin, sep: b.sep } };
  base.budget = b.cash;
  const lots = pf.fxLots > 0 ? pf.fxLots : 0, size = pf.fxLotSize || 10000;
  return lots ? { ...base, notionalOf: (t) => lots * size * t.entryPrice * (quoteToJpy(t.symbol, prices) || 0), maint: MAINT.fx } : { ...base, capLev: FX_LEVERAGE };
}

/**
 * 全部のやり方で比べて、一番いいものを選ぶ
 * tradesBy: { long: [...], short: [...], both: [...] }（向きごとの過去の取引）
 */
export function compareWays(tradesBy, mode, pf, budget, prices = {}) {
  // budget：比べるときの基準（予算の合計）。それぞれの口座の予算は pf から読む
  const p = pf.budget ? pf : { ...pf, budget };
  const rows = WAYS[mode].filter((w) => tradesBy[w.sides]).map((w) => ({ ...w, r: replayWithBudget(tradesBy[w.sides], replayOpts(mode, w, p, prices)) }));
  if (!rows.length) return { rows, best: null };
  // おすすめの選び方
  // 1) プラスになったものだけを候補にする（マイナスのやり方は、どんなに減り方が小さくても選ばない）
  // 2) その中で、途中で資金がなくならず、一番減ったときが予算の35%以内のものを優先
  // 3) 簡単なやり方から順に見て、はっきり（予算の2%か1割以上）良いときだけ、手間やリスクの多いやり方を選ぶ
  // 4) どれもマイナスなら「お休みがおすすめ」（やるなら一番損が小さいもの）
  const pick = (list) => {
    let b = null;
    for (const x of list) if (!b || x.r.total > b.r.total + Math.max(budget * 0.02, Math.abs(b.r.total) * 0.1)) b = x;
    return b;
  };
  const plus = rows.filter((x) => x.r.total > 0 && !x.r.broke);
  const safe = plus.filter((x) => x.r.maxDD <= budget * 0.35);
  let best, note = '';
  if (safe.length) best = pick(safe);
  else if (plus.length) {
    // プラスだが減り方が大きいものしかない：増え方÷一番減ったとき が一番いいもの
    best = plus.slice().sort((a, b) => b.r.total / Math.max(1, b.r.maxDD) - a.r.total / Math.max(1, a.r.maxDD))[0];
    note = 'dd';
  } else {
    best = rows.slice().sort((a, b) => b.r.total - a.r.total)[0];
    note = 'rest';
  }
  return { rows, best, note };
}

// 比べた結果の説明（「信用で買うと…」「空売りを入れると…」）
export function wayNotes(cmp, mode, budget) {
  const y0 = (v) => `${Math.round(Math.abs(v)).toLocaleString()}円`;
  const yen = (v) => `${v >= 0 ? '+' : '−'}${y0(v)}`;
  const get = (k) => cmp.rows.find((x) => x.key === k)?.r;
  const thr = budget * 0.02;
  const notes = [];
  if (mode === 'fx') {
    const l = get('long'), s = get('short'), b = get('both');
    if (l && s) notes.push(`買いだけだと${yen(l.total)}、売りだけだと${yen(s.total)}、両方やると${b ? yen(b.total) : '—'}でした。`);
    if (b) notes.push(`「買いも売りも」のうち、買いの分は${yen(b.longYen)}（${b.longN}回）、売りの分は${yen(b.shortYen)}（${b.shortN}回）です。${b.shortYen < 0 && b.longYen > 0 ? '売りが足を引っぱっているので、売りはやめた方が良さそうです。' : b.longYen < 0 && b.shortYen > 0 ? '買いが足を引っぱっているので、買いはやめた方が良さそうです。' : ''}`);
  } else {
    const c = get('cash'), mx = get('mix'), m = get('margin'), cs = get('cashShort'), so = get('shortOnly');
    const marginBest = [mx, m].filter(Boolean).sort((a, b) => b.total - a.total)[0];
    if (c && marginBest) {
      notes.push(marginBest.total > c.total + thr
        ? `信用も使って買うと、現物だけより約${y0(marginBest.total - c.total)}多く増えました（金利の目安も差し引き済み）。ただ、一番減ったときも${y0(c.maxDD)}→${y0(marginBest.maxDD)}に大きくなります。`
        : `信用を使っても現物だけとくらべて${marginBest.total > c.total ? 'あまり増えず' : '増えず'}、金利もかかるので、買うのは現物だけで十分です。`);
    }
    if (c && cs) {
      notes.push(cs.total > c.total + thr && cs.shortYen > 0
        ? `空売りも入れると、さらに約${y0(cs.total - c.total)}多く増えました（空売りの分だけで${yen(cs.shortYen)}・${cs.shortN}回）。空売りもやって良さそうです。`
        : `空売りを入れても${cs.total < c.total ? `成績は約${y0(c.total - cs.total)}悪くなりました` : 'あまり変わりませんでした'}（空売りの分だけで${yen(cs.shortYen)}・${cs.shortN}回）。空売りはやめた方がいいです。`);
    }
    if (so) notes.push(`空売りだけだと${yen(so.total)}（${so.trades}回・勝率${so.winRate == null ? '—' : Math.round(so.winRate * 100) + '%'}）でした。${so.total < 0 ? '空売りだけでやるのはおすすめしません。' : ''}`);
    if (mode === 'us') notes.push('米国株は空売りなしで計算しています。');
  }
  return notes;
}

// ---------------- 為替：pips（どれだけ動いたか）とロット ----------------
// 円の通貨ペアは0.01円＝1pips（1銭）、それ以外は0.0001＝1pips
export const pipOf = (symbol) => (/JPY/i.test(String(symbol).replace(/=X$/, '').slice(3, 6)) ? 0.01 : 0.0001);
export const pipsOf = (symbol, side, from, to) => (side * (to - from)) / pipOf(symbol);
export const pipsText = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}pips`;
// 為替：あなたのロット設定（おまかせなら1ロット）で、その値動きがいくらになるか
export function fxLotYen(pf, symbol, side, from, to, prices = {}) {
  const lots = pf?.fxLots > 0 ? pf.fxLots : 1, size = pf?.fxLotSize || 10000;
  const q = quoteToJpy(symbol, prices);
  if (!q) return null;
  return { lots, size, yen: side * (to - from) * lots * size * q, auto: !(pf?.fxLots > 0) };
}
