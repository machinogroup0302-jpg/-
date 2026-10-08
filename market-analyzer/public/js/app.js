// 画面全体の動き：ログイン・タブ切り替え・設定
import { api, $, esc, store, toast } from './util.js';
import { initChartView, loadChart, renderFavorites, onSymbolChange, refreshTheme, setMode, getMode, startAutoRefresh, state as chartState } from './chartview.js';
import { initStockScreener, showStockScreener, autoRefreshStock } from './stockscreener.js';
import { initGlossary } from './glossary.js';
import { getFavs, setFavs, DEFAULT_FAVS, syncFavs, onFavsSynced, syncState, getProfile, setProfile } from './favorites.js';
import { setTradesMode } from './tradesview.js';
import { setScreenerMode } from './screener.js';
import { updateRatings, updatePts, resetRatings } from './ratingsview.js';
import { searchNews } from './newsview.js';
import { initScreener, autoRefreshList } from './screener.js';
import { initNewsView, onSymbol as newsOnSymbol } from './newsview.js';
import { initTradesView } from './tradesview.js';
import { updateOrderflow, resetOrderflow } from './orderflow.js';
import { updateFundamentals, resetFundamentals } from './fundview.js';
import { initLab, updateLab, resetLab, refreshLab } from './labview.js';
import { updateEarningsCard } from './earningsview.js';
import { updateOpening } from './openingview.js';
import { initMine, updateMine } from './mineview.js';

const MODE_NAMES = { fx: '為替', stock: '日本株', us: '米国株' };
function applyMode(mode) {
  document.body.dataset.mode = mode;
  document.querySelectorAll('#mode-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('symbol-input').placeholder = { fx: '例: USDJPY（ドル円）', stock: '例: 7203 または トヨタ', us: '例: AAPL / アップル / あっぷる（押すと人気銘柄）' }[mode];
  $('news-q').placeholder = { fx: '例: ドル円', stock: '例: トヨタ', us: '例: エヌビディア' }[mode];
  renderFavorites();
  setTradesMode(mode);
  setScreenerMode(mode);
}

const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TABS = [
  ['chart', 'チャート', 'チャート分析', ICON('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>')],
  ['news', 'ニュース', 'ニュース・ファンダ', ICON('<path d="M4 4h13v16H6a2 2 0 0 1-2-2z"/><path d="M17 8h3v10a2 2 0 0 1-2 2"/><path d="M8 8h5M8 12h5M8 16h3"/>')],
  ['lab', '成績', '答え合わせ・自動売買', ICON('<path d="M4 20h16"/><rect x="5" y="11" width="3" height="7"/><rect x="10.5" y="7" width="3" height="11"/><rect x="16" y="4" width="3" height="14"/>')],
  ['mine', 'あなた専用', 'あなた専用のアドバイス', ICON('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>')],
  ['screener', '候補', '可能性のある候補', ICON('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>')],
  ['trades', '取引分析', '自分の取引の分析', ICON('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>')],
];

let currentTab = 'chart';

function showTab(id) {
  currentTab = id;
  for (const [key, , title] of TABS) {
    $('view-' + key).hidden = key !== id;
    if (key === id) $('title').textContent = title;
  }
  document.querySelectorAll('#tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
  store.set('tab', id);
  if (id === 'news') newsOnSymbol(chartState);
  if (id === 'screener' && getMode() === 'stock') showStockScreener();
  if (id === 'lab') updateLab(chartState, getMode());
  if (id === 'mine') updateMine(getMode());
  window.scrollTo({ top: 0 });
}

function applyTheme() {
  const theme = store.get('theme', 'auto');
  const candle = store.get('candle', 'jp');
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.candle = candle;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
  refreshTheme();
}

function seg(el, options, value) {
  el.innerHTML = options.map(([k, v]) => `<button type="button" data-v="${k}" aria-pressed="${k === value}">${v}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  };
}
const segValue = (el) => el.querySelector('[aria-pressed="true"]')?.dataset.v;

function parseFavs(text) {
  return text.split('\n').map((l) => l.split(/[,，]/).map((s) => s.trim())).filter(([c]) => c).map(([code, name]) => ({ code, name: name || code }));
}

async function openSettings() {
  const favs = getFavs(getMode());
  $('fav-mode').textContent = MODE_NAMES[getMode()];
  seg($('refresh-seg'), [['on', '自動で最新にする'], ['off', '自動更新しない']], store.get('autoRefresh', 'on'));
  $('fav-edit').value = favs.map((f) => `${f.code},${f.name}`).join('\n');
  seg($('candle-seg'), [['jp', '日本式（陽線=赤）'], ['global', '海外式（陽線=緑）']], store.get('candle', 'jp'));
  seg($('theme-seg'), [['auto', '自動'], ['dark', 'ダーク'], ['light', 'ライト']], store.get('theme', 'auto'));
  const pf = getProfile();
  $('pf-email').value = pf.email || '';
  $('pf-budget').value = pf.budget ? String(pf.budget) : '';
  showBudget();
  seg($('pf-risk'), [['1', '1%（慎重）'], ['2', '2%（ふつう）'], ['3', '3%（積極的）']], String(pf.riskPct));
  seg($('pf-maxpos'), [['1', '1つ'], ['2', '2つ'], ['3', '3つ'], ['5', '5つ']], String(pf.maxPos));
  $('pf-day').checked = pf.notifyDay !== false;
  $('pf-notify').innerHTML = [['fx', '為替'], ['stock', '日本株'], ['us', '米国株']].map(([k, v]) => `<button type="button" class="chip" data-k="${k}" aria-pressed="${!!pf.notify?.[k]}">${v}のサインを通知</button>`).join('');
  renderSyncStatus();
  renderAccount();
  $('settings').showModal();
  syncFavs().then(renderSyncStatus);
}

const parseYen = (t) => Number(String(t).normalize('NFKC').replace(/[,，円\s]/g, '').replace(/万$/, '0000')) || 0;
function showBudget() {
  const v = parseYen($('pf-budget').value);
  $('pf-budget-view').textContent = v ? `＝ ${v.toLocaleString()}円${v >= 10000 ? `（${(v / 10000).toLocaleString()}万円）` : ''}` : '未入力のときは、計算に100万円を使います';
}

function renderMailStatus() {
  const el = $('mail-status');
  const t = syncState.lastAlertAt;
  if (t && Date.now() - t < 36 * 3600 * 1000) {
    el.innerHTML = `<span class="badge ok">メール通知：動いています</span> 最後の確認 ${new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}。新しいサインが出たときだけ届きます。`;
  } else {
    el.innerHTML = '<span class="badge warn">メール通知：まだ動いていません</span> メールを送る仕組み（GitHub）の準備がまだです。やり方はチャットで説明しています。';
  }
}

function renderSyncStatus() {
  renderMailStatus();
  const el = $('sync-status');
  if (syncState.error) {
    el.innerHTML = `<span class="badge warn">共有できませんでした</span> ${esc(syncState.error)}`;
  } else if (syncState.durable === true) {
    el.innerHTML = '<span class="badge ok">共有中</span> お気に入りと「あなたの設定」は、パソコンとスマホで同じものが使えます。';
  } else if (syncState.durable === false) {
    el.innerHTML = '<span class="badge warn">一時的な共有のみ</span> 今はサーバーが動いている間だけ共有されます。GitHub に <b>SITE_PASSWORD</b> を登録すると、ずっと共有されるようになります（やり方はチャットで説明しています）。';
  } else {
    el.textContent = syncState.error ? `共有の確認に失敗しました：${syncState.error}` : '共有の状態を確認しています…';
  }
}

function saveSettings() {
  const email = $('pf-email').value.trim();
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) { toast('メールアドレスの形が正しくありません'); $('pf-email').focus(); return; }
  const notify = {};
  $('pf-notify').querySelectorAll('button').forEach((b) => { notify[b.dataset.k] = b.getAttribute('aria-pressed') === 'true'; });
  setProfile({ ...getProfile(), email, budget: parseYen($('pf-budget').value), riskPct: Number(segValue($('pf-risk')) || 2), maxPos: Number(segValue($('pf-maxpos')) || 3), notify, notifyDay: $('pf-day').checked });
  const favs = parseFavs($('fav-edit').value);
  setFavs(getMode(), favs.length ? favs : DEFAULT_FAVS[getMode()]);
  store.set('candle', segValue($('candle-seg')) || 'jp');
  store.set('theme', segValue($('theme-seg')) || 'auto');
  store.set('autoRefresh', segValue($('refresh-seg')) || 'on');
  renderFavorites();
  applyTheme();
  $('settings').close();
  toast('保存しました');
  if (currentTab === 'lab') updateLab(chartState, getMode());
  if (currentTab === 'mine') updateMine(getMode());
}

// ---- 画面ごとの自動更新（チャートの値段は chartview.js で1分ごと） ----
// 何分ごとに最新にするか
const EVERY = { chartCards: 5, ratings: 30, news: 5, screener: 5, lab: 15, mine: 15, hold: 5 };
const lastRun = {};
function due(key) {
  const now = Date.now();
  if (now - (lastRun[key] || now) < EVERY[key] * 60 * 1000) { lastRun[key] ||= now; return false; }
  lastRun[key] = now;
  return true;
}
function startAutoUpdate() {
  const tick = () => {
    if (store.get('autoRefresh', 'on') !== 'on' || document.visibilityState !== 'visible') return;
    const mode = getMode();
    if (currentTab === 'chart' && chartState.symbol) {
      if (due('chartCards')) { resetOrderflow(); updateOrderflow(chartState, mode); updatePts(chartState, mode); }
      if (due('ratings')) { resetRatings(); updateRatings(chartState, mode); resetFundamentals(); updateFundamentals(chartState); }
    }
    if (currentTab === 'news' && due('news') && $('news-q').value) searchNews($('news-q').value, { silent: true });
    if (currentTab === 'screener' && due('screener')) { if (mode === 'stock') autoRefreshStock(); else autoRefreshList(); }
    if (currentTab === 'lab' && due('lab')) refreshLab(mode);
    if (currentTab === 'mine') {
      if (store.get('mine_sub', 'plan') === 'hold') { if (due('hold')) updateMine(mode); } else if (due('mine')) updateMine(mode, { force: true });
    }
  };
  setInterval(tick, 30 * 1000);
  document.addEventListener('visibilitychange', tick);
}

function startApp() {
  $('app').hidden = false;
  $('tabbar').innerHTML = TABS.map(([key, label, , icon]) => `<button role="tab" data-tab="${key}" aria-selected="false">${icon}<span>${label}</span></button>`).join('');
  $('tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) showTab(b.dataset.tab);
  });

  initGlossary();
  initChartView();
  const openChart = (code, name) => { showTab('chart'); loadChart(code, name, '1d'); };
  initScreener(openChart);
  initStockScreener(openChart);
  initLab(getMode);
  initMine(getMode, (symbol, name) => { showTab('chart'); loadChart(symbol, name, '1d'); });
  initNewsView();
  initTradesView();
  onSymbolChange((st) => {
    if (currentTab === 'news') newsOnSymbol(st);
    updateRatings(st, getMode());
    updatePts(st, getMode());
    updateEarningsCard(st, getMode());
    updateOpening(st, getMode());
    updateOrderflow(st, getMode());
    updateFundamentals(st);
    if (currentTab === 'lab') updateLab(st, getMode());
  });
  startAutoRefresh();
  // お気に入りをパソコンとスマホでそろえる（開いたとき・画面に戻ってきたとき・2分ごと）
  // ほかの端末で変えたものが届いたら、画面を作り直す
  onFavsSynced(() => {
    renderFavorites();
    setTradesMode(getMode());
    if (currentTab === 'mine') updateMine(getMode());
  });
  syncFavs();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncFavs(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncFavs(); }, 2 * 60 * 1000);
  startAutoUpdate();

  $('goto-news').addEventListener('click', () => showTab('news'));
  $('mode-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === getMode()) return;
    setMode(b.dataset.mode);
    applyMode(b.dataset.mode);
    showTab(currentTab);
  });
  $('open-settings').addEventListener('click', openSettings);
  initAccount();
  $('pf-budget').addEventListener('input', showBudget);
  $('pf-notify').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });
  $('close-settings').addEventListener('click', () => $('settings').close());
  $('save-settings').addEventListener('click', saveSettings);
  $('clear-data').addEventListener('click', () => {
    if (!confirm('このスマホに保存したデータ（設定・取引履歴・分析結果）をすべて消しますか？')) return;
    store.clear();
    location.reload();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  applyTheme();
  applyMode(getMode());
  showTab(store.get('tab', 'chart'));
  loadChart();
}

// ---- アカウント（使う人） ----
let me = { id: 'admin', name: '持ち主', admin: true };
const randomPass = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

async function renderAccount() {
  $('account-who').innerHTML = me.admin
    ? '<b>持ち主</b>としてログイン中です（ID は空のまま、または admin）。'
    : `<b>${esc(me.name)}</b>（ID: ${esc(me.id)}）としてログイン中です。`;
  $('account-admin').hidden = !me.admin;
  $('account-user').hidden = me.admin;
  if (!me.admin) return;
  try {
    const { items } = await api('/api/users');
    $('user-list').innerHTML = items.length ? items.map((u) => `<li class="small"><div class="li-head"><span class="name">${esc(u.name)}<span class="muted">（ID: ${esc(u.id)}）</span></span>
      <button type="button" class="chip" data-reset="${esc(u.id)}">パスワードを作り直す</button><button type="button" class="chip" data-del="${esc(u.id)}">消す</button></div>
      <div class="muted">${u.email ? 'メール通知の設定あり' : 'メール通知はまだ'}</div></li>`).join('') : '<li class="small muted">まだだれも追加していません。</li>';
  } catch (e) { $('user-list').innerHTML = `<li class="small error">${esc(e.message)}</li>`; }
}

function initAccount() {
  $('nu-gen').onclick = () => { $('nu-pass').value = randomPass(); };
  $('nu-add').onclick = async () => {
    $('nu-err').textContent = '';
    const body = { name: $('nu-name').value.trim(), id: $('nu-id').value.trim(), password: $('nu-pass').value.trim() };
    try {
      await api('/api/users', { method: 'POST', body });
      alert(`追加しました。この2つを${(body.name || body.id).replace(/さん$/, '')}さんに伝えてください。\n\nサイト：${location.origin}\nID：${body.id.toLowerCase()}\nパスワード：${body.password}`);
      ['nu-name', 'nu-id', 'nu-pass'].forEach((id) => { $(id).value = ''; });
      renderAccount();
    } catch (e) { $('nu-err').textContent = e.message; }
  };
  $('user-list').onclick = async (e) => {
    const del = e.target.closest('[data-del]'), reset = e.target.closest('[data-reset]');
    if (del && confirm(`ID「${del.dataset.del}」の人を消しますか？その人のデータもすべて消えます。`)) {
      await api(`/api/users?id=${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' }).catch((err) => alert(err.message));
      renderAccount();
    }
    if (reset) {
      const pass = randomPass();
      try {
        await api('/api/users', { method: 'PUT', body: { id: reset.dataset.reset, password: pass } });
        alert(`新しいパスワード：${pass}\nID「${reset.dataset.reset}」の人に伝えてください。`);
      } catch (err) { alert(err.message); }
    }
  };
  $('me-save').onclick = async () => {
    $('me-err').textContent = '';
    try {
      await api('/api/me/password', { method: 'PUT', body: { current: $('me-cur').value, password: $('me-new').value } });
      toast('パスワードを変えました');
      $('me-cur').value = ''; $('me-new').value = '';
    } catch (e) { $('me-err').textContent = e.message; }
  };
  $('logout').onclick = async () => {
    if (!confirm('ログアウトしますか？')) return;
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  };
}

async function boot() {
  let st = { loginRequired: false, loggedIn: true };
  try {
    st = await api('/api/status');
  } catch (e) {
    document.body.innerHTML = `<p class="empty">サーバーに接続できません: ${esc(e.message)}</p>`;
    return;
  }
  me = st.user || { id: 'admin', name: '持ち主', admin: true };
  if (st.loginRequired && !st.loggedIn) {
    $('login').hidden = false;
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/login', { method: 'POST', body: { id: $('login-id').value.trim(), password: $('login-pass').value } });
        // 人ごとに保存場所を分けるので、読み込み直してから始める
        location.reload();
      } catch (err) {
        $('login-err').textContent = err.message;
      }
    });
    return;
  }
  startApp();
}

boot();
