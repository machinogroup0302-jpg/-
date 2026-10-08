// 候補リスト：登録した銘柄を日足でまとめてチェック
import { api, $, esc, store, fmtPrice, digitsFor, signalClass } from './util.js';
import { technicalSummary } from './indicators.js';
import { pagedList } from './stockscreener.js';
import { supportResistance } from './levels.js';
import { monteCarlo } from './forecast.js';
import { getProfile } from './favorites.js';
import { sizeFor, orderText, sidesFor } from './plan.js';

const DEFAULT_WATCH = {
  fx: ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY', 'ZARJPY', 'MXNJPY', 'EURUSD', 'GBPUSD', 'AUDUSD'].join('\n'),
  us: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'PLTR', 'JPM', 'V', 'LLY', 'COST', 'KO', 'SPY', 'QQQ'].join('\n'),
};
let listMode = 'fx';
let results = [];
// 以前の一覧から、通貨ペアだけを引き継ぐ
const oldWatch = () => (store.get('watchlist', '') || '').split('\n').filter((c) => /^[A-Z]{6}(=X)?$/i.test(c.trim())).join('\n');
const FILTERS = [['all', 'すべて'], ['buy', '買い候補'], ['sell', '売り候補']];
let filter = 'all';
let usdjpy = null;

// あなたの設定なら「どれだけ・いくらで」入るか
function sizeNote(r) {
  const pf = getProfile();
  if (!pf.budget || Math.abs(r.total) <= 10 || !r.atr) return '';
  const side = r.total > 0 ? 1 : -1;
  if (side < 0 && listMode === 'us') return '<div class="small">あなたの設定なら：持っていたら売る候補（米国株は空売りしない計算）</div>';
  const sides = sidesFor(pf, listMode);
  if ((side < 0 && sides === 'long') || (side > 0 && sides === 'short')) return `<div class="small muted">あなたの設定（${side > 0 ? '売りだけ' : '買いだけ'}）では入りません</div>`;
  const prices = Object.fromEntries(results.filter((x) => x.price).map((x) => [x.symbol, x.price]));
  if (usdjpy) prices['USDJPY=X'] ??= usdjpy;
  const stop = r.price - side * r.atr * 2;
  const s = sizeFor(pf, listMode, side, { symbol: r.symbol, price: r.price, stop, budget: pf.budget, riskPct: pf.riskPct || 2, maxPos: pf.maxPos || 3, prices, usdjpy: usdjpy || prices['USDJPY=X'] });
  if (!s) return '';
  if (!(s.qty > 0)) return `<div class="small muted">あなたの設定では入れません：${esc(s.why || '')}</div>`;
  return `<div class="small">あなたの設定なら：<b>${esc(orderText(side, s))}</b>（${esc(s.kindLabel)} 約${Math.round(s.cost).toLocaleString()}円・損切り ${fmtPrice(stop, digitsFor(r.price))}）</div>`;
}

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
  // 損切りの目安：値動きの平均の幅（14日）の2倍
  let tr = 0;
  for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) tr += Math.max(candles[i].high, candles[i - 1].close) - Math.min(candles[i].low, candles[i - 1].close);
  const atr = tr / Math.min(14, candles.length - 1);
  return { tech: t, upProb: fc?.upProb ?? null, res, sup, room, total, price, atr };
}

function render() {
  const list = results
    .filter((r) => (filter === 'buy' ? r.total > 10 : filter === 'sell' ? r.total < -10 : true))
    .sort((a, b) => (filter === 'sell' ? a.total - b.total : Math.abs(b.total) - Math.abs(a.total)));
  if (!results.length) return;
  pagedList($('scr-list'), list, (r) => {
    if (r.error) return `<li><div class="li-head"><span class="name">${esc(r.code)}</span><span class="badge neutral">取得失敗</span></div><div class="small muted">${esc(r.error)}</div></li>`;
    const d = digitsFor(r.price);
    const reasons = r.tech.rows.filter((x) => x.signal !== '中立').slice(0, 3).map((x) => `${x.name}:${x.signal}`).join('、');
    return `<li data-code="${esc(r.symbol)}" data-name="${esc(r.name)}" style="cursor:pointer">
      <div class="li-head"><span class="name">${esc(r.name)} <span class="small muted">${esc(r.symbol)}</span></span>
      <span class="badge ${signalClass(r.tech.label)}">${esc(r.tech.label)}</span></div>
      <div class="small num">現在 ${fmtPrice(r.price, d)}　上昇確率 ${r.upProb != null ? Math.round(r.upProb * 100) + '%' : '—'}　点数 ${Math.round(r.total)}</div>
      <div class="small muted">${r.res ? `上の壁 ${fmtPrice(r.res.price, d)}` : ''}${r.sup ? `　下の支え ${fmtPrice(r.sup.price, d)}` : ''}${r.room != null ? `　上値余地/下値余地 ${r.room.toFixed(1)}倍` : ''}</div>
      <div class="small muted">${esc(reasons)}</div>${sizeNote(r)}</li>`;
  }, { empty: '条件に合う候補はありません' });
}

async function run(onPick) {
  const codes = $('watchlist').value.split(/\n|,|、/).map((s) => s.trim()).filter(Boolean).slice(0, 40);
  const btn = $('scr-run');
  btn.disabled = true;
  results = [];
  if (!usdjpy) { try { const u = await api('/api/chart?symbol=USDJPY&tf=1d'); usdjpy = u.candles[u.candles.length - 1].close; } catch { /* 取れなければ米国株の量は出さない */ } }
  let done = 0;
  const queue = [...codes];
  const names = Object.fromEntries((store.get(`favs_${listMode}`, listMode === 'fx' ? store.get('favs', []) : []) || []).map((f) => [f.code.toUpperCase(), f.name]));
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

// 為替と米国株で、チェックする一覧を切り替える
export function setScreenerMode(mode) {
  if (mode === 'stock') return;
  listMode = mode;
  $('watchlist').value = store.get(`watchlist_${mode}`, (mode === 'fx' && oldWatch()) || DEFAULT_WATCH[mode]);
  results = [];
  $('scr-list').innerHTML = '<li class="empty">「チェック開始」を押してください</li>';
  $('scr-status').textContent = '';
}

let pickFn = () => {};
// 自動更新：一度チェックしていれば、もう一度チェックする
export function autoRefreshList() {
  if (results.length && !$('scr-run').disabled) run(pickFn);
}

export function initScreener(onPick) {
  pickFn = onPick;
  setScreenerMode(store.get('mode', 'fx') === 'us' ? 'us' : 'fx');
  $('scr-filter').innerHTML = FILTERS.map(([k, v]) => `<button data-f="${k}" aria-pressed="${k === filter}">${v}</button>`).join('');
  $('scr-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    $('scr-filter').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });
  $('watch-save').addEventListener('click', () => {
    store.set(`watchlist_${listMode}`, $('watchlist').value);
    $('scr-status').textContent = '保存しました';
  });
  $('scr-run').addEventListener('click', () => run(onPick));
}
