// 取引分析画面：CSV またはスクリーンショットから取引を読み込み、成績を分析する
import { $, esc, store, fmtYen, toast, api } from './util.js';
import { term } from './glossary.js';
import { saveSynced, getProfile } from './favorites.js';
import { wayOf, forMode } from './plan.js';
import { coach, fmtDuration, tradeSymbol, pickInterval, excursion, excursionAdvice } from './tradecoach.js';
import { parseCsv, findHeader, guessMapping, rowsToTrades, decodeFile, computeStats, FIELD_LABELS, detectFormat, fileId, execToTrades, mergeTrades, dedupeTrades } from './trades.js';

// 為替と株の取引は別々に保存する
const isFxTrade = (sym) => /[A-Z]{3}\s*\/?\s*[A-Z]{3}/i.test(sym || '') || /円|ドル|ユーロ|ポンド|ランド|ペソ|リラ|フラン/.test(sym || '');
(function migrate() {
  const old = store.get('trades', null);
  if (!old || store.get('trades_fx', null) || store.get('trades_stock', null)) return;
  store.set('trades_fx', old.filter((t) => isFxTrade(t.symbol)));
  store.set('trades_stock', old.filter((t) => !isFxTrade(t.symbol)));
})();
let tradeMode = ['fx', 'stock', 'us'].includes(store.get('mode', 'fx')) ? store.get('mode', 'fx') : 'fx';
let trades = store.get(`trades_${tradeMode}`, []);

export function setTradesMode(mode) {
  tradeMode = mode;
  fixDupes(); // サーバーからそろえた後にも、2回入った取引がないか見る
  $('map-box').innerHTML = '';
  $('trade-status').textContent = '';
  render();
}

function save() {
  if (!saveSynced(`trades_${tradeMode}`, trades)) toast('保存できませんでした（容量オーバーの可能性があります）');
}

function bars(groups, labelFn) {
  const max = Math.max(...groups.map((g) => Math.abs(g.pnl)), 1);
  return `<div class="bars">${groups.map((g) => {
    const w = (Math.abs(g.pnl) / max) * 50;
    const color = g.pnl >= 0 ? 'var(--up)' : 'var(--down)';
    const left = g.pnl >= 0 ? 50 : 50 - w;
    return `<div class="bar"><span>${esc(labelFn(g.key))}</span>
      <span class="track"><span class="fill" style="left:${left}%;width:${w}%;background:${color}"></span></span>
      <span class="val ${g.pnl >= 0 ? 'plus' : 'minus'}">${fmtYen(g.pnl)}</span></div>`;
  }).join('')}</div>`;
}

function equitySvg(curve) {
  if (curve.length < 2) return '';
  const W = 600, H = 160, pad = 6;
  const vals = curve.map((c) => c.equity);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2);
  const x = (i) => pad + (i / (curve.length - 1)) * (W - pad * 2);
  const d = curve.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(c.equity).toFixed(1)}`).join('');
  const color = vals[vals.length - 1] >= 0 ? 'var(--up)' : 'var(--down)';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="160" preserveAspectRatio="none" role="img" aria-label="損益の推移">
    <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--border)" stroke-dasharray="4 4"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}


const LEVEL = { bad: ['要注意', 'danger', '✕'], warn: ['直すと伸びる', 'warn', '！'], good: ['できている', 'ok', '◯'] };

function findingHtml(f) {
  const [label, cls, mark] = LEVEL[f.level];
  return `<li class="finding ${f.level}">
    <div class="li-head"><span class="name"><span class="mark ${cls}">${mark}</span>${esc(f.title)}</span><span class="badge ${cls}">${esc(f.cat)}</span></div>
    <p class="small" style="margin:4px 0">${f.body}</p>
    ${f.rule ? `<p class="small rule"><b>こうしてみよう：</b>${f.rule}</p>` : ''}
  </li>`;
}

function sessionTable(rows) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>時間帯</th><th class="r">回数</th><th class="r">勝率</th><th class="r">損益</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="small">${esc(String(r.key))}</td><td class="r">${r.count}</td><td class="r">${Math.round(r.winRate * 100)}%</td><td class="r ${r.pnl >= 0 ? 'plus' : 'minus'}">${fmtYen(r.pnl)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function coachHtml(c) {
  if (!c) return '<div class="card"><h2>アドバイス</h2><p class="small muted">取引が3回以上になると、くせやアドバイスが出ます。</p></div>';
  const [, tcls] = LEVEL[c.type.level];
  const timeNote = c.timeKey === 'openDate' ? '取引を始めた時刻で分けています' : c.timeKey === 'date' ? '決済した時刻で分けています' : '';
  return `
    <div class="card">
      <h2>あなたの取引タイプ</h2>
      <p style="margin:0 0 6px"><span class="badge ${tcls}" style="font-size:14px">${esc(c.type.name)}</span></p>
      <p class="small" style="margin:0">${esc(c.type.text)}</p>
    </div>
    ${c.top.length ? `<div class="card">
      <h2>まず直したいこと<span class="sub">効果が大きい順</span></h2>
      <ol class="top-fix">${c.top.map((f) => `<li><b>${esc(f.title)}</b><p class="small" style="margin:4px 0 0">${f.rule}</p></li>`).join('')}</ol>
    </div>` : ''}
    <div class="card">
      <h2>くわしい分析<span class="sub">${c.findings.length}項目</span></h2>
      <ul class="list findings" id="coach-list">${c.findings.slice(0, 4).map(findingHtml).join('')}</ul>
      ${c.findings.length > 4 ? `<details class="more-box"><summary>ほかの分析も見る（あと${c.findings.length - 4}項目）</summary><ul class="list findings">${c.findings.slice(4).map(findingHtml).join('')}</ul></details>` : ''}
    </div>
    <div class="card">
      <h2>実際の値動きと照らし合わせる</h2>
      <p class="small muted" style="margin:0 0 6px">持っていた間に一番良かったとき・悪かったときと比べて、「利益確定が遅れて負けた」「高いところで飛びついた」などを調べます。</p>
      <div id="exc-box"><p class="small muted">準備中…</p></div>
    </div>
    ${c.sessions.length ? `<div class="card">
      <h2>時間帯別の成績<span class="sub">${esc(timeNote)}</span></h2>
      ${sessionTable(c.sessions)}
      <h3>1時間ごと</h3>${bars(c.hours, (k) => k + '時')}
    </div>` : '<div class="card"><h2>時間帯別の成績</h2><p class="small muted">このCSVには時刻（何時何分）が入っていないため、時間帯の分析はできません。時刻が入った「約定履歴」のCSVを読み込むと分析できます。</p></div>'}
    ${c.holding ? `<div class="card">
      <h2>持っていた時間</h2>
      <div class="grid2" style="margin-bottom:8px">
        <div class="stat"><div class="label">勝った取引（ふつう）</div><div class="value plus">${c.holding.win ? fmtDuration(c.holding.win) : '—'}</div></div>
        <div class="stat"><div class="label">負けた取引（ふつう）</div><div class="value minus">${c.holding.loss ? fmtDuration(c.holding.loss) : '—'}</div></div>
      </div>
      ${sessionTable(c.holding.buckets).replace('<th>時間帯</th>', '<th>持っていた時間</th>')}
    </div>` : ''}`;
}

let excKey = '';
// 取引ごとに、持っていた間の値動きを取ってきて調べる
async function runExcursions(c) {
  const box = $('exc-box');
  const list = trades.filter((t) => t.pnl && t.openDate && t.entry > 0 && t.price > 0).slice(-300);
  if (!list.length) {
    box.innerHTML = `<p class="small muted">${trades.some((t) => t.openDate) ? '値段（新規の値段と決済の値段）が入っている取引がないため、調べられません。' : 'このCSVには「持ち始めた日時」（新規約定日時など）が入っていないため、調べられません。LION FX の「決済履歴」のように、新規と決済の両方の日時・値段が入ったCSVを読み込むと分析できます。（前に読み込んだ取引は、同じCSVをもう一度読み込み直すと分析できるようになります）'}</p>`;
    return;
  }
  const groups = new Map();
  for (const t of list) {
    const sym = tradeSymbol(t, tradeMode), iv = pickInterval(t);
    if (!sym || !iv) continue;
    const k = `${sym}|${iv}`;
    if (!groups.has(k)) groups.set(k, { sym, iv, list: [] });
    groups.get(k).list.push(t);
  }
  if (!groups.size) {
    box.innerHTML = '<p class="small muted">持っていた時間が短すぎる（数分）取引や、古すぎる取引しかないため、細かい値動きと照らし合わせられませんでした（5分足は約2か月前まで、1時間足は約2年前までの取引が対象です）。</p>';
    return;
  }
  const key = `${tradeMode}|${list.length}|${list[list.length - 1].date}`;
  excKey = key;
  box.innerHTML = '<p class="small muted"><span class="spinner"></span> 値動きを取ってきて調べています…</p>';
  const results = [];
  const back = { '5m': 6 * 3600, '60m': 48 * 3600, '1d': 20 * 86400 };
  let failed = 0;
  for (const g of [...groups.values()].slice(0, 25)) {
    const from = Math.min(...g.list.map((t) => new Date(t.openDate).getTime() / 1000)) - back[g.iv] - 86400;
    const to = Math.max(...g.list.map((t) => new Date(t.date).getTime() / 1000)) + 3600;
    try {
      const d = await api(`/api/history?symbol=${encodeURIComponent(g.sym)}&interval=${g.iv}&from=${Math.floor(from)}&to=${Math.ceil(to)}`);
      for (const t of g.list) results.push(excursion(t, d.candles, g.iv));
    } catch { failed++; }
    if (excKey !== key) return;
  }
  const adv = excursionAdvice(results, c.stats);
  if (!adv) {
    box.innerHTML = `<p class="small muted">照らし合わせられた取引が少なすぎました${failed ? `（${failed}件の値動きを取得できませんでした）` : ''}。</p>`;
    return;
  }
  box.innerHTML = `<p class="small muted" style="margin:0 0 6px">${adv.checked}回の取引を、実際の値動きと照らし合わせました${failed ? `（${failed}件は値動きを取得できませんでした）` : ''}。</p>
    <ul class="list findings">${adv.findings.map(findingHtml).join('')}</ul>`;
}

// 月ごとの一覧：どの月の取引を入れたか・まだか（月に1回、先月の分を入れる）
const ymOf = (d) => { const t = new Date(d); return Number.isNaN(t.getTime()) ? null : new Date(t.getTime() + 9 * 3600e3).toISOString().slice(0, 7); };
function renderMonths() {
  const el = $('trade-months');
  if (!el) return;
  const count = {};
  for (const t of trades) { const k = ymOf(t.date || t.openDate); if (k) count[k] = (count[k] || 0) + 1; }
  const now = new Date(Date.now() + 9 * 3600e3);
  const months = [];
  for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push(d.toISOString().slice(0, 7)); }
  const last = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  const label = (ym) => `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月`;
  const period = (ym) => `${ym.replace('-', '/')}/01〜${ym.replace('-', '/')}/${last(ym)}`;
  const prev = months[1];
  const any = Object.keys(count).length;
  // 入れたCSVの期間の中で取引がなかった月は「取引なし」（入れ忘れではない）
  const ks = Object.keys(count).sort();
  const covered = (ym) => any && ym > ks[0] && ym < ks[ks.length - 1];
  el.innerHTML = `${any && !count[prev] && !covered(prev) ? `<p class="notice" style="margin:8px 0">📅 <b>${label(prev)}分がまだです。</b>証券会社の取引履歴で、期間を <b>${period(prev)}</b> にしてCSVを保存し、下の「${label(prev)}」の行から入れてください。</p>` : ''}
    <details class="more-box"${any ? '' : ' open'}><summary>📅 月ごとの一覧（月に1回、先月の分を入れる）</summary>
    <ul class="list" style="margin-top:6px">${months.map((ym, i) => `<li class="row" style="justify-content:space-between;align-items:center;gap:8px">
      <span><b>${label(ym)}</b>${i === 0 ? '<span class="small muted">（今月・月末に入れる）</span>' : ''}<br><span class="small muted">期間 ${period(ym)}</span></span>
      <span class="row" style="gap:8px;align-items:center">${count[ym] ? `<span class="small plus">✅ ${count[ym]}件</span>` : covered(ym) ? '<span class="small muted">✅ 取引なし</span>' : `<span class="small muted">${i === 0 ? '—' : '⬜ まだ'}</span>`}
        <label class="btn small">${count[ym] ? '入れ直す' : 'CSVを入れる'}<input type="file" class="month-file" accept=".csv,.txt,text/csv" hidden></label></span></li>`).join('')}</ul>
    <p class="small muted" style="margin:4px 0 0">同じ取引を2回入れても、重ならないようにしています。何か月分かまとめたCSVでもOKです。</p></details>`;
  el.querySelectorAll('.month-file').forEach((inp) => inp.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) onCsv(f).catch((err) => toast(err.message));
    e.target.value = '';
  }));
}

// 分析する期間（全部だと、最近の取引を足してもほとんど変わらないので、最近だけも見られるように）
const PERIODS = [['all', '全部'], ['90', '最近3か月'], ['30', '最近1か月']];
let period = store.get('tradePeriod', 'all');
const lastTime = (list) => Math.max(0, ...list.map((t) => Date.parse(t.date) || 0));
function inPeriod(list, days) {
  if (days === 'all') return list;
  const end = lastTime(list), from = end - Number(days) * 86400e3;
  return list.filter((t) => (Date.parse(t.date) || 0) > from);
}

// 最近1か月と、それより前の比べ（良くなった・悪くなった）
function changeHtml(all) {
  const end = lastTime(all);
  if (!end) return '';
  const recent = all.filter((t) => Date.parse(t.date) > end - 30 * 86400e3);
  const before = all.filter((t) => Date.parse(t.date) <= end - 30 * 86400e3);
  const a = computeStats(recent), b = computeStats(before);
  if (!a || !b || a.count < 3 || b.count < 3) return '';
  const pct = (v) => `${Math.round(v * 100)}%`;
  const per = (st) => st.totalPnl / st.count;
  const rows = [
    ['勝率', pct(b.winRate), pct(a.winRate), a.winRate - b.winRate, 0.03],
    ['1回の平均の勝ち', fmtYen(b.avgWin), fmtYen(a.avgWin), a.avgWin - b.avgWin, b.avgWin * 0.1],
    ['1回の平均の負け', fmtYen(-b.avgLoss), fmtYen(-a.avgLoss), b.avgLoss - a.avgLoss, b.avgLoss * 0.1],
    ['損益比（勝ち÷負け）', b.payoff?.toFixed(2) ?? '—', a.payoff?.toFixed(2) ?? '—', (a.payoff ?? 0) - (b.payoff ?? 0), 0.1],
    ['1回あたりの損益', fmtYen(Math.round(per(b))), fmtYen(Math.round(per(a))), per(a) - per(b), Math.abs(per(b)) * 0.1 + 100],
  ];
  const mark = (d, th) => `<span style="white-space:nowrap">${d > th ? '<span class="plus">⬆良</span>' : d < -th ? '<span class="minus">⬇悪</span>' : '<span class="muted">→同じ</span>'}</span>`;
  const good = rows.filter(([, , , d, th]) => d > th).length, bad = rows.filter(([, , , d, th]) => d < -th).length;
  const head = good > bad ? '前より良くなっています 👍' : bad > good ? '前より悪くなっています。下の「まず直したいこと」を見直しましょう' : '前とあまり変わっていません';
  return `<div class="card">
    <h2>最近の変化<span class="sub">最近1か月（${a.count}回）と、それより前（${b.count}回）</span></h2>
    <p style="margin:0 0 8px"><b>${head}</b></p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th class="r">前</th><th class="r">最近1か月</th><th class="r"></th></tr></thead><tbody>
    ${rows.map(([k, x, y, d, th]) => `<tr><td class="small">${k}</td><td class="r small">${x}</td><td class="r small"><b>${y}</b></td><td class="r small">${mark(d, th)}</td></tr>`).join('')}
    </tbody></table></div>
  </div>`;
}

function render() {
  renderMonths();
  const out = $('trade-result');
  const all = trades;
  // ここから下の分析は、選んだ期間の取引だけで行う
  const trades0 = inPeriod(all, period);
  const s = computeStats(trades0);
  const seg = `<div class="seg" id="trade-period" style="margin-bottom:10px">${PERIODS.map(([k, v]) => `<button data-p="${k}" aria-pressed="${k === period}">${v}</button>`).join('')}</div>`;
  const bindPeriod = () => {
    $('trade-period').onclick = (e) => {
      const b = e.target.closest('button[data-p]');
      if (!b) return;
      period = b.dataset.p;
      store.set('tradePeriod', period);
      render();
    };
  };
  if (!s) {
    out.innerHTML = !all.length ? ''
      : period !== 'all' ? `${seg}<div class="card"><p class="empty">この期間に決済した取引はありません。</p></div>`
      : '<div class="card"><p class="empty">損益が入った取引（決済済み）が見つかりませんでした。CSVの列の割り当てを確認してください。</p></div>';
    if (all.length && period !== 'all') bindPeriod();
    return;
  }
  const pct = (v) => `${Math.round(v * 100)}%`;
  const bw = getProfile().bestWay?.[tradeMode];
  const pf = forMode(getProfile(), tradeMode);
  const c = coach(trades0, tradeMode, { siteBest: bw ? wayOf(tradeMode, bw).label : '', budget: pf.budget || 0, riskPct: pf.riskPct || 2 });
  const range = s.from ? `${new Date(s.from).toLocaleDateString('ja-JP')} 〜 ${new Date(s.to).toLocaleDateString('ja-JP')}` : '';
  out.innerHTML = `
    ${seg}
    ${changeHtml(all)}
    <div class="card">
      <h2>成績のまとめ<span class="sub">${esc(range)}</span></h2>
      <div class="grid2">
        <div class="stat"><div class="label">合計損益</div><div class="value ${s.totalPnl >= 0 ? 'plus' : 'minus'}">${fmtYen(s.totalPnl)}</div></div>
        <div class="stat"><div class="label">${term('winRate', '勝率')}（${s.count}回）</div><div class="value">${pct(s.winRate)}</div></div>
        <div class="stat"><div class="label">平均利益</div><div class="value plus">${fmtYen(s.avgWin)}</div></div>
        <div class="stat"><div class="label">平均損失</div><div class="value minus">${fmtYen(-s.avgLoss)}</div></div>
        <div class="stat"><div class="label">${term('payoff', '損益比（利益÷損失）')}</div><div class="value">${s.payoff != null ? s.payoff.toFixed(2) : '—'}</div></div>
        <div class="stat"><div class="label">${term('pf', '利益÷損失の合計（PF）')}</div><div class="value">${s.profitFactor != null ? s.profitFactor.toFixed(2) : '—'}</div></div>
        <div class="stat"><div class="label">${term('drawdown', '一番減ったときの額')}</div><div class="value minus">${fmtYen(-s.maxDrawdown)}</div></div>
        <div class="stat"><div class="label">${term('streak', '最大連敗')}</div><div class="value">${s.maxLossStreak}回</div></div>
      </div>
      <h3>損益の推移</h3>${equitySvg(s.curve)}
    </div>
    ${coachHtml(c)}
    <div class="two-col">
      <div class="card"><h2>${tradeMode === 'fx' ? '通貨ペア別' : '銘柄別'}</h2>${bars(s.bySymbol.slice(0, 12), (k) => k)}</div>
      <div class="card"><h2>買い・売り別</h2>${bars(s.bySide, (k) => k)}
        <h3>曜日別</h3>${bars(s.byWeekday, (k) => k + '曜')}</div>
    </div>
    <div class="card">
      <h2>取引一覧<span class="sub">${trades.length}件</span></h2>
      <details class="more-box"><summary>取引の一覧を見る（新しい順）</summary>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>日時</th><th>銘柄</th><th>売買</th><th class="r">損益</th></tr></thead><tbody>
      ${trades.slice().reverse().slice(0, 100).map((t) => `<tr><td class="small">${t.date ? new Date(t.date).toLocaleString('ja-JP', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td><td class="small">${esc(t.symbol)}</td><td class="small">${esc(t.side)}</td><td class="r ${t.pnl > 0 ? 'plus' : t.pnl < 0 ? 'minus' : ''}">${t.pnl != null ? fmtYen(t.pnl) : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      ${trades.length > 100 ? '<p class="small muted">新しい100件だけ表示しています</p>' : ''}
      </details>
      <button class="btn danger block" id="trades-clear" style="margin-top:10px">読み込んだ取引をすべて消す</button>
    </div>`;

  if (c) runExcursions(c);
  bindPeriod();
  $('trades-clear').onclick = () => {
    if (!confirm('読み込んだ取引をすべて消しますか？')) return;
    trades = [];
    save();
    render();
    $('trade-status').textContent = '';
  };
}

// 読み込んだ結果を分かりやすく表示する（最初の数件と、合計の確認）
function showLoaded(list, format, fileName, moved = [], skipped = 0) {
  if (!list.length && moved.length) {
    $('trade-status').innerHTML = `<div class="notice" style="margin-top:4px"><p style="margin:0"><b>✓ 「${esc(fileName)}」を読み込みました</b></p><p class="small" style="margin:4px 0 0">📦 このファイルは${esc(moved.join('・'))}の取引だったので、そちらの画面に自動で入れました。上の切り替えで見られます。</p></div>`;
    return;
  }
  const closed = list.filter((t) => t.pnl != null && t.pnl !== 0);
  const total = closed.reduce((a, t) => a + t.pnl, 0);
  const days = list.map((t) => t.date).filter(Boolean).sort();
  $('trade-status').innerHTML = `
    <div class="notice" style="margin-top:4px">
      <p style="margin:0 0 6px"><b>✓ 「${esc(fileName)}」を${esc(format.name)}として読み込みました</b></p>
      ${moved.length ? `<p class="small" style="margin:0 0 6px">📦 ほかの市場の取引（${esc(moved.join('・'))}）は、それぞれの画面（上の切り替え）に自動で入れました。</p>` : ''}
      <div class="grid2" style="margin-bottom:6px">
        <div class="stat"><div class="label">損益が確定した取引</div><div class="value">${closed.length}件</div></div>
        <div class="stat"><div class="label">損益の合計</div><div class="value ${total >= 0 ? 'plus' : 'minus'}">${fmtYen(total)}</div></div>
      </div>
      <p class="small" style="margin:0 0 6px">期間：${days.length ? `${new Date(days[0]).toLocaleDateString('ja-JP')} 〜 ${new Date(days[days.length - 1]).toLocaleDateString('ja-JP')}` : '—'}</p>
      ${list.some((t) => t.est) ? `<p class="small" style="margin:0 0 6px">⏳ 返したばかりで楽天証券の損益がまだ出ていない信用の取引が <b>${list.filter((t) => t.est).length}件</b> あります。建てた順に組み合わせて計算した目安なので、数日後に取引履歴を読み込み直すと楽天証券と同じ数字になります。</p>` : ''}
      ${skipped ? `<p class="small" style="margin:0 0 6px">⚠️ このファイルより前に買った株を売った取引が <b>${skipped}件</b> ありました。買った値段がファイルに入っていないので、<b>損益に入れていません</b>。楽天証券の数字と合わせるには、楽天証券の「実現損益」のCSVも読み込んでください（そちらの損益を優先して使います）。</p>` : ''}
      <p class="small muted" style="margin:0">証券会社・FX会社の画面に出ている「損益の合計」と同じになっているか確認してください。違う場合は、下の「うまく読めないとき」で列を選び直せます。</p>
    </div>`;
}

// 取引がどの市場のものか：為替の通貨ペア・日本株（4けたのコード）・米国株（英字のティッカー）
const MODE_NAME = { fx: '為替', stock: '日本株', us: '米国株' };
const CCY = 'USD|EUR|GBP|AUD|NZD|CAD|CHF|JPY|ZAR|MXN|TRY|CNH|CNY|HKD|SGD|NOK|SEK|PLN|HUF';
const FX_PAIR = new RegExp(`^(${CCY})\\s*/?\\s*(${CCY})$`);
function marketOf(t) {
  const code = String(t.code || '').normalize('NFKC').trim().toUpperCase();
  const sym = String(t.symbol || '').normalize('NFKC').trim().toUpperCase();
  // 為替：通貨ペア（USDJPY・USD/JPY）か、「米ドル/円」のような書き方
  if (FX_PAIR.test(code) || FX_PAIR.test(sym) || (!code && /(円|ドル|ユーロ|ポンド|ランド|ペソ|リラ|フラン)\s*\/\s*(円|ドル|ユーロ|ポンド|ランド|ペソ|リラ|フラン)/.test(sym))) return 'fx';
  // 日本株：4けたのコード（7203・186A）
  if (/^\d{3}[0-9A-Z]$/.test(code) || /^\d{3}[0-9A-Z](\.T)?$/.test(sym)) return 'stock';
  // 米国株：英字のティッカー（AAPL・BRK.B）
  if (/^[A-Z][A-Z.\-]{0,6}$/.test(code) || (!code && /^[A-Z][A-Z.\-]{0,6}$/.test(sym))) return 'us';
  return tradeMode;
}

function addTrades(list, fileKey, format, fileName, skipped = 0) {
  // 市場ごとに分けて、それぞれの取引に入れる（日本株のCSVに米国株が入っていても、米国株のほうに入る）
  const groups = { fx: [], stock: [], us: [] };
  for (const t of list) groups[marketOf(t)].push(t);
  const moved = [];
  for (const [m, part] of Object.entries(groups)) {
    if (!part.length) continue;
    const cur = m === tradeMode ? trades : store.get(`trades_${m}`, []);
    // 同じファイルを読み込み直したときは前回の分を入れ替え、期間が重なる別のファイルにもう入っている取引は
    // 2回数えない（楽天の「実現損益」のCSVがあれば、その損益を優先する）
    const next = mergeTrades(cur, part, fileKey);
    if (m === tradeMode) { trades = next; save(); } else {
      if (!saveSynced(`trades_${m}`, next)) toast('保存できませんでした（容量オーバーの可能性があります）');
      moved.push(`${MODE_NAME[m]} ${part.length}件`);
    }
  }
  showLoaded(groups[tradeMode], format, fileName, moved, skipped);
  render();
}

function showMapping(rows, headerIndex, map, fileKey, format, fileName, open = false) {
  const header = rows[headerIndex];
  const opts = (sel) => `<option value="">（使わない）</option>${header.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `列${i + 1}`)}</option>`).join('')}`;
  const sample = rows.slice(headerIndex + 1, headerIndex + 4);
  $('map-box').innerHTML = `
    <details ${open ? 'open' : ''} class="small">
      <summary>${open ? '<b>列を選んでください（自動で判別できませんでした）</b>' : 'うまく読めないとき（列を選び直す）'}</summary>
      <div class="notice" style="margin-top:6px">
        ${Object.entries(FIELD_LABELS).map(([k, label]) => `<div class="row" style="margin-bottom:6px"><span class="small" style="width:96px">${label}</span><select class="input grow" data-field="${k}">${opts(map[k])}</select></div>`).join('')}
        <p class="small muted">ファイルの最初の行：</p>
        <div class="tbl-wrap"><table class="tbl"><tr>${header.map((h) => `<th class="small">${esc(h)}</th>`).join('')}</tr>${sample.map((r) => `<tr>${r.map((c) => `<td class="small">${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>
        <button class="btn primary block" id="map-ok" style="margin-top:8px">この列で読み込む</button>
      </div>
    </details>`;
  $('map-ok').onclick = () => {
    const m = {};
    $('map-box').querySelectorAll('select').forEach((x) => { if (x.value !== '') m[x.dataset.field] = Number(x.value); });
    if (m.pnl == null || m.date == null) { toast('「日時」と「損益」の列を選んでください'); return; }
    addTrades(rowsToTrades(rows, headerIndex, m).map((t) => (format.id === 'rakuten' ? { ...t, src: 'pl' } : t)), fileKey, format, fileName);
    showMapping(rows, headerIndex, m, fileKey, format, fileName);
  };
}

async function onCsv(file) {
  const text = decodeFile(await file.arrayBuffer());
  const rows = parseCsv(text);
  if (rows.length < 2) { toast('CSVの中身が読み取れませんでした'); return; }
  const h = findHeader(rows);
  const map = guessMapping(rows[h]);
  const format = detectFormat(rows[h]);
  const fileKey = fileId(text);
  // 楽天証券の「取引履歴」：買いと売りを組み合わせて損益を出す
  if (format.id === 'rakutenExec') {
    const list = execToTrades(rows, h);
    if (!list.length) { toast(list.skipped ? `売った取引${list.skipped}件は、買った値段がこのファイルに入っていないので数えられませんでした。楽天証券の「実現損益」のCSVを読み込んでください` : '決済した取引が見つかりませんでした（買っただけの取引は、売るまで数えません）'); return; }
    $('map-box').innerHTML = '';
    addTrades(list, fileKey, format, file.name, list.skipped);
    return;
  }
  if (map.pnl != null && map.date != null) {
    // 楽天証券の「実現損益」は証券会社が計算した損益なので、同じ取引がほかのファイルにあってもこちらを使う
    const list = rowsToTrades(rows, h, map).map((t) => (format.id === 'rakuten' ? { ...t, src: 'pl' } : t));
    if (!list.length) { showMapping(rows, h, map, fileKey, format, file.name, true); return; }
    addTrades(list, fileKey, format, file.name);
    showMapping(rows, h, map, fileKey, format, file.name);
  } else {
    $('trade-status').textContent = '';
    showMapping(rows, h, map, fileKey, format, file.name, true);
  }
}


// 前に違う市場に入ってしまった取引（米国株が為替に入っていた など）を、正しい市場に戻す
// 前に、期間が重なるファイルから同じ取引が2回入ってしまったものを1つにする
function fixDupes() {
  for (const m of ['fx', 'stock', 'us']) {
    const cur = store.get(`trades_${m}`, []);
    const next = dedupeTrades(cur);
    if (next.length !== cur.length) saveSynced(`trades_${m}`, next);
  }
  trades = store.get(`trades_${tradeMode}`, []);
}

function fixMisfiled() {
  const all = Object.fromEntries(['fx', 'stock', 'us'].map((m) => [m, store.get(`trades_${m}`, [])]));
  const moved = { fx: [], stock: [], us: [] };
  let changed = false;
  for (const m of Object.keys(all)) {
    all[m] = all[m].filter((t) => {
      const to = t.code ? marketOf(t) : m;
      if (to === m) return true;
      moved[to].push(t); changed = true; return false;
    });
  }
  if (!changed) return;
  for (const m of Object.keys(all)) {
    const next = [...all[m], ...moved[m]].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    saveSynced(`trades_${m}`, next);
  }
  trades = store.get(`trades_${tradeMode}`, []);
}

export function initTradesView() {
  fixMisfiled();
  fixDupes();
  $('csv-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) onCsv(f).catch((err) => toast(err.message));
    e.target.value = '';
  });
  render();
}
