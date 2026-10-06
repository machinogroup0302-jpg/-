// 取引分析画面：CSV またはスクリーンショットから取引を読み込み、成績を分析する
import { $, esc, store, fmtYen, toast } from './util.js';
import { term } from './glossary.js';
import { parseCsv, findHeader, guessMapping, rowsToTrades, decodeFile, computeStats, insights, FIELD_LABELS, detectFormat, fileId } from './trades.js';

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
  trades = store.get(`trades_${tradeMode}`, []);
  $('map-box').innerHTML = '';
  $('trade-status').textContent = '';
  render();
}

function save() {
  if (!store.set(`trades_${tradeMode}`, trades)) toast('保存できませんでした（容量オーバーの可能性があります）');
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

function render() {
  const out = $('trade-result');
  const s = computeStats(trades);
  if (!s) {
    out.innerHTML = trades.length
      ? '<div class="card"><p class="empty">損益が入った取引（決済済み）が見つかりませんでした。CSVの列の割り当てを確認してください。</p></div>'
      : '';
    return;
  }
  const pct = (v) => `${Math.round(v * 100)}%`;
  const period = s.from ? `${new Date(s.from).toLocaleDateString('ja-JP')} 〜 ${new Date(s.to).toLocaleDateString('ja-JP')}` : '';
  out.innerHTML = `
    <div class="card">
      <h2>成績のまとめ<span class="sub">${esc(period)}</span></h2>
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
    <div class="card">
      <h2>あなたの癖・傾向</h2>
      <ul class="list">${insights(s).map((t) => `<li class="small">${esc(t)}</li>`).join('') || '<li class="small muted">取引がもう少し増えると傾向が分かります</li>'}</ul>
    </div>
    <div class="two-col">
      <div class="card"><h2>${tradeMode === 'fx' ? '通貨ペア別' : '銘柄別'}</h2>${bars(s.bySymbol.slice(0, 12), (k) => k)}</div>
      <div class="card"><h2>買い・売り別</h2>${bars(s.bySide, (k) => k)}
        <h3>曜日別</h3>${bars(s.byWeekday, (k) => k + '曜')}</div>
    </div>
    <div class="card" style="margin-top:12px"><h2>時間帯別</h2>${bars(s.byHour, (k) => k + '時')}</div>
    <div class="card">
      <h2>取引一覧<span class="sub">${trades.length}件</span></h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>日時</th><th>銘柄</th><th>売買</th><th class="r">損益</th></tr></thead><tbody>
      ${trades.slice().reverse().slice(0, 100).map((t) => `<tr><td class="small">${t.date ? new Date(t.date).toLocaleString('ja-JP', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td><td class="small">${esc(t.symbol)}</td><td class="small">${esc(t.side)}</td><td class="r ${t.pnl > 0 ? 'plus' : t.pnl < 0 ? 'minus' : ''}">${t.pnl != null ? fmtYen(t.pnl) : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      ${trades.length > 100 ? '<p class="small muted">新しい100件だけ表示しています</p>' : ''}
      <button class="btn danger block" id="trades-clear" style="margin-top:10px">読み込んだ取引をすべて消す</button>
    </div>`;

  $('trades-clear').onclick = () => {
    if (!confirm('読み込んだ取引をすべて消しますか？')) return;
    trades = [];
    save();
    render();
    $('trade-status').textContent = '';
  };
}

// 読み込んだ結果を分かりやすく表示する（最初の数件と、合計の確認）
function showLoaded(list, format, fileName) {
  const closed = list.filter((t) => t.pnl != null && t.pnl !== 0);
  const total = closed.reduce((a, t) => a + t.pnl, 0);
  const days = list.map((t) => t.date).filter(Boolean).sort();
  $('trade-status').innerHTML = `
    <div class="notice" style="margin-top:4px">
      <p style="margin:0 0 6px"><b>✓ 「${esc(fileName)}」を${esc(format.name)}として読み込みました</b></p>
      <div class="grid2" style="margin-bottom:6px">
        <div class="stat"><div class="label">損益が確定した取引</div><div class="value">${closed.length}件</div></div>
        <div class="stat"><div class="label">損益の合計</div><div class="value ${total >= 0 ? 'plus' : 'minus'}">${fmtYen(total)}</div></div>
      </div>
      <p class="small" style="margin:0 0 6px">期間：${days.length ? `${new Date(days[0]).toLocaleDateString('ja-JP')} 〜 ${new Date(days[days.length - 1]).toLocaleDateString('ja-JP')}` : '—'}</p>
      <p class="small muted" style="margin:0">証券会社・FX会社の画面に出ている「損益の合計」と同じになっているか確認してください。違う場合は、下の「うまく読めないとき」で列を選び直せます。</p>
    </div>`;
}

function addTrades(list, fileKey, format, fileName) {
  // 同じファイルを読み込み直したときは、前回の分を入れ替える（同じ値の取引も別々に数える）
  trades = [...trades.filter((t) => t.file !== fileKey), ...list.map((t) => ({ ...t, file: fileKey }))]
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  save();
  showLoaded(list, format, fileName);
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
    addTrades(rowsToTrades(rows, headerIndex, m), fileKey, format, fileName);
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
  if (map.pnl != null && map.date != null) {
    const list = rowsToTrades(rows, h, map);
    if (!list.length) { showMapping(rows, h, map, fileKey, format, file.name, true); return; }
    addTrades(list, fileKey, format, file.name);
    showMapping(rows, h, map, fileKey, format, file.name);
  } else {
    $('trade-status').textContent = '';
    showMapping(rows, h, map, fileKey, format, file.name, true);
  }
}


export function initTradesView() {
  $('csv-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) onCsv(f).catch((err) => toast(err.message));
    e.target.value = '';
  });
  render();
}
