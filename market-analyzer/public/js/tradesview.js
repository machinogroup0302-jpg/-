// 取引分析画面：CSV またはスクリーンショットから取引を読み込み、成績を分析する
import { api, $, esc, store, busy, fmtYen, toast, loadImage, imageToDataUrl } from './util.js';
import { parseCsv, findHeader, guessMapping, rowsToTrades, decodeFile, computeStats, insights, FIELD_LABELS } from './trades.js';

let trades = store.get('trades', []);

function save() {
  if (!store.set('trades', trades)) toast('保存できませんでした（容量オーバーの可能性があります）');
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
        <div class="stat"><div class="label">勝率（${s.count}回）</div><div class="value">${pct(s.winRate)}</div></div>
        <div class="stat"><div class="label">平均利益</div><div class="value plus">${fmtYen(s.avgWin)}</div></div>
        <div class="stat"><div class="label">平均損失</div><div class="value minus">${fmtYen(-s.avgLoss)}</div></div>
        <div class="stat"><div class="label">損益比（利益÷損失）</div><div class="value">${s.payoff != null ? s.payoff.toFixed(2) : '—'}</div></div>
        <div class="stat"><div class="label">プロフィットファクター</div><div class="value">${s.profitFactor != null ? s.profitFactor.toFixed(2) : '—'}</div></div>
        <div class="stat"><div class="label">最大ドローダウン</div><div class="value minus">${fmtYen(-s.maxDrawdown)}</div></div>
        <div class="stat"><div class="label">最大連敗</div><div class="value">${s.maxLossStreak}回</div></div>
      </div>
      <h3>損益の推移</h3>${equitySvg(s.curve)}
    </div>
    <div class="card">
      <h2>あなたの癖・傾向</h2>
      <ul class="list">${insights(s).map((t) => `<li class="small">${esc(t)}</li>`).join('') || '<li class="small muted">取引がもう少し増えると傾向が分かります</li>'}</ul>
      <button class="btn primary block" id="coach-btn" style="margin-top:10px">AIコーチにアドバイスをもらう</button>
      <div id="coach-out"></div>
    </div>
    <div class="two-col">
      <div class="card"><h2>銘柄・通貨ペア別</h2>${bars(s.bySymbol.slice(0, 12), (k) => k)}</div>
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
  $('coach-btn').onclick = async () => {
    const btn = $('coach-btn');
    busy(btn, true, 'AIが分析しています…');
    try {
      const { curve, ...rest } = s;
      const r = await api('/api/ai/coach', { method: 'POST', body: { stats: { ...rest, bySymbol: rest.bySymbol.slice(0, 15) } } });
      $('coach-out').innerHTML = `
        <p class="small" style="margin-top:10px">${esc(r.summary)}</p>
        <h3>良いところ</h3><ul class="small">${r.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <h3>直したい癖</h3><ul class="small">${r.weaknesses.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <h3>明日から守るルール</h3><ol class="small">${r.rules.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`;
    } catch (e) {
      $('coach-out').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    } finally {
      busy(btn, false);
    }
  };
}

function addTrades(list, label, batch = Date.now()) {
  // 同じ取引を二重に読み込まないようにする
  const key = (t) => `${t.date}|${t.symbol}|${t.side}|${t.qty}|${t.price}|${t.pnl}`;
  const seen = new Set(trades.map(key));
  const fresh = list.filter((t) => !seen.has(key(t))).map((t) => ({ ...t, batch }));
  trades = [...trades, ...fresh].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  save();
  $('trade-status').textContent = `${label}: ${fresh.length}件を追加しました（重複${list.length - fresh.length}件は除外）。合計${trades.length}件。`;
  render();
}

function showMapping(rows, headerIndex, map, batch) {
  const header = rows[headerIndex];
  const opts = (sel) => `<option value="">（使わない）</option>${header.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `列${i + 1}`)}</option>`).join('')}`;
  $('map-box').innerHTML = `
    <div class="notice">
      <p style="margin:0 0 8px"><b>列の割り当てを確認してください</b>（自動で判別しました）</p>
      ${Object.entries(FIELD_LABELS).map(([k, label]) => `<div class="row" style="margin-bottom:6px"><span class="small" style="width:96px">${label}</span><select class="input grow" data-field="${k}">${opts(map[k])}</select></div>`).join('')}
      <button class="btn primary block" id="map-ok">この割り当てで読み込む</button>
    </div>`;
  $('map-ok').onclick = () => {
    const m = {};
    $('map-box').querySelectorAll('select').forEach((s) => { if (s.value !== '') m[s.dataset.field] = Number(s.value); });
    if (m.pnl == null) { toast('「損益」の列を選んでください'); return; }
    // 同じファイルを読み込み直すときは、前回の読み込み分を入れ替える
    if (batch) trades = trades.filter((t) => t.batch !== batch);
    addTrades(rowsToTrades(rows, headerIndex, m), 'CSV', batch);
    $('map-box').innerHTML = '';
  };
}

async function onCsv(file) {
  const rows = parseCsv(decodeFile(await file.arrayBuffer()));
  if (rows.length < 2) { toast('CSVの中身が読み取れませんでした'); return; }
  const h = findHeader(rows);
  const map = guessMapping(rows[h]);
  const batch = Date.now();
  if (map.pnl != null && map.date != null && map.symbol != null) {
    addTrades(rowsToTrades(rows, h, map), 'CSV', batch);
    // 割り当てが違っていたときに直せるよう、確認欄も出しておく
    showMapping(rows, h, map, batch);
    $('map-box').querySelector('.notice p b').textContent = '読み込みました。結果がおかしい場合は、列の割り当てを直して読み込み直せます';
  } else {
    showMapping(rows, h, map, batch);
  }
}

async function onImages(files) {
  const status = $('trade-status');
  let all = [];
  for (let i = 0; i < files.length; i++) {
    status.innerHTML = `<span class="spinner"></span> AIが読み取り中… ${i + 1} / ${files.length}`;
    try {
      const img = await loadImage(files[i]);
      const r = await api('/api/ai/trades-image', { method: 'POST', body: { image: imageToDataUrl(img) } });
      all = all.concat(r.trades.filter((t) => t.is_closed).map((t) => ({
        date: (() => { const d = new Date(t.datetime.replace(/\//g, '-').replace(' ', 'T')); return Number.isNaN(d.getTime()) ? null : d.toISOString(); })(),
        symbol: t.symbol, side: t.side, qty: t.quantity, price: t.price, pnl: t.pnl,
      })));
    } catch (e) {
      status.textContent = `${i + 1}枚目: ${e.message}`;
      return;
    }
  }
  addTrades(all, 'スクリーンショット');
}

export function initTradesView() {
  $('csv-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) onCsv(f).catch((err) => toast(err.message));
    e.target.value = '';
  });
  $('trade-img').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (files.length) onImages(files);
    e.target.value = '';
  });
  render();
}
