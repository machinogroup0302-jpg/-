// 自分で持っている株・通貨について「どうした方がいいか」を出す
// （サイトの「持っている株」と、メールのお知らせの両方で使う）
import { atr, rsi, technicalSummary } from './indicators.js';
import { supportResistance } from './levels.js';
import { quoteToJpy } from './plan.js';

const num = (v) => Number(Number(v).toPrecision(6)).toLocaleString('ja-JP', { maximumFractionDigits: 4 });
const yen = (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString()}円`;
const short = (t) => String(t).replace(/（[^）]*）/g, '');

export const VERDICTS = {
  cut: { label: '損切りを', cls: 'danger', icon: '🛑' },
  exit: { label: '決済を考える', cls: 'warn', icon: '⚠️' },
  trim: { label: '一部を利益確定', cls: 'ok', icon: '💰' },
  hold: { label: '持ち続けてOK', cls: 'ok', icon: '👍' },
};

// 値段が1動くと何円か（日本株は1、米国株はドル円、為替は決済通貨の円の値段）
export function yenPerUnit(mode, symbol, { prices = {}, usdjpy = null } = {}) {
  if (mode === 'stock') return 1;
  if (mode === 'us') return usdjpy;
  return quoteToJpy(symbol, prices);
}

/**
 * h: { symbol, name, side(1/-1), price(入った値段), qty(数量), date?(YYYY-MM-DD) }
 * candles: 日足
 */
export function adviseHolding(h, candles, { mode, prices = {}, usdjpy = null, profile = null, earningsDate = null, today = null } = {}) {
  if (!candles || candles.length < 60) return null;
  const side = h.side < 0 ? -1 : 1;
  const long = side > 0;
  const last = candles[candles.length - 1];
  const now = last.close;
  const a = atr(candles).filter((v) => v != null).pop() || now * 0.01;
  const r = rsi(candles.map((c) => c.close)).filter((v) => v != null).pop();
  const ts = technicalSummary(candles.slice(-200));
  const ypu = yenPerUnit(mode, h.symbol, { prices, usdjpy });
  const qty = Number(h.qty) || 0;
  const entry = Number(h.price);
  const plPct = side * (now / entry - 1);
  const plYen = ypu != null && qty ? side * (now - entry) * qty * ypu : null;

  // 持ち始めてからの一番良かった値段（日付がなければ最近20日）
  const since = h.date ? candles.filter((c) => new Date(c.time * 1000).toISOString().slice(0, 10) >= h.date) : candles.slice(-20);
  const span = since.length ? since : candles.slice(-20);
  const peak = long ? Math.max(...span.map((c) => c.high)) : Math.min(...span.map((c) => c.low));
  // 損切りの線：入った値段から2ATR。値段が有利に動いたら、一番良かった値段から2.5ATRまで引き上げる
  const base = entry - side * 2 * a;
  const trail = peak - side * 2.5 * a;
  const stop = long ? Math.max(base, trail) : Math.min(base, trail);
  const protects = long ? stop > entry : stop < entry;

  // 目標：上（下）にある一番近い「壁」か、入った値段から3ATR
  const lv = supportResistance(candles);
  const walls = lv.filter((l) => (long ? l.kind === 'resistance' && l.price > now : l.kind === 'support' && l.price < now))
    .sort((x, y) => (long ? x.price - y.price : y.price - x.price));
  const target = walls[0]?.price ?? (now + side * 3 * a);

  const against = long ? /売り/.test(ts.label) : /買い/.test(ts.label);
  const hot = long ? r > 75 : r < 25;
  const nearTarget = Math.abs(target - now) < a * 0.5;
  const broken = long ? now <= stop : now >= stop;

  let key;
  if (broken) key = protects ? 'exit' : 'cut';
  else if (against) key = 'exit';
  else if (hot || nearTarget) key = 'trim';
  else key = 'hold';

  const reasons = [];
  if (broken) reasons.push(protects ? `値段が利益を守る線（${num(stop)}）を下回った。利益があるうちに決済を` : `値段が損切りの線（${num(stop)}）を割っている。これ以上損を広げないために決済を`);
  if (against) reasons.push(`テクニカル判定が「${ts.label}」に変わった（${long ? '下がる' : '上がる'}サインが多い）`);
  if (hot) reasons.push(`買われすぎ・売られすぎ度（RSI）が${Math.round(r)}。${long ? '上がりすぎで、いったん下がりやすい' : '下がりすぎで、いったん戻りやすい'}`);
  if (nearTarget && !broken) reasons.push(`目標の値段（${num(target)}）のすぐ近く。${walls[0] ? `${walls[0].label}（${walls[0].strength}）で止まりやすい` : ''}`);
  if (key === 'hold') {
    const agree = ts.rows.filter((x) => x.signal === (long ? '買い' : '売り'));
    reasons.push(`テクニカル判定は「${ts.label}」で、流れはまだ${long ? '上向き' : '下向き'}`);
    agree.slice(0, 2).forEach((x) => reasons.push(short(x.detail)));
  }
  const toStop = side * (stop / now - 1);
  const stopYen = ypu != null && qty ? side * (stop - entry) * qty * ypu : null;
  if (!broken) reasons.push(`${protects ? '利益を守る線' : '損切りの線'}は ${num(stop)}（今から${(toStop * 100).toFixed(1)}%${stopYen != null ? `・そこで決済すると${yen(stopYen)}` : ''}）。逆指値の注文を入れておきましょう`);
  if (earningsDate && today) {
    const days = Math.round((Date.parse(earningsDate) - Date.parse(today)) / 86400000);
    if (days >= 0 && days <= 14) reasons.push(`決算発表まであと${days}日（${earningsDate.slice(5).replace('-', '/')}）。発表の翌日は大きく動くことがあるので、持ち越すか考えましょう`);
  }
  if (profile?.budget && ypu != null && qty) {
    const value = (mode === 'fx' ? now * qty * ypu / 25 : now * qty * ypu);
    const share = value / profile.budget;
    if (share > 0.5) reasons.push(`この銘柄に予算の${Math.round(share * 100)}%を使っています。1つに集中しすぎると、外れたときの損が大きくなります`);
    const risk = stopYen != null && stopYen < 0 ? -stopYen / profile.budget : 0;
    if (risk > (profile.riskPct || 2) / 100 * 1.5) reasons.push(`損切りの線で決済すると予算の${(risk * 100).toFixed(1)}%が減ります（あなたのルールは${profile.riskPct || 2}%）。量を減らすことも考えましょう`);
  }
  return { key, verdict: VERDICTS[key], now, plPct, plYen, stop, protects, target, wall: walls[0] || null, rsi: r, tech: ts.label, reasons, atr: a, date: new Date(last.time * 1000).toISOString().slice(0, 10) };
}

// ---------------- いつ決済すると一番いいか（損が一番小さいか） ----------------
// 過去の値動きのくせ（日ごとの上がり下がり）を何千通りもつなぎ合わせて、これから先の値動きを試す。
// 「すぐ決済」と「最大○日待つ（最終ラインを割ったら決済・戻りの目標に届いたら決済）」を比べる。
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulatePaths(closes, { horizon = 10, paths = 1500, seed = 7, lookback = 250, block = 5 } = {}) {
  const c = closes.slice(-lookback - 1);
  const rets = [];
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  if (rets.length < 30) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const recent = rets.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const drift = mean * 0.5 + recent * 0.2;
  const centered = rets.map((r) => r - mean + drift);
  const rand = rng(seed);
  const last = c[c.length - 1];
  const out = [];
  for (let p = 0; p < paths; p++) {
    const path = new Float64Array(horizon);
    let lp = 0, h = 0;
    while (h < horizon) {
      const st = Math.floor(rand() * (centered.length - block));
      for (let b = 0; b < block && h < horizon; b++, h++) { lp += centered[st + b]; path[h] = last * Math.exp(lp); }
    }
    out.push(path);
  }
  return out;
}

const seedOf = (s) => [...String(s)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);

/**
 * h: 持っている株、adv: adviseHolding の結果
 * 戻り値：{ line, escape, rows:[{ d, mean, p10, pLine, pEscape }], now, best, wait, text }
 */
export function exitTiming(h, candles, adv, { mode, prices = {}, usdjpy = null, horizon = 10 } = {}) {
  const ypu = yenPerUnit(mode, h.symbol, { prices, usdjpy });
  const qty = Number(h.qty) || 0;
  if (!adv || ypu == null || !qty) return null;
  const side = h.side < 0 ? -1 : 1;
  const long = side > 0;
  const entry = Number(h.price);
  const now = adv.now, a = adv.atr;
  const pl = (p) => side * (p - entry) * qty * ypu;
  // 最終ライン：まだ割っていなければ今の損切りの線。割っていたら、すぐ下の「支え」か1.5ATR下
  const lv = supportResistance(candles);
  let line = adv.stop;
  if (long ? now <= adv.stop : now >= adv.stop) {
    const sup = lv.filter((l) => (long ? l.kind === 'support' && l.price < now : l.kind === 'resistance' && l.price > now))
      .sort((x, y) => (long ? y.price - x.price : x.price - y.price))[0];
    line = sup && Math.abs(now - sup.price) <= 2.5 * a ? sup.price : now - side * 1.5 * a;
  }
  // 戻りの目標：損をしているなら「買った値段（建値）」かその手前の壁、もうけているなら利益確定の目標
  const losing = pl(now) < 0;
  const escape = losing
    ? (long ? Math.min(entry, adv.wall?.price ?? entry) : Math.max(entry, adv.wall?.price ?? entry))
    : adv.target;
  const sims = simulatePaths(candles.map((c) => c.close), { horizon, seed: seedOf(h.symbol + h.price) });
  if (!sims) return null;
  const days = [1, 2, 3, 5, 7, 10].filter((d) => d <= horizon);
  const rows = days.map((d) => {
    const res = [];
    let hitLine = 0, hitEsc = 0;
    for (const path of sims) {
      let v = null;
      for (let k = 0; k < d; k++) {
        const p = path[k];
        if (long ? p <= line : p >= line) { v = pl(p); hitLine++; break; }
        if (long ? p >= escape : p <= escape) { v = pl(p); hitEsc++; break; }
      }
      res.push(v ?? pl(path[d - 1]));
    }
    res.sort((x, y) => x - y);
    const mean = res.reduce((s, x) => s + x, 0) / res.length;
    return { d, mean, p10: res[Math.floor(res.length * 0.1)], pLine: hitLine / sims.length, pEscape: hitEsc / sims.length };
  });
  const nowPl = pl(now);
  const best = rows.reduce((b, r) => (r.mean > b.mean ? r : b), rows[0]);
  // 1回の平均の値動き（ATR）の2割より得なら「待つ価値あり」とする
  const worth = best.mean - nowPl > Math.abs(a * qty * ypu) * 0.2;
  const fmt = (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString()}円`;
  let text;
  if (worth) {
    text = `最大${best.d}日まで待つのが、平均で一番${losing ? '損が小さい' : 'もうけが大きい'}見込みです（今すぐ決済 ${fmt(nowPl)} → 平均 ${fmt(best.mean)}）。`
      + `ただし ${num(line)} を${long ? '下回ったら' : '上回ったら'}すぐ決済、${num(escape)} まで${losing ? '戻ったら' : '届いたら'}決済してください。`
      + `${best.d}日以内に ${num(escape)} に届く確率は約${Math.round(best.pEscape * 100)}%、${num(line)} を${long ? '割る' : '超える'}確率は約${Math.round(best.pLine * 100)}%です。`;
  } else {
    text = losing
      ? `待っても平均では損が小さくならない見込みです。今すぐ決済（${fmt(nowPl)}）が一番損が小さい選び方です。`
      : `待っても平均ではもうけが増えない見込みです。今のうちに利益を確定（${fmt(nowPl)}）するのが無難です。`;
  }
  return { line, escape, rows, now: nowPl, best, wait: worth, text, losing };
}

// ---------------- 長い目で見ると（1か月〜半年） ----------------
// 10日先までだけでなく、1か月・3か月・半年持った場合も試す。
// 長く持つなら、損切りの線は広め（大きな流れが壊れたところ）に置く。
const LONG_DAYS = [[20, '1か月'], [60, '3か月'], [120, '半年']];
const sma = (arr, n) => (arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null);

export function longTermView(h, candles, adv, { mode, prices = {}, usdjpy = null } = {}) {
  const ypu = yenPerUnit(mode, h.symbol, { prices, usdjpy });
  const qty = Number(h.qty) || 0;
  if (!adv || ypu == null || !qty || candles.length < 120) return null;
  const side = h.side < 0 ? -1 : 1;
  const long = side > 0;
  const entry = Number(h.price);
  const now = adv.now, a = adv.atr;
  const closes = candles.map((c) => c.close);
  const pl = (p) => side * (p - entry) * qty * ypu;
  const fmt = (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString()}円`;

  // 大きな流れ：200日（なければ100日）の平均、1年の高値・安値の中での位置、過去の下げからの戻り方
  const ma200 = sma(closes, 200) ?? sma(closes, 100);
  const ma50 = sma(closes, 50);
  const yr = candles.slice(-250);
  const hi = Math.max(...yr.map((c) => c.high)), lo = Math.min(...yr.map((c) => c.low));
  const pos = hi > lo ? (now - lo) / (hi - lo) : 0.5;
  const trendUp = ma50 != null && ma200 != null && ma50 > ma200 && now > ma200;
  const trendDown = ma50 != null && ma200 != null && ma50 < ma200 && now < ma200;
  // 1年の中で、今と同じくらい高値から下がったあと、3か月以内に元の値段まで戻った割合
  const dd = (hi - now) / hi;
  let similar = 0, recovered = 0;
  for (let i = 60; i < closes.length - 60; i++) {
    const peak = Math.max(...closes.slice(i - 60, i));
    const d = (peak - closes[i]) / peak;
    if (Math.abs(d - dd) < 0.03 && dd > 0.05) {
      similar++;
      if (Math.max(...closes.slice(i + 1, i + 61)) >= peak * 0.97) recovered++;
      i += 10; // 同じ下げを何度も数えない
    }
  }

  // 長く持つときの最終ライン：半年の安値の少し下か、今から4ATR（大きな流れが壊れたところ）
  const low120 = Math.min(...candles.slice(-120).map((c) => c.low)), high120 = Math.max(...candles.slice(-120).map((c) => c.high));
  const line = long ? Math.min(now - 4 * a, low120 - 0.5 * a) : Math.max(now + 4 * a, high120 + 0.5 * a);
  const losing = pl(now) < 0;
  const lv = supportResistance(candles.slice(-250), { maxEach: 5 });
  const farWall = lv.filter((l) => (long ? l.kind === 'resistance' && l.price > now : l.kind === 'support' && l.price < now))
    .sort((x, y) => (long ? y.price - x.price : x.price - y.price))[0];
  const escape = losing ? entry : (farWall?.price ?? now + side * 6 * a);

  const sims = simulatePaths(closes, { horizon: 120, paths: 1200, seed: seedOf('L' + h.symbol + h.price) });
  if (!sims) return null;
  const rows = LONG_DAYS.map(([d, label]) => {
    const res = [];
    let hitLine = 0, hitEsc = 0;
    for (const path of sims) {
      let v = null;
      for (let k = 0; k < d; k++) {
        const p = path[k];
        if (long ? p <= line : p >= line) { v = pl(p); hitLine++; break; }
        if (long ? p >= escape : p <= escape) { v = pl(p); hitEsc++; break; }
      }
      res.push(v ?? pl(path[d - 1]));
    }
    res.sort((x, y) => x - y);
    return { d, label, mean: res.reduce((s, x) => s + x, 0) / res.length, p10: res[Math.floor(res.length * 0.1)], p90: res[Math.floor(res.length * 0.9)], pLine: hitLine / sims.length, pEscape: hitEsc / sims.length };
  });

  const reasons = [];
  if (trendUp) reasons.push(`大きな流れは${long ? '味方' : '逆風'}：50日の平均が200日の平均より上で、値段も200日の平均（${num(ma200)}）より上（長い目で見ると上向き）`);
  else if (trendDown) reasons.push(`大きな流れは${long ? '逆風' : '味方'}：50日の平均が200日の平均より下で、値段も200日の平均（${num(ma200)}）より下（長い目で見ると下向き）`);
  else if (ma200 != null) reasons.push(`大きな流れははっきりしない：値段は200日の平均（${num(ma200)}）の近く`);
  reasons.push(`この1年の高値（${num(hi)}）と安値（${num(lo)}）の間で、今は下から${Math.round(pos * 100)}%の位置${pos < 0.2 ? '（安いところ）' : pos > 0.8 ? '（高いところ）' : ''}`);
  if (similar >= 2) reasons.push(`この1年で、今と同じくらい（高値から${Math.round(dd * 100)}%）下がった場面は${similar}回あり、そのうち${recovered}回は3か月以内に元の値段近くまで戻った`);
  const best = rows.reduce((b, r) => (r.mean > b.mean ? r : b), rows[0]);
  const flowOk = long ? !trendDown : !trendUp;
  let text;
  if (best.mean > pl(now) && flowOk) {
    text = `長い目で見ると、${best.label}ほど持つ方が平均では${losing ? '損が小さい' : 'もうけが大きい'}見込みです（今 ${fmt(pl(now))} → 平均 ${fmt(best.mean)}）。長く持つなら、最終ラインを ${num(line)} に置き、そこを${long ? '割ったら' : '超えたら'}必ず決済してください。`;
  } else if (!flowOk) {
    text = `長い目で見ても大きな流れが${long ? '下向き' : '上向き'}なので、長く持って取り返すのはおすすめしにくいです。${losing ? '損切りを先延ばしにしない方が安全です。' : '利益があるうちに決済を考えましょう。'}`;
  } else {
    text = `長く持っても、平均では今より良くならない見込みです（${best.label}後の平均 ${fmt(best.mean)}）。`;
  }
  return { rows, line, escape, losing, text, reasons, now: pl(now) };
}

// ---------------- 買い増し・ナンピン ----------------
// 利益が出ているとき：流れが続いていれば「買い増し」してよいか、どこで買うか
// 損が出ているとき：下がったところで買い足す「ナンピン」をしてよいか、するならどこで・どれだけか
export function addOnAdvice(h, candles, adv, { mode = 'stock', unitLabel = null } = {}) {
  if (!adv || !candles || candles.length < 80) return null;
  const side = h.side < 0 ? -1 : 1, long = side > 0;
  const closes = candles.map((c) => c.close);
  const now = adv.now, a = adv.atr, r = adv.rsi ?? 50;
  const ma25 = sma(closes, 25), ma75 = sma(closes, 75);
  const trendOk = long ? ma25 > ma75 && now > ma75 : ma25 < ma75 && now < ma75;
  const techOk = long ? /買い/.test(adv.tech) : /売り/.test(adv.tech);
  const techBad = long ? /売り/.test(adv.tech) : /買い/.test(adv.tech);
  const unit = unitLabel || (mode === 'fx' ? '通貨' : '株');
  const lot = mode === 'stock' ? 100 : mode === 'fx' ? 1000 : 1;
  const qty = Number(h.qty) || 0, entry = Number(h.price);
  const half = Math.max(lot, Math.floor(qty / 2 / lot) * lot);
  const newAvg = (p) => (entry * qty + p * half) / (qty + half);
  // 今より有利でない側（買いなら下）にある一番近い「支え」
  const lv = supportResistance(candles).filter((l) => (long ? l.kind === 'support' && l.price < now : l.kind === 'resistance' && l.price > now))
    .sort((x, y) => (long ? y.price - x.price : x.price - y.price));
  const sup = lv[0];
  const verb = long ? '買い' : '売り';
  if (adv.plPct >= 0) {
    if (trendOk && techOk && (long ? r < 70 : r > 30)) {
      const dip = long ? Math.max(ma25, sup?.price ?? 0) : Math.min(ma25, sup?.price ?? Infinity);
      const near = Math.abs(now - dip) <= a * 2;
      return { kind: 'add', icon: '➕', title: `${verb}増しOK`, text: `流れが${long ? '上向き' : '下向き'}で、テクニカル判定も「${adv.tech}」です。${verb}増しするなら${near ? `少し${long ? '下がった' : '上がった'}ところ（${fmt(dip)}付近＝${sup && Math.abs(sup.price - dip) < 1e-9 ? '支え' : '25日の平均'}）` : '今の値段でも'}で、今の数量の半分（${half.toLocaleString()}${unit}）までがおすすめ。そうすると平均は${fmt(newAvg(near ? dip : now))}になります。損切りの線（${fmt(adv.stop)}）は全部の数量に入れておきましょう。` };
    }
    if (long ? r >= 70 : r <= 30) return { kind: 'wait', icon: '⏸', title: `${verb}増しは待つ`, text: `RSIが${Math.round(r)}で${long ? '上がりすぎ' : '下がりすぎ'}です。${verb}増しするなら、${fmt(long ? ma25 : ma25)}付近（25日の平均）まで戻ってからにしましょう。` };
    return { kind: 'none', icon: '✋', title: `${verb}増しは見送り`, text: `利益は出ていますが、流れ（テクニカル判定「${adv.tech}」）が強くないので、${verb}増しより今の分を守る方を優先しましょう。` };
  }
  // 損が出ているとき（ナンピン）
  if (techBad || !trendOk || adv.key === 'cut') {
    return { kind: 'no', icon: '🚫', title: 'ナンピンはしない方がいい', text: `${techBad ? `流れが${long ? '下向き' : '上向き'}（テクニカル判定「${adv.tech}」）` : adv.key === 'cut' ? '損切りの線を割っている' : `大きな流れ（25日・75日の平均線）が${long ? '下向き' : '上向き'}`}なので、ここで買い足すと損が大きくなりやすいです。ナンピンより、損切りの線（${fmt(adv.stop)}）を守ることを優先しましょう。` };
  }
  if (sup && Math.abs(now - sup.price) <= a * 1.5 && (long ? r < 45 : r > 55)) {
    const lastStop = sup.price - side * a;
    return { kind: 'nanpin', icon: '🔽', title: 'ナンピンするならここ', text: `大きな流れはまだ${long ? '上向き' : '下向き'}で、すぐ近くに支え（${fmt(sup.price)}・${sup.strength || ''}）があります。ナンピンするなら${fmt(sup.price)}付近で、今の数量の半分（${half.toLocaleString()}${unit}）まで。平均は${fmt(newAvg(sup.price))}になり、そこまで戻れば損なしです。ただし${fmt(lastStop)}を割ったら、買い足した分も含めて全部損切りしましょう。` };
  }
  return { kind: 'wait', icon: '⏸', title: 'ナンピンは急がない', text: `大きな流れはまだ${long ? '上向き' : '下向き'}ですが、${sup ? `支え（${fmt(sup.price)}）まで${long ? '下がって' : '上がって'}、そこで止まるのを確かめてから` : '下げ止まりを確かめてから'}にしましょう。今すぐ買い足すのはおすすめしません。` };
}
const fmt = (v) => Number(Number(v).toPrecision(6)).toLocaleString('ja-JP', { maximumFractionDigits: 4 });
