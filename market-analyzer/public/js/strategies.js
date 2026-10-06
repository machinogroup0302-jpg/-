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

export function runStrategy(candles, id, { kind = 'stock', pair = '', regime = null, fundamentalRatio = null, days = 250 } = {}) {
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
        pos = { side: pending.side, entryIdx: i, entryPrice: c.open, reason: pending.reason, peak: c.open, trough: c.open };
        const a = a14[i - 1] || c.open * 0.01;
        pos.stop = c.open - pos.side * a * (id === 'rebound' ? 2 : 2);
        pos.take = id === 'combo' ? c.open + pos.side * a * 3 : null;
        events.push(`${pos.side > 0 ? '買い' : '売り'}で入る（${pending.reason}）`);
      } else if (pending.type === 'close' && pos) {
        const ret = pos.side * (c.open / pos.entryPrice - 1) - cost(kind);
        const pnl = CAPITAL * ret;
        realized += pnl;
        trades.push({ side: pos.side, entryDate: dayKey(candles[pos.entryIdx].time), entryTime: candles[pos.entryIdx].time, entryPrice: pos.entryPrice, exitDate: dayKey(c.time), exitTime: c.time, exitPrice: c.open, ret, pnl, reasonIn: pos.reason, reasonOut: pending.reason, days: i - pos.entryIdx });
        events.push(`決済（${pending.reason}）`);
        pos = null;
      }
      pending = null;
    }

    // 2) 今日の終わりの値段で、次の日にどうするか決める
    const price = c.close;
    if (pos) {
      pos.peak = Math.max(pos.peak, c.high);
      pos.trough = Math.min(pos.trough, c.low);
      const a = a14[i] || price * 0.01;
      const held = i - pos.entryIdx;
      // 損切りの線を、有利に動いた分だけ引き上げる（流れに乗る戦略）
      if (id === 'trend') pos.stop = pos.side > 0 ? Math.max(pos.stop, pos.peak - 2 * a) : Math.min(pos.stop, pos.trough + 2 * a);
      let exit = null;
      if (pos.side > 0 ? price <= pos.stop : price >= pos.stop) exit = '損切り・逆に動いた';
      else if (pos.take && (pos.side > 0 ? price >= pos.take : price <= pos.take)) exit = '目標まで動いたので利益確定';
      else if (id === 'trend' && ma25[i] && (pos.side > 0 ? price < ma25[i] : price > ma25[i])) exit = '平均線を割って流れが弱まった';
      else if (id === 'rebound' && r14[i] != null && (pos.side > 0 ? r14[i] > 55 : r14[i] < 45)) exit = '行きすぎが元に戻った';
      else if (id === 'combo') {
        const t = techAt(i).label;
        if (pos.side > 0 ? /売り/.test(t) : /買い/.test(t)) exit = `判定が「${t}」に変わった`;
      }
      if (!exit && held >= (id === 'rebound' ? 10 : 30)) exit = '長く持ちすぎたので終了';
      // 最後の日に決めたことは「次の取引日の予定」として残る
      if (exit) pending = { type: 'close', reason: exit };
    } else {
      let side = 0, reason = '';
      if (id === 'trend' && ma25[i] && ma75[i]) {
        const hi20 = Math.max(...candles.slice(i - 20, i).map((x) => x.high));
        const lo20 = Math.min(...candles.slice(i - 20, i).map((x) => x.low));
        if (ma25[i] > ma75[i] && price > hi20) { side = 1; reason = '上向きの流れで最近20日の高値を超えた'; }
        else if (canShort && ma25[i] < ma75[i] && price < lo20) { side = -1; reason = '下向きの流れで最近20日の安値を下回った'; }
      } else if (id === 'rebound' && r14[i] != null) {
        if (r14[i] < 30) { side = 1; reason = `売られすぎ（RSI ${r14[i].toFixed(0)}）`; }
        else if (canShort && r14[i] > 70) { side = -1; reason = `買われすぎ（RSI ${r14[i].toFixed(0)}）`; }
      } else if (id === 'combo') {
        const t = techAt(i).label;
        const rg = regimeScore(regime?.(dayKey(c.time)), kind, pair);
        const fundOk = fundamentalRatio == null || fundamentalRatio > -0.3;
        if (/買い/.test(t) && rg.score >= 0 && fundOk) { side = 1; reason = `判定「${t}」${rg.notes.length ? '・' + rg.notes.join('・') : ''}`; }
        else if (canShort && /売り/.test(t) && rg.score <= 0) { side = -1; reason = `判定「${t}」${rg.notes.length ? '・' + rg.notes.join('・') : ''}`; }
      }
      if (side) pending = { type: 'open', side, reason };
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
    open: pos ? { side: pos.side, entryDate: dayKey(candles[pos.entryIdx].time), entryTime: candles[pos.entryIdx].time, entryPrice: pos.entryPrice, reason: pos.reason, unreal: last ? last.equity - realized : 0 } : null,
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
