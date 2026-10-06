// 候補リスト：登録した銘柄を日足でまとめてチェック
import { api, $, esc, store, fmtPrice, digitsFor, signalClass } from './util.js';
import { technicalSummary } from './indicators.js';
import { supportResistance } from './levels.js';
import { monteCarlo } from './forecast.js';

const DEFAULT_WATCH = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY', 'ZARJPY', 'MXNJPY', 'EURUSD', 'GBPUSD', 'AUDUSD'].join('\n');
// 以前の一覧から、通貨ペアだけを引き継ぐ
const oldWatch = () => (store.get('watchlist', '') || '').split('\n').filter((c) => /^[A-Z]{6}(=X)?$/i.test(c.trim())).join('\n');
const FILTERS = [['all', 'すべて'], ['buy', '買い候補'], ['sell', '売り候補']];
let results = [];
let filter = 'all';

function scoreOf(candles) {
  const t = technicalSummary(candles);
  const fc = monteCarlo(candles, { horizon: 10, paths: 800 });
  const price = candles[candles.length - 1].close;
  const lv = supportResistance(candles);
  const res = lv.filter((l) => l.kind === 'resistance').sort((a, b) => a.price - b.price)[0];
  const sup = lv.filter((l) => l.kind === 'support').sort((a, b) => b.price - a.price)[0];
  // 上値余地（次のレジスタンスまで）と下値余地（次のサポートまで）の比
  const room = res && sup ? (res.price - price) / Math.max(price - sup.price, price * 0.0005) : null;
  const total = t.ratio * 70 + ((fc?.upProb ?? 0.5) - 0.5) * 60;
  return { tech: t, upProb: fc?.upProb ?? null, res, sup, room, total, price };
}

function render() {
  const list = results
    .filter((r) => (filter === 'buy' ? r.total > 10 : filter === 'sell' ? r.total < -10 : true))
    .sort((a, b) => (filter === 'sell' ? a.total - b.total : Math.abs(b.total) - Math.abs(a.total)));
  if (!results.length) return;
  $('scr-list').innerHTML = list.map((r) => {
    if (r.error) return `<li><div class="li-head"><span class="name">${esc(r.code)}</span><span class="badge neutral">取得失敗</span></div><div class="small muted">${esc(r.error)}</div></li>`;
    const d = digitsFor(r.price);
    const reasons = r.tech.rows.filter((x) => x.signal !== '中立').slice(0, 3).map((x) => `${x.name}:${x.signal}`).join('、');
    return `<li data-code="${esc(r.symbol)}" data-name="${esc(r.name)}" style="cursor:pointer">
      <div class="li-head"><span class="name">${esc(r.name)} <span class="small muted">${esc(r.symbol)}</span></span>
      <span class="badge ${signalClass(r.tech.label)}">${esc(r.tech.label)}</span></div>
      <div class="small num">現在 ${fmtPrice(r.price, d)}　上昇確率 ${r.upProb != null ? Math.round(r.upProb * 100) + '%' : '—'}　点数 ${Math.round(r.total)}</div>
      <div class="small muted">${r.res ? `上の壁 ${fmtPrice(r.res.price, d)}` : ''}${r.sup ? `　下の支え ${fmtPrice(r.sup.price, d)}` : ''}${r.room != null ? `　上値余地/下値余地 ${r.room.toFixed(1)}倍` : ''}</div>
      <div class="small muted">${esc(reasons)}</div></li>`;
  }).join('') || '<li class="empty">条件に合う候補はありません</li>';
}

async function run(onPick) {
  const codes = $('watchlist').value.split(/\n|,|、/).map((s) => s.trim()).filter(Boolean).slice(0, 40);
  const btn = $('scr-run');
  btn.disabled = true;
  results = [];
  let done = 0;
  const queue = [...codes];
  const names = Object.fromEntries((store.get('favs_fx', store.get('favs', [])) || []).map((f) => [f.code.toUpperCase(), f.name]));
  async function worker() {
    while (queue.length) {
      const code = queue.shift();
      try {
        const data = await api(`/api/chart?symbol=${encodeURIComponent(code)}&tf=1d`);
        if (data.candles.length < 80) throw new Error('データが足りません');
        results.push({ code, symbol: data.symbol, name: names[code.toUpperCase()] || data.name || data.symbol, ...scoreOf(data.candles) });
      } catch (e) {
        results.push({ code, error: e.message, total: 0 });
      }
      done++;
      $('scr-status').textContent = `チェック中… ${done} / ${codes.length}`;
      render();
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  $('scr-status').textContent = `${new Date().toLocaleString('ja-JP')} にチェックしました（日足ベース）。タップするとチャートを開きます。`;
  btn.disabled = false;
  render();
  $('scr-list').onclick = (e) => {
    const li = e.target.closest('li[data-code]');
    if (li) onPick(li.dataset.code, li.dataset.name);
  };
}

export function initScreener(onPick) {
  $('watchlist').value = store.get('watchlist_fx', oldWatch() || DEFAULT_WATCH);
  $('scr-filter').innerHTML = FILTERS.map(([k, v]) => `<button data-f="${k}" aria-pressed="${k === filter}">${v}</button>`).join('');
  $('scr-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    $('scr-filter').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });
  $('watch-save').addEventListener('click', () => {
    store.set('watchlist_fx', $('watchlist').value);
    $('scr-status').textContent = '保存しました';
  });
  $('scr-run').addEventListener('click', () => run(onPick));
}
