// 株の候補リスト：東証の全上場企業のチェック・ストップ高/安の一覧・決算発表のスケジュール・新規上場
import { api, $, esc, store, fmtPrice } from './util.js';
import { term } from './glossary.js';
import { getFavs } from './favorites.js';

const MARKETS = ['プライム', 'スタンダード', 'グロース', '外国株'];
const VIEWS = [['buy', '上がりそう'], ['sell', '下がりそう'], ['up', '今日の値上がり'], ['down', '今日の値下がり']];
const STOP_VIEWS = [['stopHigh', 'ストップ高'], ['stopLow', 'ストップ安']];
const EARN_VIEWS = [['week', '今週'], ['month', '1か月'], ['all', 'すべて'], ['fav', 'お気に入り']];
const PAGE = 10;
let markets = store.get('stk_markets', ['プライム', 'スタンダード', 'グロース']);
let view = 'buy', stopView = 'stopHigh', earnView = 'week';
let polling = null;
let onPick = () => {};

// 10件ずつ表示して、残りは「もっと見る」で出す
export function pagedList(el, items, render, { empty = '該当なし', tag = 'ul', wrap = (x) => x } = {}) {
  let shown = 0;
  const draw = () => {
    shown = Math.min(items.length, shown + PAGE);
    const body = items.slice(0, shown).map(render).join('');
    const rest = items.length - shown;
    el.innerHTML = items.length
      ? wrap(body) + (rest > 0 ? `<button class="btn block more-btn">もっと見る（残り${rest.toLocaleString()}件）</button>` : '')
      : (tag === 'ul' ? `<li class="empty">${esc(empty)}</li>` : `<p class="empty">${esc(empty)}</p>`);
    const btn = el.querySelector('.more-btn');
    if (btn) btn.onclick = draw;
  };
  draw();
}

const yen = (v) => `${fmtPrice(v, v >= 1000 ? 0 : 1)}円`;
const chg = (v) => `<span class="${v >= 0 ? 'plus' : 'minus'}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;

function query(v, limit = 300) {
  const [min, max] = ($('stk-price').value || '0-0').split('-');
  return `view=${v}&sector=${encodeURIComponent($('stk-sector').value)}&min=${min}&max=${max}&limit=${limit}`;
}

function renderMarkets(counts = {}) {
  $('stk-markets').innerHTML = MARKETS.map((m) => `<button class="chip" data-m="${m}" aria-pressed="${markets.includes(m)}">${m}${counts[m] ? `（${counts[m].toLocaleString()}社）` : ''}</button>`).join('');
}

function seg(el, list, cur) {
  el.innerHTML = list.map(([k, v]) => `<button data-v="${k}" aria-pressed="${k === cur}">${v}</button>`).join('');
}

function stopBadge(st) {
  if (!st?.status) return '';
  return `<span class="badge ${/高/.test(st.status) ? 'buy' : 'sell'}">${esc(st.status)}</span>`;
}

function itemHtml(r) {
  return `<li data-symbol="${esc(r.symbol)}" data-name="${esc(r.name)}" style="cursor:pointer">
    <div class="li-head"><span class="name">${esc(r.name)} <span class="small muted">${esc(r.code)}</span></span>
      ${stopBadge(r.stop)}<span class="badge ${r.score > 15 ? 'buy' : r.score < -15 ? 'sell' : 'neutral'}">${esc(r.label)}</span></div>
    <div class="small num">${yen(r.price)}　今日 ${chg(r.changePct)}　<span class="muted">${esc(r.market)}・${esc(r.sector)}</span></div>
  </li>`;
}

async function renderResults() {
  const data = await api(`/api/stocks/scan?${query(view)}`);
  if (data.status !== 'done') return;
  pagedList($('stk-list'), data.results || [], itemHtml, { empty: '条件に合う銘柄はありません' });
}

async function renderStops() {
  const data = await api(`/api/stocks/scan?${query(stopView)}`);
  if (data.status !== 'done') return;
  const rows = data.results || [];
  pagedList($('stop-table'), rows, (r) => `<tr data-symbol="${esc(r.symbol)}" data-name="${esc(r.name)}" style="cursor:pointer">
      <td class="small"><b>${esc(r.name)}</b><div class="muted">${esc(r.code)}・${esc(r.market)}</div></td>
      <td class="r small num">${yen(r.price)}<div>${chg(r.changePct)}</div></td>
      <td class="small">${stopBadge(r.stop)}<div class="muted" style="font-size:11px">${r.stop ? `${r.stop.status?.includes('高') ? '上限' : '下限'} ${yen(r.stop.status?.includes('高') ? r.stop.up : r.stop.down)}` : ''}</div></td></tr>`,
  { tag: 'table', empty: stopView === 'stopHigh' ? '今日ストップ高（とその近く）の銘柄はありません' : '今日ストップ安（とその近く）の銘柄はありません',
    wrap: (b) => `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>銘柄</th><th class="r">値段・前日比</th><th>状態</th></tr></thead><tbody>${b}</tbody></table></div><p class="small muted">「近い」は1日に動ける幅の70%以上まで動いた銘柄です。</p>` });
}

async function refresh() {
  const data = await api(`/api/stocks/scan?${query(view, 1)}`);
  const bar = $('stk-progress');
  if (data.status === 'running') {
    bar.hidden = false;
    bar.firstElementChild.style.width = `${data.total ? (data.done / data.total) * 100 : 2}%`;
    $('stk-status').textContent = data.total ? `全銘柄をチェック中… ${data.done.toLocaleString()} / ${data.total.toLocaleString()}社` : '上場企業の一覧を読み込んでいます…';
    $('stk-run').disabled = true;
    return false;
  }
  bar.hidden = true;
  $('stk-run').disabled = false;
  if (data.status === 'error') { $('stk-status').textContent = `チェックできませんでした: ${data.error}`; return true; }
  if (data.status === 'done') {
    $('stk-status').textContent = `${new Date(data.finishedAt).toLocaleString('ja-JP')} にチェック（${data.total.toLocaleString()}社${data.failed ? `・取得できなかった銘柄 ${data.failed}社` : ''}）。もう一度押すと最新にします。`;
    await Promise.all([renderResults(), renderStops()]);
  }
  return data.status !== 'none';
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

async function startScan() {
  $('stk-run').disabled = true;
  $('stk-status').textContent = 'チェックを始めています…';
  try {
    await api('/api/stocks/scan', { method: 'POST', body: { markets } });
    poll();
  } catch (e) {
    $('stk-status').textContent = e.message;
    $('stk-run').disabled = false;
  }
}

// ---------------- 決算発表のスケジュール ----------------
const kindJa = (k) => String(k || '').replace(/第(\d)四半期/, '第$1四半期');
async function renderEarnings() {
  const box = $('earn-table');
  const today = new Date(Date.now() + 9 * 3600 * 1000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  let params = `from=${ymd(today)}`;
  if (earnView === 'week') params += `&to=${ymd(new Date(today.getTime() + 7 * 86400000))}`;
  if (earnView === 'month') params += `&to=${ymd(new Date(today.getTime() + 31 * 86400000))}`;
  if (earnView === 'fav') params += `&codes=${getFavs('stock').map((f) => f.code).filter((c) => /^[0-9][0-9A-Z]{3}$/.test(c)).join(',')}`;
  const q = $('earn-q').value.trim();
  if (q) params += `&q=${encodeURIComponent(q)}`;
  try {
    const d = await api(`/api/stocks/earnings?${params}`);
    pagedList(box, d.items, (x) => `<tr data-symbol="${esc(x.code)}.T" data-name="${esc(x.name)}" style="cursor:pointer">
        <td class="small num">${esc(x.date.slice(5).replace('-', '/'))}<div class="muted" style="font-size:11px">${'日月火水木金土'[new Date(x.date + 'T00:00:00+09:00').getDay()]}曜</div></td>
        <td class="small"><b>${esc(x.name)}</b><div class="muted">${esc(x.code)}・${esc(x.sector || x.market)}</div></td>
        <td class="small">${x.period && /^\d{4}-\d{2}$/.test(x.period) ? `${Number(x.period.slice(5))}月決算` : esc(x.period)}<div class="muted" style="font-size:11px">${esc(kindJa(x.kind))}</div></td></tr>`,
    { tag: 'table', empty: earnView === 'fav' ? 'お気に入りの会社の決算発表の予定はありません' : 'この期間の予定はありません',
      wrap: (b) => `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>発表日</th><th>会社</th><th>決算月・種別</th></tr></thead><tbody>${b}</tbody></table></div>
        <p class="small muted">全${d.total.toLocaleString()}件。日本取引所が公開している予定を、更新のたびに自動で取り込んでいます（決算月ごとに順番に公開されるため、先の予定はまだ載っていないことがあります）。</p>` });
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function loadMeta() {
  try {
    const m = await api('/api/stocks/meta');
    $('stk-meta').textContent = `東証の上場企業 ${m.count.toLocaleString()}社（${new Date(m.updatedAt).toLocaleDateString('ja-JP')} 時点の一覧）`;
    renderMarkets(m.markets);
    const cur = $('stk-sector').value;
    $('stk-sector').innerHTML = '<option value="">すべての業種</option>' + m.sectors.map((x) => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const today = new Date().toISOString().slice(0, 10);
    pagedList($('stk-new'), m.newListings, (x) => `
      <li data-symbol="${esc(x.code)}.T" data-name="${esc(x.name)}" style="cursor:pointer">
        <div class="li-head"><span class="name">${esc(x.name || '（社名確認中）')} <span class="small muted">${esc(x.code)}</span></span>
        <span class="badge ${x.date > today ? 'warn' : 'ok'}">${x.date > today ? '上場予定' : '上場'} ${esc(x.date.slice(5).replace('-', '/'))}</span></div>
        ${x.market ? `<div class="small muted">${esc(x.market)}</div>` : ''}
      </li>`, { empty: '最近の新規上場は見つかりませんでした' });
  } catch (e) {
    $('stk-meta').textContent = `上場企業の一覧を読み込めませんでした: ${e.message}`;
    $('stk-new').innerHTML = '<li class="empty">読み込めませんでした</li>';
  }
}

export function initStockScreener(pick) {
  onPick = pick;
  renderMarkets();
  seg($('stk-views'), VIEWS, view);
  $('stk-views').className = 'seg';
  seg($('stop-seg'), STOP_VIEWS, stopView);
  seg($('earn-seg'), EARN_VIEWS, earnView);
  $('stk-markets').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const m = b.dataset.m;
    markets = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    if (!markets.length) markets = [m];
    store.set('stk_markets', markets);
    $('stk-markets').querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(markets.includes(x.dataset.m))));
  });
  const onSeg = (el, set, after) => el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    set(b.dataset.v);
    el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    after().catch(() => {});
  });
  onSeg($('stk-views'), (v) => { view = v; }, renderResults);
  onSeg($('stop-seg'), (v) => { stopView = v; }, renderStops);
  onSeg($('earn-seg'), (v) => { earnView = v; }, renderEarnings);
  let t;
  $('earn-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderEarnings, 300); });
  $('stk-sector').addEventListener('change', () => Promise.all([renderResults(), renderStops()]).catch(() => {}));
  $('stk-price').addEventListener('change', () => Promise.all([renderResults(), renderStops()]).catch(() => {}));
  $('stk-run').addEventListener('click', startScan);
  const pickHandler = (e) => {
    if (e.target.closest('.term') || e.target.closest('.more-btn')) return;
    const li = e.target.closest('[data-symbol]');
    if (li) onPick(li.dataset.symbol, li.dataset.name);
  };
  ['stk-list', 'stk-new', 'stop-table', 'earn-table'].forEach((id) => $(id).addEventListener('click', pickHandler));
}

let opened = false;
// 株の候補タブを開いたとき（初めて開いたら全銘柄チェックも自動で始める）
export async function showStockScreener() {
  if (!opened) {
    opened = true;
    loadMeta();
    renderEarnings();
  }
  try {
    const started = await refresh();
    if (!started) await startScan();
    else poll();
  } catch { /* 表示できなくても続ける */ }
}
