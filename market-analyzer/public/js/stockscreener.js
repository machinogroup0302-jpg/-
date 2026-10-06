// 株の候補リスト：東証の全上場企業をチェックして並べる
import { api, $, esc, store, fmtPrice } from './util.js';
import { term } from './glossary.js';

const MARKETS = ['プライム', 'スタンダード', 'グロース', '外国株'];
const VIEWS = [
  ['buy', '上がりそう'], ['sell', '下がりそう'], ['stopHigh', 'ストップ高'], ['stopLow', 'ストップ安'], ['up', '今日の値上がり'], ['down', '今日の値下がり'],
];
let markets = store.get('stk_markets', ['プライム', 'スタンダード', 'グロース']);
let view = 'buy';
let polling = null;
let onPick = () => {};

function query() {
  const [min, max] = ($('stk-price').value || '0-0').split('-');
  return `view=${view}&sector=${encodeURIComponent($('stk-sector').value)}&min=${min}&max=${max}&limit=150`;
}

function renderMarkets(counts = {}) {
  $('stk-markets').innerHTML = MARKETS.map((m) => `<button class="chip" data-m="${m}" aria-pressed="${markets.includes(m)}">${m}${counts[m] ? `（${counts[m].toLocaleString()}社）` : ''}</button>`).join('');
}

function renderViews() {
  $('stk-views').innerHTML = VIEWS.map(([k, v]) => `<button class="chip" data-v="${k}" aria-pressed="${k === view}">${v}</button>`).join('');
}

function stopBadge(st) {
  if (!st?.status) return '';
  return `<span class="badge ${/高/.test(st.status) ? 'buy' : 'sell'}">${esc(st.status)}</span>`;
}

function renderList(data) {
  const empty = {
    stopHigh: 'ストップ高・ストップ高に近い銘柄はありません',
    stopLow: 'ストップ安・ストップ安に近い銘柄はありません',
  }[view] || '条件に合う銘柄はありません';
  $('stk-list').innerHTML = (data.results || []).map((r) => `
    <li data-symbol="${esc(r.symbol)}" data-name="${esc(r.name)}" style="cursor:pointer">
      <div class="li-head"><span class="name">${esc(r.name)} <span class="small muted">${esc(r.code)}</span></span>
        ${stopBadge(r.stop)}<span class="badge ${r.score > 15 ? 'buy' : r.score < -15 ? 'sell' : 'neutral'}">${esc(r.label)}</span></div>
      <div class="small num">${fmtPrice(r.price, r.price >= 1000 ? 0 : 1)}円　<span class="${r.changePct >= 0 ? 'plus' : 'minus'}">今日 ${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%</span>　<span class="muted">1か月 ${r.monthPct >= 0 ? '+' : ''}${r.monthPct.toFixed(1)}%</span></div>
      <div class="small muted">${esc(r.market)}・${esc(r.sector)}${r.reasons.length ? '　' + r.reasons.map((x) => `${esc(x.name)}:${esc(x.signal)}`).join('、') : ''}</div>
    </li>`).join('') || `<li class="empty">${empty}</li>`;
  const note = view === 'stopHigh' || view === 'stopLow'
    ? `${term('stop', 'ストップ高・ストップ安とは')}（「近い」は動ける幅の70%以上まで動いた銘柄）`
    : view === 'buy' || view === 'sell' ? `${term('technical', 'テクニカル分析')}のサインが強い順` : '';
  $('stk-status').innerHTML = `${data.finishedAt ? `${new Date(data.finishedAt).toLocaleString('ja-JP')} のチェック結果（${data.total.toLocaleString()}社中 ${data.matched.toLocaleString()}社が該当${data.matched > 150 ? '・上位150社を表示' : ''}${data.failed ? `・取得できなかった銘柄 ${data.failed.toLocaleString()}社` : ''}）` : ''}<br>${note}`;
}

async function refresh() {
  const data = await api(`/api/stocks/scan?${query()}`);
  const bar = $('stk-progress');
  if (data.status === 'running') {
    bar.hidden = false;
    bar.firstElementChild.style.width = `${data.total ? (data.done / data.total) * 100 : 2}%`;
    $('stk-status').textContent = data.total ? `チェック中… ${data.done.toLocaleString()} / ${data.total.toLocaleString()}社` : '上場企業の一覧を読み込んでいます…';
    $('stk-run').disabled = true;
    return false;
  }
  bar.hidden = true;
  $('stk-run').disabled = false;
  if (data.status === 'error') { $('stk-status').textContent = `チェックできませんでした: ${data.error}`; return true; }
  if (data.status === 'done') renderList(data);
  return true;
}

function poll() {
  clearInterval(polling);
  polling = setInterval(async () => {
    try {
      if (await refresh()) clearInterval(polling);
    } catch (e) {
      clearInterval(polling);
      $('stk-status').textContent = e.message;
      $('stk-run').disabled = false;
    }
  }, 2000);
}

async function loadMeta() {
  try {
    const m = await api('/api/stocks/meta');
    $('stk-meta').textContent = `東証の上場企業 ${m.count.toLocaleString()}社（${new Date(m.updatedAt).toLocaleDateString('ja-JP')} に最新の一覧を確認・毎日自動で更新）`;
    renderMarkets(m.markets);
    const cur = $('stk-sector').value;
    $('stk-sector').innerHTML = '<option value="">すべての業種</option>' + m.sectors.map((s) => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('');
    const today = new Date().toISOString().slice(0, 10);
    $('stk-new').innerHTML = m.newListings.map((x) => `
      <li data-symbol="${esc(x.code)}.T" data-name="${esc(x.name)}" style="cursor:pointer">
        <div class="li-head"><span class="name">${esc(x.name || '（社名確認中）')} <span class="small muted">${esc(x.code)}</span></span>
        <span class="badge ${x.date > today ? 'warn' : 'ok'}">${x.date > today ? '上場予定' : '上場'} ${esc(x.date)}</span></div>
        ${x.market ? `<div class="small muted">${esc(x.market)}</div>` : ''}
      </li>`).join('') || '<li class="empty">最近90日の新規上場はまだ見つかっていません（一覧が更新されると自動で表示されます）</li>';
  } catch (e) {
    $('stk-meta').textContent = `上場企業の一覧を読み込めませんでした: ${e.message}`;
    $('stk-new').innerHTML = '<li class="empty">読み込めませんでした</li>';
  }
}

export function initStockScreener(pick) {
  onPick = pick;
  renderMarkets();
  renderViews();
  $('stk-markets').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const m = b.dataset.m;
    markets = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    if (!markets.length) markets = [m];
    store.set('stk_markets', markets);
    $('stk-markets').querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(markets.includes(x.dataset.m))));
  });
  $('stk-views').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    view = b.dataset.v;
    renderViews();
    refresh().catch(() => {});
  });
  $('stk-sector').addEventListener('change', () => refresh().catch(() => {}));
  $('stk-price').addEventListener('change', () => refresh().catch(() => {}));
  $('stk-run').addEventListener('click', async () => {
    $('stk-run').disabled = true;
    $('stk-status').textContent = 'チェックを始めています…';
    try {
      await api('/api/stocks/scan', { method: 'POST', body: { markets } });
      poll();
    } catch (e) {
      $('stk-status').textContent = e.message;
      $('stk-run').disabled = false;
    }
  });
  const pickHandler = (e) => {
    if (e.target.closest('.term')) return;
    const li = e.target.closest('li[data-symbol]');
    if (li) onPick(li.dataset.symbol, li.dataset.name);
  };
  $('stk-list').addEventListener('click', pickHandler);
  $('stk-new').addEventListener('click', pickHandler);
}

let metaLoaded = false;
// 株の候補タブを開いたとき
export function showStockScreener() {
  if (!metaLoaded) { metaLoaded = true; loadMeta(); }
  refresh().then((finished) => { if (!finished) poll(); }).catch(() => {});
}
