// 取引のくせを細かく調べて、具体的なアドバイスにする
// ・損切り（負けを小さく止められているか）
// ・利益確定（勝ちを伸ばせているか、含み益を逃していないか）
// ・時間帯・曜日・持っていた時間・負けた後の取引・取引しすぎ・量の増やし方 など

const yen = (v) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(Math.round(v)).toLocaleString()}円`;
const amt = (v) => `${Math.abs(Math.round(v)).toLocaleString()}円`;
const pct = (v) => `${Math.round(v * 100)}%`;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const median = (a) => {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
};
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function fmtDuration(ms) {
  const m = ms / 60000;
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}秒`;
  if (m < 60) return `${Math.round(m)}分`;
  if (m < 60 * 24) return `${(m / 60).toFixed(m < 600 ? 1 : 0)}時間`;
  return `${(m / 1440).toFixed(1)}日`;
}

// 時間帯の分け方（日本時間）
const SESSIONS = {
  fx: [
    ['早朝（6〜9時）', 6 * 60, 9 * 60],
    ['東京時間（9〜15時）', 9 * 60, 15 * 60],
    ['ヨーロッパ時間（15〜21時）', 15 * 60, 21 * 60],
    ['ニューヨーク時間（21〜翌2時）', 21 * 60, 26 * 60],
    ['深夜（2〜6時）', 2 * 60, 6 * 60],
  ],
  stock: [
    ['寄り付き直後（9:00〜9:30）', 9 * 60, 9 * 60 + 30],
    ['前場（9:30〜11:30）', 9 * 60 + 30, 11 * 60 + 30],
    ['後場（12:30〜14:30）', 12 * 60 + 30, 14 * 60 + 30],
    ['大引け前（14:30〜15:30）', 14 * 60 + 30, 15 * 60 + 30],
  ],
  us: [
    ['取引開始直後（22:30〜24時）', 22 * 60 + 30, 24 * 60],
    ['取引時間の中ごろ（0〜4時）', 24 * 60, 28 * 60],
    ['取引終了前（4〜6時）', 28 * 60, 30 * 60],
  ],
};

export function sessionOf(date, mode) {
  const d = new Date(date);
  const min = d.getHours() * 60 + d.getMinutes();
  for (const [name, a, b] of SESSIONS[mode] || SESSIONS.fx) {
    if ((min >= a && min < b) || (min + 1440 >= a && min + 1440 < b)) return name;
  }
  return mode === 'stock' ? '取引時間の外（PTSなど）' : mode === 'us' ? '取引時間の外' : 'その他';
}

function summarize(list) {
  const wins = list.filter((t) => t.pnl > 0);
  return { count: list.length, wins: wins.length, winRate: list.length ? wins.length / list.length : 0, pnl: sum(list.map((t) => t.pnl)) };
}

function groupBy(list, fn, order) {
  const m = new Map();
  for (const t of list) {
    const k = fn(t);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  const rows = [...m.entries()].map(([key, ts]) => ({ key, ...summarize(ts), avg: sum(ts.map((t) => t.pnl)) / ts.length }));
  return order ? rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : rows;
}

const HOLD_BUCKETS = [
  ['1分未満', 0, 60e3], ['1〜5分', 60e3, 300e3], ['5〜30分', 300e3, 1800e3], ['30分〜2時間', 1800e3, 7200e3],
  ['2時間〜1日', 7200e3, 86400e3], ['1〜7日', 86400e3, 7 * 86400e3], ['7日以上', 7 * 86400e3, Infinity],
];

// 取引の時刻（時:分）が入っているか（日付だけのCSVでは時間帯は分からない）
const hasTime = (list, key = 'date') => list.filter((t) => t[key]).some((t) => { const d = new Date(t[key]); return d.getHours() || d.getMinutes(); });

/**
 * @param {Array} allTrades 取引（date, symbol, side, qty, pnl, openDate?）
 * @param {'fx'|'stock'|'us'} mode
 */
export function coach(allTrades, mode = 'fx') {
  const trades = allTrades.filter((t) => t.pnl != null && t.pnl !== 0 && t.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (trades.length < 3) return null;
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl < 0);
  const total = sum(trades.map((t) => t.pnl));
  const grossWin = sum(wins.map((t) => t.pnl)), grossLoss = -sum(losses.map((t) => t.pnl));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const winRate = wins.length / trades.length;
  const payoff = avgLoss ? avgWin / avgLoss : null;
  const findings = [];
  const add = (f) => findings.push({ impact: 0, ...f });

  // ---------- 1. 全体のタイプ ----------
  let type;
  if (payoff != null && payoff < 0.8 && winRate >= 0.5) type = { name: 'コツコツ勝って、ドカンと負けるタイプ', level: 'bad', text: `勝つ回数は多い（勝率${pct(winRate)}）のに、1回の負け（平均${amt(avgLoss)}）が1回の勝ち（平均${amt(avgWin)}）より大きく、利益を一気に失いやすい形です。いちばん多い負けパターンで、直せば一番伸びるところです。` };
  else if (payoff != null && payoff >= 1.5 && winRate < 0.45) type = { name: '負けは小さく、勝ちを伸ばすタイプ', level: total >= 0 ? 'good' : 'warn', text: `勝率は${pct(winRate)}と低めですが、1回の勝ち（平均${amt(avgWin)}）が負け（平均${amt(avgLoss)}）の${payoff.toFixed(1)}倍あります。この形は続ければ勝ちやすいので、損切りは今のまま守りましょう。` };
  else if (winRate < 0.4 && (payoff == null || payoff < 1.5)) type = { name: '負けの回数が多いタイプ', level: 'bad', text: `勝率が${pct(winRate)}と低く、勝ちの大きさ（平均${amt(avgWin)}）でも取り返せていません。入るタイミング（エントリー）を絞るのが先です。` };
  else if (total >= 0) type = { name: 'バランス型（トータルでプラス）', level: 'good', text: `勝率${pct(winRate)}、1回の勝ちは負けの${payoff != null ? payoff.toFixed(1) : '—'}倍で、トータル${yen(total)}です。下の「直すと伸びるところ」を1つずつ直すと、さらに安定します。` };
  else type = { name: 'もう少しでプラスのタイプ', level: 'warn', text: `勝率${pct(winRate)}、1回の勝ちは負けの${payoff != null ? payoff.toFixed(1) : '—'}倍で、トータル${yen(total)}です。損切りか利益確定のどちらかを少し直すだけでプラスにできる位置です。` };

  // ---------- 2. 損切り ----------
  if (losses.length >= 3) {
    const lossAbs = losses.map((t) => -t.pnl);
    const medLoss = median(lossAbs);
    const big = losses.filter((t) => -t.pnl >= Math.max(medLoss * 2, avgWin * 1.5));
    const bigSum = -sum(big.map((t) => t.pnl));
    const cap = Math.round(Math.max(avgWin, medLoss));
    const saved = sum(lossAbs.map((v) => Math.max(0, v - cap)));
    const worst = losses.reduce((a, b) => (a.pnl < b.pnl ? a : b));
    if (big.length && bigSum / grossLoss >= 0.35) {
      add({
        cat: '損切り', level: 'bad', impact: saved,
        title: '大きな負けが、損失の大部分を占めています',
        body: `負けた${losses.length}回のうち、たった${big.length}回の大きな負け（1回${amt(Math.max(medLoss * 2, avgWin * 1.5))}以上）だけで、損失全体の${pct(bigSum / grossLoss)}（${amt(bigSum)}）になっています。いちばん大きい負けは${new Date(worst.date).toLocaleDateString('ja-JP')}の${esc2(worst.symbol)}で${yen(worst.pnl)}です。`,
        rule: `1回の損失は「${amt(cap)}まで」と決めて、注文を出すと同時に損切りの注文（逆指値）も入れましょう。もし全部の負けを${amt(cap)}で止めていたら、合計は${yen(total)} → <b>${yen(total + saved)}</b>になっていました。`,
      });
    } else if (payoff != null && payoff < 1) {
      add({
        cat: '損切り', level: 'warn', impact: saved,
        title: '損切りが少し遅めです',
        body: `1回の負け（平均${amt(avgLoss)}）が、1回の勝ち（平均${amt(avgWin)}）より大きくなっています。`,
        rule: `損切りの幅を、利益確定の幅より小さくしましょう。目安は「1回の損失を${amt(cap)}まで」。そうしていたら合計は<b>${yen(total + saved)}</b>でした。`,
      });
    } else {
      add({ cat: '損切り', level: 'good', title: '損切りはできています', body: `負けの大きさがそろっていて（ふつうの負けは${amt(medLoss)}ぐらい）、大きな負けで一気に崩れることが少ないです。この習慣は続けましょう。` });
    }
  }
  if (winRate < 0.45 && losses.length >= 5) {
    add({
      cat: '損切り', level: winRate < 0.35 ? 'bad' : 'warn', impact: grossLoss * 0.2,
      title: 'マイナスで終わる取引が多いです',
      body: `${trades.length}回のうち${losses.length}回（${pct(losses.length / trades.length)}）が負けです。損切り自体はしていても、「入るタイミング」が早すぎたり、流れに逆らっていたりする可能性があります。`,
      rule: '入る前に「上がる（下がる）理由」を2つ以上言えるときだけ取引しましょう（例：上の流れ＋支えの近く）。チャート画面の「上がりそう・下がりそう」の判定と同じ向きのときだけ入る、と決めるのも効果的です。',
    });
  }

  // ---------- 3. 利益確定 ----------
  if (wins.length >= 3 && payoff != null && payoff < 1 && winRate >= 0.5) {
    const medWin = median(wins.map((t) => t.pnl));
    add({
      cat: '利益確定', level: 'warn', impact: wins.length * Math.max(0, avgLoss - avgWin) * 0.5,
      title: '利益が小さいうちに決済しがちです',
      body: `勝ったときの利益はふつう${amt(medWin)}ぐらいで、負けたときの損失（平均${amt(avgLoss)}）より小さいです。「せっかくの利益が消えるのが怖くて、すぐ決済してしまう」ときによく出る形です。`,
      rule: `利益確定の目標を「損切りの幅の1.5倍」に置きましょう。全部を一度に決済するのが怖いときは、半分だけ先に決済して、残りは損切りの位置を買った値段（建値）まで動かしてから伸ばすと安心です。`,
    });
  }

  // ---------- 4. 持っていた時間 ----------
  const withHold = trades.filter((t) => t.openDate && new Date(t.date) >= new Date(t.openDate))
    .map((t) => ({ ...t, hold: new Date(t.date) - new Date(t.openDate) }));
  let holding = null;
  if (withHold.length >= 5) {
    const wHold = withHold.filter((t) => t.pnl > 0).map((t) => t.hold);
    const lHold = withHold.filter((t) => t.pnl < 0).map((t) => t.hold);
    holding = {
      win: wHold.length ? median(wHold) : null,
      loss: lHold.length ? median(lHold) : null,
      buckets: HOLD_BUCKETS.map(([key, a, b]) => ({ key, ...summarize(withHold.filter((t) => t.hold >= a && t.hold < b)) })).filter((r) => r.count),
    };
    if (holding.win && holding.loss && holding.loss >= holding.win * 1.5 && lHold.length >= 3) {
      const limit = holding.win * 2;
      const over = withHold.filter((t) => t.pnl < 0 && t.hold > limit);
      add({
        cat: '損切り', level: 'bad', impact: -sum(over.map((t) => t.pnl)) * 0.4,
        title: '負けている取引を長く持ちすぎています',
        body: `勝った取引はふつう${fmtDuration(holding.win)}で決済しているのに、負けた取引は${fmtDuration(holding.loss)}も持っています（${(holding.loss / holding.win).toFixed(1)}倍）。「含み損はそのうち戻るはず」と我慢して、含み益はすぐ決済する——人がいちばん陥りやすいくせです。`,
        rule: `「${fmtDuration(limit)}たっても含み損なら、いったん決済する」という時間のルールを作りましょう。${over.length ? `このルールに当てはまる負けが${over.length}回（合計${yen(sum(over.map((t) => t.pnl)))}）ありました。` : ''}`,
      });
    } else if (holding.win && holding.loss && holding.win >= holding.loss * 1.5) {
      add({ cat: '利益確定', level: 'good', title: '「負けは早く、勝ちは長く」ができています', body: `負けた取引は${fmtDuration(holding.loss)}で切り、勝った取引は${fmtDuration(holding.win)}持っています。勝てる人の持ち方です。` });
    }
    const hb = holding.buckets.filter((r) => r.count >= 3).sort((a, b) => a.pnl - b.pnl);
    if (hb.length >= 2 && hb[0].pnl < 0) {
      add({
        cat: '持つ時間', level: 'warn', impact: -hb[0].pnl * 0.5,
        title: `持つ時間が「${hb[0].key}」の取引で負けています`,
        body: `${hb[0].key}で決済した取引は${hb[0].count}回で${yen(hb[0].pnl)}（勝率${pct(hb[0].winRate)}）。いちばん良いのは「${hb[hb.length - 1].key}」で${yen(hb[hb.length - 1].pnl)}です。`,
        rule: `自分に合う持ち方は「${hb[hb.length - 1].key}」ぐらいです。${hb[0].key}で決済してしまう取引は、思いつきで入っていないか見直しましょう。`,
      });
    }
  }

  // ---------- 5. 時間帯・曜日 ----------
  const timeKey = withHold.length >= trades.length * 0.8 && hasTime(trades, 'openDate') ? 'openDate' : 'date';
  const timed = hasTime(trades, timeKey) ? trades.filter((t) => t[timeKey]) : [];
  const sessions = timed.length ? groupBy(timed, (t) => sessionOf(t[timeKey], mode), [...(SESSIONS[mode] || SESSIONS.fx).map((s) => s[0]), 'その他', '取引時間の外', '取引時間の外（PTSなど）']) : [];
  const hours = timed.length ? groupBy(timed, (t) => new Date(t[timeKey]).getHours()).sort((a, b) => a.key - b.key) : [];
  if (sessions.length >= 2) {
    const s = sessions.filter((r) => r.count >= 3).sort((a, b) => a.pnl - b.pnl);
    if (s.length >= 2 && s[0].pnl < 0) {
      add({
        cat: '時間帯', level: 'warn', impact: -s[0].pnl,
        title: `${s[0].key}の取引で負けています`,
        body: `${timeKey === 'openDate' ? '取引を始めた' : '決済した'}時間で分けると、${s[0].key}は${s[0].count}回で${yen(s[0].pnl)}（勝率${pct(s[0].winRate)}）。いちばん良いのは${s[s.length - 1].key}で${yen(s[s.length - 1].pnl)}（勝率${pct(s[s.length - 1].winRate)}）です。`,
        rule: `${s[0].key}は取引しない（見るだけにする）と決めると、合計は${yen(total)} → <b>${yen(total - s[0].pnl)}</b>になっていました。${mode === 'fx' && /ニューヨーク|ヨーロッパ/.test(s[0].key) ? '夜は経済指標の発表で急に動きやすい時間です。' : ''}${mode === 'stock' && /寄り付き/.test(s[0].key) ? '寄り付き直後は値動きが荒く、上下に振られやすい時間です。' : ''}`,
      });
    } else if (s.length >= 2) {
      add({ cat: '時間帯', level: 'good', title: `得意な時間帯は${s[s.length - 1].key}です`, body: `${s[s.length - 1].count}回で${yen(s[s.length - 1].pnl)}（勝率${pct(s[s.length - 1].winRate)}）。この時間に集中すると成績が安定しやすいです。` });
    }
  }
  const wd = groupBy(trades, (t) => WEEKDAYS[new Date(t.date).getDay()], WEEKDAYS);
  const wdBad = wd.filter((r) => r.count >= 4).sort((a, b) => a.pnl - b.pnl);
  if (wdBad.length >= 3 && wdBad[0].pnl < 0 && wdBad[0].pnl < -Math.abs(total) * 0.3) {
    add({ cat: '時間帯', level: 'warn', impact: -wdBad[0].pnl * 0.5, title: `${wdBad[0].key}曜日に負けが集中しています`, body: `${wdBad[0].key}曜日は${wdBad[0].count}回で${yen(wdBad[0].pnl)}（勝率${pct(wdBad[0].winRate)}）です。`, rule: `${wdBad[0].key}曜日は取引の量を半分にするか、休む日にしてみましょう。${mode === 'fx' && wdBad[0].key === '金' ? '金曜の夜はアメリカの雇用統計など大きな発表が多い日です。' : ''}${mode === 'fx' && wdBad[0].key === '月' ? '月曜の朝は週末のニュースで「窓」が開きやすい時間です。' : ''}` });
  }

  // ---------- 6. 負けた後の取引 ----------
  const afterLoss = [], afterTwo = [], quick = [], sizeUp = [];
  for (let i = 1; i < trades.length; i++) {
    const prev = trades[i - 1], cur = trades[i];
    if (prev.pnl >= 0) continue;
    afterLoss.push(cur);
    if (i >= 2 && trades[i - 2].pnl < 0) afterTwo.push(cur);
    const start = new Date(cur.openDate || cur.date), end = new Date(prev.date);
    if (hasTime([prev]) && start - end >= 0 && start - end < 30 * 60e3) quick.push(cur);
    if (prev.qty > 0 && cur.qty > prev.qty * 1.2) sizeUp.push(cur);
  }
  if (afterLoss.length >= 5) {
    const a = summarize(afterLoss);
    if (a.winRate < winRate - 0.08 || a.pnl < 0) {
      add({
        cat: '気持ち', level: a.pnl < 0 ? 'bad' : 'warn', impact: Math.max(0, -a.pnl),
        title: '負けた直後の取引で、さらに負けています',
        body: `負けた次の取引は${a.count}回で${yen(a.pnl)}、勝率は${pct(a.winRate)}（全体は${pct(winRate)}）です。${quick.length >= 3 ? `そのうち${quick.length}回は、負けてから30分以内に入っています（合計${yen(sum(quick.map((t) => t.pnl)))}）。` : ''}「取り返したい」という気持ちで、良くない場面で入っている可能性があります。`,
        rule: '負けたら最低30分は取引しない。2回続けて負けたら、その日はもう取引しない、と決めましょう。',
      });
    }
  }
  if (afterTwo.length >= 3) {
    const a = summarize(afterTwo);
    if (a.pnl < 0 && a.winRate < winRate) add({ cat: '気持ち', level: 'warn', impact: -a.pnl, title: '2連敗のあとの取引が良くありません', body: `2回続けて負けたあとの取引は${a.count}回で${yen(a.pnl)}（勝率${pct(a.winRate)}）です。`, rule: `2連敗したらその日は終わりにしていれば、${amt(-a.pnl)}の負けを防げていました。` });
  }
  if (sizeUp.length >= 3) {
    const a = summarize(sizeUp);
    if (a.pnl < 0) add({ cat: '気持ち', level: 'bad', impact: -a.pnl, title: '負けたあとに量を増やして、さらに負けています', body: `負けた直後に、前より多い量で取引したことが${a.count}回あり、合計${yen(a.pnl)}です。`, rule: '負けたあとは量を増やさない。むしろ半分に減らしましょう。「一発で取り返す」は大きな負けのいちばんの原因です。' });
  }

  // ---------- 7. 取引しすぎ ----------
  const dayMap = new Map();
  for (const t of trades) {
    const d = new Date(t.date).toDateString();
    if (!dayMap.has(d)) dayMap.set(d, []);
    dayMap.get(d).push(t);
  }
  const days = [...dayMap.values()].map((ts) => ({ n: ts.length, pnl: sum(ts.map((t) => t.pnl)) }));
  if (days.length >= 5) {
    const medN = median(days.map((d) => d.n));
    const th = Math.max(3, Math.ceil(medN * 2));
    const heavy = days.filter((d) => d.n >= th), normal = days.filter((d) => d.n < th);
    if (heavy.length >= 2 && normal.length >= 2) {
      const hAvg = sum(heavy.map((d) => d.pnl)) / heavy.length, nAvg = sum(normal.map((d) => d.pnl)) / normal.length;
      if (hAvg < 0 && hAvg < nAvg) {
        add({
          cat: '取引の回数', level: 'warn', impact: -sum(heavy.map((d) => d.pnl)) * 0.5,
          title: '取引の多い日ほど負けています',
          body: `1日に${th}回以上取引した日（${heavy.length}日）は、1日平均${yen(hAvg)}。それより少ない日は平均${yen(nAvg)}です。`,
          rule: `1日の取引は${Math.max(2, th - 1)}回までと決めましょう。回数が増えるほど、良くない場面でも入ってしまいがちです。`,
        });
      }
    }
  }

  // ---------- 8. 量 ----------
  const sized = trades.filter((t) => t.qty > 0);
  if (sized.length >= 8) {
    const medQ = median(sized.map((t) => t.qty));
    const big = sized.filter((t) => t.qty > medQ * 1.5), norm = sized.filter((t) => t.qty <= medQ * 1.5);
    if (big.length >= 3 && norm.length >= 3) {
      const b = summarize(big), n = summarize(norm);
      if (b.pnl < 0 && b.winRate < n.winRate) add({ cat: '量', level: 'warn', impact: -b.pnl, title: 'いつもより多い量で取引したときに負けています', body: `いつもの1.5倍より多い量の取引は${b.count}回で${yen(b.pnl)}（勝率${pct(b.winRate)}）。いつもの量では${yen(n.pnl)}（勝率${pct(n.winRate)}）です。`, rule: '自信があるときほど量を増やしがちですが、結果は逆になっています。量は毎回同じにしましょう。' });
    }
  }

  // ---------- 9. 買い・売り ----------
  const sides = groupBy(trades.filter((t) => t.side === '買' || t.side === '売'), (t) => t.side);
  if (sides.length === 2 && sides.every((r) => r.count >= 4)) {
    const [w, b] = sides.slice().sort((x, y) => x.pnl - y.pnl);
    if (w.pnl < 0 && b.pnl > 0) add({ cat: '向き', level: 'warn', impact: -w.pnl, title: `${w.key === '買' ? '買い' : '売り'}から入った取引が苦手です`, body: `${b.key === '買' ? '買い' : '売り'}は${b.count}回で${yen(b.pnl)}（勝率${pct(b.winRate)}）、${w.key === '買' ? '買い' : '売り'}は${w.count}回で${yen(w.pnl)}（勝率${pct(w.winRate)}）です。`, rule: `${w.key === '買' ? '買い' : '売り'}で入るのは、チャート画面の判定が「${w.key === '買' ? '上がりそう' : '下がりそう'}」のときだけにしましょう。` });
  }

  // ---------- 9b. やり方（現物・信用・空売り／為替は買い・売り）ごとの成績と、一番いいやり方 ----------
  const KIND = { cash: '現物', margin: '信用買い', short: '空売り', 買: '買いから入る', 売: '売りから入る' };
  const ways = (mode === 'fx' ? groupBy(trades.filter((t) => t.side === '買' || t.side === '売'), (t) => t.side) : groupBy(trades.filter((t) => t.kind), (t) => t.kind))
    .filter((r) => r.count >= 3).sort((a, b) => b.pnl - a.pnl);
  if (ways.length >= 2) {
    const best = ways[0], worst = ways[ways.length - 1];
    const list = ways.map((r) => `${KIND[r.key]}：${r.count}回・${yen(r.pnl)}（勝率${pct(r.winRate)}）`).join('／');
    add({
      cat: 'やり方', level: worst.pnl < 0 ? 'warn' : 'good', impact: worst.pnl < 0 ? -worst.pnl : 0,
      title: `あなたの取引で一番いいのは「${KIND[best.key]}」です`,
      body: `${list}。`,
      rule: worst.pnl < 0 ? `「${KIND[worst.key]}」はマイナスなので、しばらく控えて「${KIND[best.key]}」を中心にするのがおすすめです。「${KIND[worst.key]}」をやめていたら合計は<b>${yen(total - worst.pnl)}</b>でした。` : `どのやり方もプラスです。一番成績が良い「${KIND[best.key]}」を中心に続けましょう。`,
    });
  } else if (mode !== 'fx' && ways.length === 1) {
    add({ cat: 'やり方', level: 'good', title: `取引はすべて「${KIND[ways[0].key]}」でした`, body: `${ways[0].count}回・${yen(ways[0].pnl)}（勝率${pct(ways[0].winRate)}）。ほかのやり方（信用・空売り）を試した場合の過去の成績は「あなた専用」→「あなたのプラン」の「やり方で比べると」で見られます。` });
  }

  // ---------- 10. 銘柄 ----------
  const syms = groupBy(trades, (t) => t.symbol || '不明').filter((r) => r.count >= 3).sort((a, b) => a.pnl - b.pnl);
  if (syms.length >= 2 && syms[0].pnl < 0) {
    const best = syms[syms.length - 1];
    add({ cat: '銘柄', level: 'warn', impact: -syms[0].pnl * 0.7, title: `${esc2(syms[0].key)}で負けています`, body: `${esc2(syms[0].key)}は${syms[0].count}回で${yen(syms[0].pnl)}（勝率${pct(syms[0].winRate)}）。${best.pnl > 0 ? `いちばん得意な${esc2(best.key)}は${best.count}回で${yen(best.pnl)}（勝率${pct(best.winRate)}）です。` : ''}`, rule: `${esc2(syms[0].key)}はしばらくお休みして、${best.pnl > 0 ? `得意な${esc2(best.key)}に絞ると` : '得意な銘柄に絞ると'}成績が安定しやすいです。${esc2(syms[0].key)}をやめていたら合計は<b>${yen(total - syms[0].pnl)}</b>でした。` });
  }

  // ---------- 11. 連敗 ----------
  let streak = 0, maxStreak = 0, streakLoss = 0, cur = 0;
  for (const t of trades) {
    if (t.pnl < 0) { streak++; cur += t.pnl; if (streak > maxStreak) { maxStreak = streak; streakLoss = cur; } } else { streak = 0; cur = 0; }
  }
  if (maxStreak >= 4) add({ cat: '気持ち', level: 'warn', impact: -streakLoss * 0.3, title: `最大${maxStreak}連敗しています`, body: `いちばん長い連敗では、${maxStreak}回で${yen(streakLoss)}失いました。`, rule: '「3連敗したら、その日（その週）は取引をやめて、チャートの見直しだけする」と決めておくと、連敗が大きな損失になるのを防げます。' });

  // ---------- 12. 最近の調子 ----------
  if (trades.length >= 15) {
    const cut = Math.floor(trades.length * 0.7);
    const early = summarize(trades.slice(0, cut)), late = summarize(trades.slice(cut));
    const ea = early.pnl / early.count, la = late.pnl / late.count;
    if (la > ea && late.winRate >= early.winRate) add({ cat: '調子', level: 'good', title: '最近は良くなっています', body: `最近の${late.count}回は1回平均${yen(la)}（勝率${pct(late.winRate)}）で、それより前（1回平均${yen(ea)}、勝率${pct(early.winRate)}）より良くなっています。` });
    else if (la < ea && la < 0) add({ cat: '調子', level: 'warn', impact: -late.pnl * 0.3, title: '最近、調子が落ちています', body: `最近の${late.count}回は1回平均${yen(la)}（勝率${pct(late.winRate)}）で、それより前（1回平均${yen(ea)}、勝率${pct(early.winRate)}）より悪くなっています。`, rule: '相場の雰囲気が変わった可能性があります。しばらく量を減らして、勝てていたころの取引（時間帯・銘柄・持つ時間）と何が違うか見比べましょう。' });
  }

  const order = { bad: 0, warn: 1, good: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level] || b.impact - a.impact);
  const top = findings.filter((f) => f.level !== 'good' && f.rule).sort((a, b) => b.impact - a.impact).slice(0, 3);
  return {
    type, findings, top, sessions, hours, holding, timeKey: timed.length ? timeKey : null,
    weekdays: wd,
    stats: { count: trades.length, total, winRate, avgWin, avgLoss, payoff },
  };
}

// HTML に入れる前に < > & をエスケープ（本文は innerHTML で表示するため）
function esc2(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 実際の値動きと照らし合わせる ----------------
// 「含み益があったのに決済できず負けた」「高値で飛びついた」などを調べる

const FX_JA = { 米ドル: 'USD', ドル: 'USD', ユーロ: 'EUR', 英ポンド: 'GBP', ポンド: 'GBP', 豪ドル: 'AUD', NZドル: 'NZD', ニュージーランドドル: 'NZD', カナダドル: 'CAD', スイスフラン: 'CHF', フラン: 'CHF', 南アフリカランド: 'ZAR', 南アランド: 'ZAR', ランド: 'ZAR', メキシコペソ: 'MXN', ペソ: 'MXN', トルコリラ: 'TRY', リラ: 'TRY', 人民元: 'CNH', 円: 'JPY' };

// 取引の銘柄名 → 値動きを取りに行くコード
export function tradeSymbol(t, mode) {
  const s = String(t.symbol || '').normalize('NFKC').toUpperCase();
  if (mode === 'fx') {
    const m = s.match(/([A-Z]{3})\s*\/?\s*([A-Z]{3})/);
    if (m) return `${m[1]}${m[2]}=X`;
    const parts = String(t.symbol || '').normalize('NFKC').split(/[\/／]/).map((x) => x.trim());
    if (parts.length === 2 && FX_JA[parts[0]] && FX_JA[parts[1]]) return `${FX_JA[parts[0]]}${FX_JA[parts[1]]}=X`;
    return null;
  }
  if (mode === 'stock') {
    const c = String(t.code || '').match(/^(\d{3}[0-9A-Z])$/) || s.match(/(?:^|\D)(\d{3}[0-9A-Z])(?:\D|$)/);
    return c ? `${c[1]}.T` : null;
  }
  const u = (t.code || s).match(/^([A-Z][A-Z.\-]{0,6})$/);
  return u ? u[1] : null;
}

// どの足で調べるか（5分足は60日前まで、1時間足は2年前まで）
export function pickInterval(t, now = Date.now()) {
  const open = new Date(t.openDate).getTime(), close = new Date(t.date).getTime();
  const hold = close - open;
  if (!(hold > 0)) return null;
  if (now - open < 55 * 86400e3 && hold >= 15 * 60e3) return '5m';
  if (now - open < 700 * 86400e3 && hold >= 3 * 3600e3) return '60m';
  if (hold >= 3 * 86400e3) return '1d';
  return null;
}

const IV_SEC = { '5m': 300, '60m': 3600, '1d': 86400 };

/**
 * 1回の取引について、持っている間の「いちばん良かったとき」「いちばん悪かったとき」と、
 * 入る前の値動き（高いところで飛びついていないか）を調べる
 */
export function excursion(t, candles, interval) {
  const iv = IV_SEC[interval];
  const open = new Date(t.openDate).getTime() / 1000, close = new Date(t.date).getTime() / 1000;
  const during = candles.filter((c) => c.time + iv > open && c.time < close);
  if (!during.length || !(t.entry > 0) || !(t.price > 0) || t.price === t.entry) return null;
  const long = t.side === '買' ? true : t.side === '売' ? false : null;
  if (long == null) return null;
  const hi = Math.max(...during.map((c) => c.high)), lo = Math.min(...during.map((c) => c.low));
  const realized = long ? t.price - t.entry : t.entry - t.price;
  const perUnit = t.pnl / realized; // 値段が1動くと何円か（数量・円換算をまとめて）
  if (!(perUnit > 0) || !Number.isFinite(perUnit)) return null;
  const mfe = Math.max(0, (long ? hi - t.entry : t.entry - lo) * perUnit);
  const mae = Math.max(0, (long ? t.entry - lo : hi - t.entry) * perUnit);
  // 入る前の値動き（5分足なら6時間、1時間足なら2日、日足なら20日）
  const back = { '5m': 6 * 3600, '60m': 48 * 3600, '1d': 20 * 86400 }[interval];
  const before = candles.filter((c) => c.time < open && c.time >= open - back);
  let position = null, runUp = null;
  if (before.length >= 5) {
    const bh = Math.max(...before.map((c) => c.high)), bl = Math.min(...before.map((c) => c.low));
    if (bh > bl) position = (t.entry - bl) / (bh - bl);
    runUp = (t.entry - before[0].open) / before[0].open;
  }
  // 買いで「直前の高いところ」、売りで「直前の安いところ」で入ったか
  const chase = position != null && (long ? position >= 0.9 && runUp > 0 : position <= 0.1 && runUp < 0);
  return { mfe, mae, pnl: t.pnl, chase, position, runUp, long };
}

// 照らし合わせた結果から、アドバイスを作る
export function excursionAdvice(results, { avgWin, avgLoss }) {
  const r = results.filter(Boolean);
  if (r.length < 3) return null;
  const out = [];
  const total = sum(r.map((x) => x.pnl));
  const unit = Math.max(avgWin, 1);
  // 含み益があったのに負けで終わった
  const turned = r.filter((x) => x.pnl < 0 && x.mfe >= Math.max(unit * 0.5, -x.pnl * 0.5));
  if (turned.length) {
    const lost = -sum(turned.map((x) => x.pnl));
    out.push({
      cat: '利益確定', level: turned.length >= r.length * 0.15 ? 'bad' : 'warn', impact: lost,
      title: '含み益があったのに、負けで終わった取引があります',
      body: `${r.length}回のうち${turned.length}回は、一度は平均${amt(sum(turned.map((x) => x.mfe)) / turned.length)}の含み益があったのに、最後は合計${yen(-lost)}の負けで終わっています。「もっと上がる（下がる）はず」と待っているうちに戻ってしまった形です。`,
      rule: `含み益が${amt(unit)}（あなたの平均の利益）を超えたら、損切りの注文を「入った値段（建値）」まで動かしましょう。そうすれば、この${turned.length}回は負けずに済み、合計は${yen(total)} → <b>${yen(total + lost)}</b>になっていました。`,
    });
  }
  // 勝ったけれど、大きく取り逃した
  const left = r.filter((x) => x.pnl > 0 && x.mfe >= x.pnl * 2.5 && x.mfe - x.pnl >= unit);
  if (left.length) {
    const missed = sum(left.map((x) => x.mfe - x.pnl));
    out.push({
      cat: '利益確定', level: 'warn', impact: missed * 0.3,
      title: '含み益の多くを手放してから決済しています',
      body: `勝った取引のうち${left.length}回は、一番良いときに平均${amt(sum(left.map((x) => x.mfe)) / left.length)}の含み益があったのに、実際の利益は平均${amt(sum(left.map((x) => x.pnl)) / left.length)}でした（合計${amt(missed)}を取り逃し）。`,
      rule: '利益確定の目標の値段を、入るときに決めて注文（指値）を入れておきましょう。または「含み益が一番良いときから半分減ったら決済」というルールも有効です。',
    });
  }
  // 大きな含み損を我慢して勝った（危ない勝ち方）
  const endured = r.filter((x) => x.pnl > 0 && x.mae >= Math.max(avgLoss * 1.5, x.pnl));
  if (endured.length >= 2) {
    out.push({
      cat: '損切り', level: 'warn', impact: sum(endured.map((x) => x.mae)) * 0.2,
      title: '大きな含み損を我慢して、たまたま戻った勝ちがあります',
      body: `${endured.length}回は、一時は平均${amt(sum(endured.map((x) => x.mae)) / endured.length)}の含み損になってから、プラスで終わっています。今回は戻りましたが、戻らなかったときに大きな負けになる持ち方です。`,
      rule: '「戻るまで待つ」は、いつか大きな負けになります。損切りの値段は入るときに決めて、必ず注文を入れておきましょう。',
    });
  }
  // 高値・安値で飛びついた
  const chased = r.filter((x) => x.chase), calm = r.filter((x) => !x.chase && x.position != null);
  if (chased.length >= 3 && calm.length >= 3) {
    const c = summarize(chased), n = summarize(calm);
    if (c.pnl < n.pnl / Math.max(1, calm.length) * chased.length || c.winRate < n.winRate) {
      out.push({
        cat: '入るタイミング', level: c.pnl < 0 ? 'bad' : 'warn', impact: Math.max(0, -c.pnl),
        title: '上がりきった（下がりきった）ところで飛びついています',
        body: `直前の値動きの中で一番高いところ近くで買った（一番安いところ近くで売った）取引が${c.count}回あり、勝率${pct(c.winRate)}・合計${yen(c.pnl)}でした。それ以外の取引は勝率${pct(n.winRate)}・合計${yen(n.pnl)}です。「上がりすぎているけど、もっと上がるかも」と追いかけると、そこが天井になりやすいです。`,
        rule: '大きく上がった直後は買わず、少し下がって「支え」で止まるのを待ってから入りましょう（チャート画面の「下値の支え」の線が目安です）。',
      });
    }
  }
  if (!out.length) out.push({ cat: '利益確定', level: 'good', title: '決済のタイミングは悪くありません', body: `調べた${r.length}回では、含み益を大きく逃したり、含み益から負けに変わったりした取引は少なめでした。` });
  return { findings: out, checked: r.length, chased: chased.length };
}
