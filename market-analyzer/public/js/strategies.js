// 自動売買の練習（仮想のお金で売買したらどうなったか）
// ・判断はその日の終わりの値段まで見て行い、実際の売買は次の日の始まりの値段で行う（未来の値段を使わない）
// ・1回の取引は仮想の100万円分。手数料などの費用も差し引く
// ・3つのやり方（戦略）を用意し、それぞれ別々に成績を出す
import { sma, rsi, atr, technicalSummary } from './indicators.js';
import { dayKey } from './backtest.js';

export const STRATEGIES = {
  trend: {
    name: '流れに乗る',
    desc: '上向きの流れの中で、最近20日の一番高い値段を超えたら買う。流れが弱まったら売る。',
  },
  rebound: {
    name: '行きすぎを狙う',
    desc: '売られすぎ（買われすぎ度RSIが30以下）になったら買い、元に戻ったら売る。',
  },
  combo: {
    name: '総合判断',
    desc: 'テクニカル分析の判定に、世界の情勢（恐怖指数・金利・株価の流れ）とファンダメンタルズを合わせて判断する。',
  },
};

const CAPITAL = 1_000_000;
// 持っている間に一番不利だったときの損益の割合（ロスカットの計算に使う。マイナスの数）
const maeOf = (pos, high, low) => (pos.side > 0 ? Math.min(pos.trough, low) / pos.entryPrice - 1 : 1 - Math.max(pos.peak, high) / pos.entryPrice);
const num = (v) => Number(Number(v).toPrecision(6)).toLocaleString('ja-JP', { maximumFractionDigits: 4 });
// 「（ゴールデンクロス＝…）」のような補足を外して短くする
const short = (t) => String(t).replace(/（[^）]*）/g, '');

// 情勢（恐怖指数・米国の金利・日経平均）を日付から引けるようにする
export function regimeLookup(series) {
  const make = (candles) => {
    const list = (candles || []).map((c) => [dayKey(c.time), c.close]);
    const closes = list.map((x) => x[1]);
    const ma50 = sma(closes, 50);
    return list.map(([d, v], i) => ({ d, v, ma50: ma50[i], chg20: i >= 20 ? v - closes[i - 20] : 0 }));
  };
  const vix = make(series.vix), tnx = make(series.tnx), nikkei = make(series.nikkei);
  const at = (arr, d) => {
    let lo = 0, hi = arr.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].d <= d) { ans = arr[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };
  return (d) => ({ vix: at(vix, d), tnx: at(tnx, d), nikkei: at(nikkei, d) });
}

// 情勢の点数（+ならリスクを取りやすい＝株高・円安になりやすい、-ならその逆）
export function regimeScore(r, kind, pair = '') {
  if (!r) return { score: 0, notes: [] };
  let score = 0;
  const notes = [];
  if (r.vix) {
    if (r.vix.v > 25) { score -= 1; notes.push(`恐怖指数が高い(${r.vix.v.toFixed(0)})`); } else if (r.vix.v < 18) { score += 1; notes.push('世界が落ち着いている'); }
  }
  if (r.nikkei?.ma50 && kind !== 'us') {
    if (r.nikkei.v > r.nikkei.ma50) { score += 1; notes.push('日経平均が上向き'); } else { score -= 1; notes.push('日経平均が下向き'); }
  }
  // 米国の金利（ドルが絡む通貨ペアだけ）
  if (kind === 'fx' && /USD/.test(pair) && r.tnx) {
    const usdUp = r.tnx.chg20 > 0.1 ? 1 : r.tnx.chg20 < -0.1 ? -1 : 0;
    if (usdUp) {
      score += pair.startsWith('USD') ? usdUp : -usdUp;
      notes.push(usdUp > 0 ? '米国の金利が上昇（ドル高要因）' : '米国の金利が低下（ドル安要因）');
    }
  }
  return { score, notes };
}

function cost(kind) {
  return kind === 'fx' ? 0.0003 : 0.001; // 往復の費用（スプレッド・手数料の目安）
}

export function runStrategy(candles, id, { kind = 'stock', pair = '', regime = null, fundamentalRatio = null, days = 250, intraday = false, maxHold = null } = {}) {
  // デイトレ（intraday）：15分足などで売買し、その日のうちに必ず決済する（持ち越さない）
  const NEXT = intraday ? '次の足の始まりの値段' : '次の日の始まりの値段';
  const BAR = intraday ? 'この足の終わりの値段' : 'この日の終わりの値段';
  const sessKey = (t) => (kind === 'fx' ? Math.floor((t + 2 * 3600) / 86400) : Math.floor((t + 9 * 3600) / 86400));
  // i本目がその日の最後の足か（次の足との間が2時間以上あく・為替は朝7時で区切る）
  const sessionEnd = (i) => i < candles.length - 1 && (candles[i + 1].time - candles[i].time >= 2 * 3600 || sessKey(candles[i + 1].time) !== sessKey(candles[i].time));
  const closes = candles.map((c) => c.close);
  const ma25 = sma(closes, 25), ma75 = sma(closes, 75);
  const r14 = rsi(closes, 14);
  const a14 = atr(candles, 14);
  const canShort = kind === 'fx';
  const start = Math.max(80, candles.length - days);
  const trades = [];
  const daily = [];
  let pos = null; // { side: 1 or -1, entryIdx, entryPrice, reason, stop, take, peak }
  let pending = null; // 次の日の始まりに行う売買
  let realized = 0;

  const techAt = (i) => technicalSummary(candles.slice(Math.max(0, i - 199), i + 1));

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const events = [];
    // 1) 前の日に決めた売買を、今日の始まりの値段で行う
    if (pending) {
      if (pending.type === 'open' && !pos) {
        pos = { side: pending.side, entryIdx: i, entryPrice: c.open, reason: pending.reason, why: pending.why || [], strength: pending.strength ?? null, peak: c.open, trough: c.open };
        const a = a14[i - 1] || c.open * 0.01;
        pos.stop = c.open - pos.side * a * (id === 'rebound' ? 2 : 2);
        pos.take = id === 'combo' ? c.open + pos.side * a * 3 : null;
        pos.stop0 = pos.stop;
        pos.why = [...pos.why, `入った値段 ${num(c.open)}（${NEXT}）・損切りの線 ${num(pos.stop)}${pos.take ? `・利益確定の目標 ${num(pos.take)}` : ''}`];
        events.push(`${pos.side > 0 ? '買い' : '売り'}で入る（${pending.reason}）`);
      } else if (pending.type === 'close' && pos) {
        const ret = pos.side * (c.open / pos.entryPrice - 1) - cost(kind);
        const pnl = CAPITAL * ret;
        realized += pnl;
        trades.push({ side: pos.side, mae: maeOf(pos, c.open, c.open), entryDate: dayKey(candles[pos.entryIdx].time), entryTime: candles[pos.entryIdx].time, entryPrice: pos.entryPrice, exitDate: dayKey(c.time), exitTime: c.time, exitPrice: c.open, ret, pnl, stopPct: Math.abs(pos.entryPrice - pos.stop0) / pos.entryPrice, reasonIn: pos.reason, reasonOut: pending.reason, strength: pos.strength, whyIn: pos.why, whyOut: pending.why || [], days: i - pos.entryIdx });
        events.push(`決済（${pending.reason}）`);
        pos = null;
      }
      pending = null;
    }

    // 2) 今日の終わりの値段で、次の日にどうするか決める
    const price = c.close;
    if (intraday && pos && sessionEnd(i)) {
      // デイトレは、その日の最後の足の終わりの値段で必ず決済する
      const ret = pos.side * (price / pos.entryPrice - 1) - cost(kind);
      const pnl = CAPITAL * ret;
      realized += pnl;
      trades.push({ side: pos.side, mae: maeOf(pos, c.high, c.low), entryDate: dayKey(candles[pos.entryIdx].time), entryTime: candles[pos.entryIdx].time, entryPrice: pos.entryPrice, exitDate: dayKey(c.time), exitTime: c.time, exitPrice: price, ret, pnl, stopPct: Math.abs(pos.entryPrice - pos.stop0) / pos.entryPrice, reasonIn: pos.reason, reasonOut: 'その日の取引時間が終わるので決済（持ち越さない）', strength: pos.strength, whyIn: pos.why, whyOut: [`${BAR} ${num(price)}`, 'デイトレなので、次の日に持ち越さずに決済'], days: i - pos.entryIdx });
      events.push('決済（その日の終わり）');
      pos = null;
      pending = null;
    } else if (pos) {
      pos.peak = Math.max(pos.peak, c.high);
      pos.trough = Math.min(pos.trough, c.low);
      const a = a14[i] || price * 0.01;
      const held = i - pos.entryIdx;
      // 損切りの線を、有利に動いた分だけ引き上げる（流れに乗る戦略）
      if (id === 'trend') pos.stop = pos.side > 0 ? Math.max(pos.stop, pos.peak - 2 * a) : Math.min(pos.stop, pos.trough + 2 * a);
      let exit = null, why = [];
      const gain = pos.side * (price / pos.entryPrice - 1);
      const now = `${BAR} ${num(price)}（入った値段から${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(1)}%）`;
      if (pos.side > 0 ? price <= pos.stop : price >= pos.stop) {
        exit = '損切り・逆に動いた';
        why = [`${pos.side > 0 ? '下がって' : '上がって'}、あらかじめ決めていた損切りの線（${num(pos.stop)}）に届いた`, now, 'これ以上損を広げないために決済'];
      } else if (pos.take && (pos.side > 0 ? price >= pos.take : price <= pos.take)) {
        exit = '目標まで動いたので利益確定';
        why = [`利益確定の目標（${num(pos.take)}）に届いた`, now, '欲張らずに利益を確定'];
      } else if (id === 'trend' && ma25[i] && (pos.side > 0 ? price < ma25[i] : price > ma25[i])) {
        exit = '平均線を割って流れが弱まった';
        why = [`値段が25日の平均（${num(ma25[i])}）を${pos.side > 0 ? '下回った' : '上回った'}`, now, '流れが弱まったので降りる'];
      } else if (id === 'rebound' && r14[i] != null && (pos.side > 0 ? r14[i] > 55 : r14[i] < 45)) {
        exit = '行きすぎが元に戻った';
        why = [`買われすぎ・売られすぎ度（RSI）が${r14[i].toFixed(0)}まで戻った`, now, 'ねらっていた戻りが終わったので決済'];
      } else if (id === 'combo') {
        const ts = techAt(i);
        if (pos.side > 0 ? /売り/.test(ts.label) : /買い/.test(ts.label)) {
          exit = `判定が「${ts.label}」に変わった`;
          const against = ts.rows.filter((r) => r.signal === (pos.side > 0 ? '売り' : '買い'));
          why = [`テクニカル判定が「${ts.label}」に変わった（反対のサイン${against.length}/${ts.rows.length}個）`, ...against.slice(0, 2).map((r) => short(r.detail)), now];
        }
      }
      const limit = maxHold || (id === 'rebound' ? 10 : 30);
      if (!exit && held >= limit) {
        exit = maxHold && !intraday ? `持つ日数の上限（${limit}日）になったので決済` : '長く持ちすぎたので終了';
        why = [intraday ? `${held}本（足）持っても決着がつかなかった` : `決めた日数（${limit}日）持っても決着がつかなかった`, now, maxHold ? 'あなたが決めた「持つ日数の上限」になったので決済' : 'お金を寝かせないために、いったん終了'];
      }
      // 最後の日に決めたことは「次の取引日の予定」として残る
      if (exit) pending = { type: 'close', reason: exit, why };
    } else if (!(intraday && (sessionEnd(i) || sessionEnd(i + 1)))) {
      let side = 0, reason = '', why = [], strength = null;
      if (id === 'trend' && ma25[i] && ma75[i]) {
        const hi20 = Math.max(...candles.slice(i - 20, i).map((x) => x.high));
        const lo20 = Math.min(...candles.slice(i - 20, i).map((x) => x.low));
        if (ma25[i] > ma75[i] && price > hi20) { side = 1; reason = '上向きの流れで最近20日の高値を超えた'; why = ['25日の平均が75日の平均より上（上向きの流れ）', `この日の終わりの値段 ${num(price)} が、最近20日の一番高い値段 ${num(hi20)} を超えた`, 'さらに上がる勢いに乗る']; }
        else if (canShort && ma25[i] < ma75[i] && price < lo20) { side = -1; reason = '下向きの流れで最近20日の安値を下回った'; why = ['25日の平均が75日の平均より下（下向きの流れ）', `この日の終わりの値段 ${num(price)} が、最近20日の一番安い値段 ${num(lo20)} を下回った`, 'さらに下がる勢いに乗る']; }
      } else if (id === 'rebound' && r14[i] != null) {
        if (r14[i] < 30) { side = 1; reason = `売られすぎ（RSI ${r14[i].toFixed(0)}）`; why = [`買われすぎ・売られすぎ度（RSI）が${r14[i].toFixed(0)}（30以下は売られすぎ）`, '下がりすぎた反動で、上がり返すのをねらう']; }
        else if (canShort && r14[i] > 70) { side = -1; reason = `買われすぎ（RSI ${r14[i].toFixed(0)}）`; why = [`買われすぎ・売られすぎ度（RSI）が${r14[i].toFixed(0)}（70以上は買われすぎ）`, '上がりすぎた反動で、下がり返すのをねらう']; }
      } else if (id === 'combo') {
        const ts = techAt(i);
        const t = ts.label;
        const rg = regimeScore(regime?.(dayKey(c.time)), kind, pair);
        const fundOk = fundamentalRatio == null || fundamentalRatio > -0.3;
        const explain = (sig) => {
          const agree = ts.rows.filter((r) => r.signal === sig);
          return [
            `テクニカル判定「${t}」（${sig}のサイン${agree.length}/${ts.rows.length}個）`,
            ...agree.slice(0, 3).map((r) => short(r.detail)),
            rg.notes.length ? `世界の情勢：${rg.notes.join('・')}` : '世界の情勢：特に悪い材料なし',
            ...(fundamentalRatio != null && sig === '買い' ? ['会社の業績など（ファンダメンタルズ）も悪くない'] : []),
          ];
        };
        if (/買い/.test(t) && rg.score >= 0 && fundOk) { side = 1; why = explain('買い'); strength = ts.rows.filter((r) => r.signal === '買い').length / ts.rows.length; reason = `テクニカル判定が「${t}」で、世界の情勢も逆風ではない`; }
        else if (canShort && /売り/.test(t) && rg.score <= 0) { side = -1; why = explain('売り'); strength = ts.rows.filter((r) => r.signal === '売り').length / ts.rows.length; reason = `テクニカル判定が「${t}」で、世界の情勢も追い風ではない`; }
      }
      if (side) {
        const a = a14[i] || price * 0.01;
        // 次の日の始まりの値段は分からないので、今日の終わりの値段で損切り・目標の目安を出しておく
        pending = { type: 'open', side, reason, why, strength, atr: a, stopEst: price - side * a * 2, takeEst: id === 'combo' ? price + side * a * 3 : null };
      }
    }

    const unreal = pos ? CAPITAL * (pos.side * (price / pos.entryPrice - 1)) : 0;
    const equity = realized + unreal;
    daily.push({ date: dayKey(c.time), time: c.time, equity, pnl: equity - (daily.length ? daily[daily.length - 1].equity : 0), holding: pos ? (pos.side > 0 ? '買い持ち' : '売り持ち') : '', events, close: price });
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const last = daily[daily.length - 1];
  let peak = 0, maxDD = 0;
  for (const d of daily) { peak = Math.max(peak, d.equity); maxDD = Math.max(maxDD, peak - d.equity); }
  return {
    id,
    trades,
    daily,
    open: pos ? { side: pos.side, entryDate: dayKey(candles[pos.entryIdx].time), entryTime: candles[pos.entryIdx].time, entryPrice: pos.entryPrice, reason: pos.reason, why: pos.why, strength: pos.strength, stop: pos.stop, take: pos.take, unreal: last ? last.equity - realized : 0 } : null,
    next: pending,
    stats: {
      trades: trades.length,
      winRate: trades.length ? wins.length / trades.length : null,
      total: last ? last.equity : 0,
      realized,
      maxDrawdown: maxDD,
      buyHold: candles.length > start ? CAPITAL * (candles[candles.length - 1].close / candles[start].close - 1) : 0,
      from: daily[0]?.date, to: last?.date,
    },
  };
}

// ---------------- 勝率の高い銘柄だけを選んで売買する ----------------
// 20取引日ごとに「その時点までの過去約半年で、総合判断のやり方の勝率が高かった銘柄」を最大3つ選び、
// 次の20日間はその銘柄だけで売買する。選ぶときに未来の成績は使わない。
export function pickAndTrade(list, { kind = 'stock', regime = null, days = 250, block = 20, lookbackDays = 180, topK = 3, minWin = 0.5 } = {}) {
  const runs = list.map((s) => ({
    ...s,
    run: runStrategy(s.candles, 'combo', { kind, pair: s.symbol.replace(/=X$/, ''), regime, fundamentalRatio: s.fundRatio, days: s.candles.length }),
  }));
  const calendar = [...new Set(runs.flatMap((r) => r.candles.map((c) => dayKey(c.time))))].sort().slice(-days);
  const shift = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

  const rank = (date) => runs.map((r) => {
    const past = r.run.trades.filter((t) => t.exitDate < date && t.exitDate >= shift(date, -lookbackDays));
    const wins = past.filter((t) => t.pnl > 0).length;
    return { symbol: r.symbol, name: r.name, trades: past.length, winRate: past.length ? wins / past.length : 0, pnl: past.reduce((a, t) => a + t.pnl, 0) };
  }).filter((x) => x.trades >= 2 && x.winRate >= minWin && x.pnl > 0)
    .sort((a, b) => b.winRate - a.winRate || b.pnl - a.pnl)
    .slice(0, topK);

  const periods = [];
  for (let i = 0; i < calendar.length; i += block) {
    const from = calendar[i], to = calendar[Math.min(i + block, calendar.length) - 1];
    periods.push({ from, to, picks: rank(from) });
  }

  const trades = [];
  for (const p of periods) {
    for (const pk of p.picks) {
      const r = runs.find((x) => x.symbol === pk.symbol);
      for (const t of r.run.trades) {
        if (t.entryDate >= p.from && t.entryDate <= p.to) trades.push({ ...t, symbol: r.symbol, name: r.name });
      }
    }
  }

  // 1日ずつの損益（持っている間は毎日の値動きで評価し、決済した日に確定する）
  const byDate = new Map(calendar.map((d) => [d, { pnl: 0, events: [] }]));
  for (const t of trades) {
    const r = runs.find((x) => x.symbol === t.symbol);
    let prev = 0;
    for (const c of r.candles) {
      const d = dayKey(c.time);
      if (d < t.entryDate || d > t.exitDate || !byDate.has(d)) continue;
      const v = d === t.exitDate ? t.pnl : 1_000_000 * t.side * (c.close / t.entryPrice - 1);
      byDate.get(d).pnl += v - prev;
      prev = v;
    }
    byDate.get(t.entryDate)?.events.push(`${t.name}を${t.side > 0 ? '買い' : '売り'}`);
    byDate.get(t.exitDate)?.events.push(`${t.name}を決済（${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl).toLocaleString()}円）`);
  }
  let equity = 0;
  const daily = calendar.map((d) => {
    const x = byDate.get(d);
    equity += x.pnl;
    return { date: d, pnl: x.pnl, equity, events: x.events };
  });

  // 今の選び方（明日からの20日間に使う銘柄）と、その銘柄の今の状態
  const today = calendar[calendar.length - 1];
  const current = rank(shift(today, 1)).map((pk) => {
    const r = runs.find((x) => x.symbol === pk.symbol);
    return { ...pk, open: r.run.open, next: r.run.next };
  });

  const wins = trades.filter((t) => t.pnl > 0).length;
  let peak = 0, maxDD = 0;
  for (const d of daily) { peak = Math.max(peak, d.equity); maxDD = Math.max(maxDD, peak - d.equity); }
  // 比べるための目安：選ばずに全部の銘柄で同じやり方をした場合（1銘柄あたりの平均）
  const allAvg = runs.length ? runs.reduce((a, r) => a + r.run.trades.filter((t) => t.entryDate >= calendar[0]).reduce((b, t) => b + t.pnl, 0), 0) / runs.length : 0;
  return {
    periods, trades, daily, current,
    stats: { trades: trades.length, winRate: trades.length ? wins / trades.length : null, total: equity, maxDrawdown: maxDD, from: calendar[0], to: today, universe: runs.length, allAvg: allAvg * topK },
  };
}

// ---------------- 勝つ確率の目安 ----------------
// その銘柄の過去の同じ向きの取引と、全銘柄の「似た強さのサイン」の取引をまぜて、勝つ確率を見積もる。
// （その銘柄の回数が少ないときは、全銘柄の数字に近づける）
const bucketOf = (st) => (st == null ? 'x' : st >= 0.67 ? 'high' : st >= 0.5 ? 'mid' : 'low');
export function signalOdds(pool, { symbol, side, strength, before = null }, K = 8) {
  const past = before ? pool.filter((t) => t.exitDate < before) : pool;
  const same = past.filter((t) => t.side === side);
  const b = bucketOf(strength);
  let base = same.filter((t) => bucketOf(t.strength) === b);
  if (base.length < 10) base = same;
  if (base.length < 5) return null;
  const baseRate = base.filter((t) => t.pnl > 0).length / base.length;
  const mine = same.filter((t) => t.symbol === symbol);
  const myWins = mine.filter((t) => t.pnl > 0).length;
  const p = (myWins + K * baseRate) / (mine.length + K);
  const wins = base.filter((t) => t.pnl > 0), losses = base.filter((t) => t.pnl <= 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.ret, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.ret, 0) / losses.length : 0;
  return { p, mine: mine.length, myWins, base: base.length, baseRate, avgWin, avgLoss, expect: p * avgWin + (1 - p) * avgLoss };
}

export function oddsLabel(o) {
  if (!o) return '';
  return o.p >= 0.6 ? '高め' : o.p >= 0.5 ? 'ふつう' : '低め';
}

export function oddsText(o) {
  if (!o) return '過去の取引が少ないため、確率はまだ出せません';
  return `この銘柄の過去${o.mine}回（${o.myWins}勝）と、全銘柄の似たサイン${o.base}回（勝率${Math.round(o.baseRate * 100)}%）から計算。勝ったときは平均+${(o.avgWin * 100).toFixed(1)}%、負けたときは平均${(o.avgLoss * 100).toFixed(1)}%`;
}
