// 画面全体の動き：ログイン・タブ切り替え・設定
import { api, $, esc, store, toast } from './util.js';
import { initChartView, loadChart, renderFavorites, onSymbolChange, refreshTheme, setMode, getMode, startAutoRefresh, state as chartState } from './chartview.js';
import { initStockScreener, showStockScreener } from './stockscreener.js';
import { initGlossary } from './glossary.js';
import { setTradesMode } from './tradesview.js';
import { setScreenerMode } from './screener.js';
import { updateRatings, updatePts } from './ratingsview.js';
import { searchNews } from './newsview.js';
import { initScreener } from './screener.js';
import { initNewsView, onSymbol as newsOnSymbol } from './newsview.js';
import { initTradesView } from './tradesview.js';
import { initImageView } from './imageview.js';
import { initOrderflow } from './orderflow.js';

const DEFAULT_FAVS = {
  fx: [
    { code: 'USDJPY', name: 'ドル円' }, { code: 'EURJPY', name: 'ユーロ円' }, { code: 'GBPJPY', name: 'ポンド円' },
    { code: 'AUDJPY', name: '豪ドル円' }, { code: 'MXNJPY', name: 'メキシコペソ円' }, { code: 'EURUSD', name: 'ユーロドル' },
  ],
  stock: [
    { code: '^N225', name: '日経平均' }, { code: '7203', name: 'トヨタ自動車' }, { code: '9984', name: 'ソフトバンクG' },
    { code: '6758', name: 'ソニーG' }, { code: '8306', name: '三菱UFJ' }, { code: '7974', name: '任天堂' },
  ],
  us: [
    { code: '^GSPC', name: 'S&P500' }, { code: '^IXIC', name: 'ナスダック' }, { code: 'AAPL', name: 'アップル' },
    { code: 'NVDA', name: 'エヌビディア' }, { code: 'MSFT', name: 'マイクロソフト' }, { code: 'TSLA', name: 'テスラ' }, { code: 'AMZN', name: 'アマゾン' },
  ],
};
const MODE_NAMES = { fx: '為替', stock: '日本株', us: '米国株' };
const isFxCode = (c) => /^[A-Z]{6}(=X)?$/i.test(c);

// お気に入りは為替と株で別々。以前の共通のお気に入りは振り分けて引き継ぐ
function favsFor(mode) {
  const own = store.get(`favs_${mode}`, null);
  if (own) return own;
  const old = store.get('favs', null);
  if (old && mode !== 'us') {
    const mine = old.filter((f) => (mode === 'fx' ? isFxCode(f.code) : !isFxCode(f.code)));
    if (mine.length) return mine;
  }
  return DEFAULT_FAVS[mode];
}

function applyMode(mode) {
  document.body.dataset.mode = mode;
  document.querySelectorAll('#mode-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('symbol-input').placeholder = { fx: '例: USDJPY（ドル円）', stock: '例: 7203 または トヨタ', us: '例: AAPL または アップル' }[mode];
  $('news-q').placeholder = { fx: '例: ドル円', stock: '例: トヨタ', us: '例: エヌビディア' }[mode];
  renderFavorites(favsFor(mode));
  setTradesMode(mode);
  setScreenerMode(mode);
}

const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TABS = [
  ['chart', 'チャート', 'チャート分析', ICON('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>')],
  ['screener', '候補', '可能性のある候補', ICON('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>')],
  ['news', 'ニュース', 'ニュース・ファンダ', ICON('<path d="M4 4h13v16H6a2 2 0 0 1-2-2z"/><path d="M17 8h3v10a2 2 0 0 1-2 2"/><path d="M8 8h5M8 12h5M8 16h3"/>')],
  ['trades', '取引分析', '自分の取引の分析', ICON('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>')],
  ['image', '画像分析', '画像に線を引く', ICON('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6"/><path d="M3 9h18"/>')],
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
  const favs = favsFor(getMode());
  $('fav-mode').textContent = MODE_NAMES[getMode()];
  seg($('refresh-seg'), [['on', '1分ごとに自動更新'], ['off', '自動更新しない']], store.get('autoRefresh', 'on'));
  $('fav-edit').value = favs.map((f) => `${f.code},${f.name}`).join('\n');
  $('api-key').value = store.get('apiKey', '');
  seg($('candle-seg'), [['jp', '日本式（陽線=赤）'], ['global', '海外式（陽線=緑）']], store.get('candle', 'jp'));
  seg($('theme-seg'), [['auto', '自動'], ['dark', 'ダーク'], ['light', 'ライト']], store.get('theme', 'auto'));
  try {
    const st = await api('/api/status');
    $('api-status').textContent = st.aiServerKey ? 'サーバーにAPIキーが設定済みです（ここは空欄でOK）。' : 'サーバーにAPIキーが未設定です。AI機能を使うにはここに入力してください。';
  } catch { /* 表示できなくても続ける */ }
  $('settings').showModal();
}

function saveSettings() {
  const favs = parseFavs($('fav-edit').value);
  store.set(`favs_${getMode()}`, favs.length ? favs : DEFAULT_FAVS[getMode()]);
  store.set('apiKey', $('api-key').value.trim());
  store.set('candle', segValue($('candle-seg')) || 'jp');
  store.set('theme', segValue($('theme-seg')) || 'auto');
  store.set('autoRefresh', segValue($('refresh-seg')) || 'on');
  renderFavorites(favsFor(getMode()));
  applyTheme();
  $('settings').close();
  toast('保存しました');
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
  initNewsView();
  initTradesView();
  initImageView();
  initOrderflow();
  onSymbolChange((st) => {
    if (currentTab === 'news') newsOnSymbol(st);
    updateRatings(st, getMode());
    updatePts(st, getMode());
  });
  startAutoRefresh();
  // ニュースタブを開いている間は10分ごとに最新にする
  setInterval(() => {
    if (currentTab === 'news' && document.visibilityState === 'visible' && store.get('autoRefresh', 'on') === 'on' && $('news-q').value) searchNews($('news-q').value);
  }, 10 * 60 * 1000);

  $('goto-news').addEventListener('click', () => showTab('news'));
  $('mode-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === getMode()) return;
    setMode(b.dataset.mode);
    applyMode(b.dataset.mode);
    showTab(currentTab);
  });
  $('open-settings').addEventListener('click', openSettings);
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

async function boot() {
  let st = { loginRequired: false, loggedIn: true };
  try {
    st = await api('/api/status');
  } catch (e) {
    document.body.innerHTML = `<p class="empty">サーバーに接続できません: ${esc(e.message)}</p>`;
    return;
  }
  if (st.loginRequired && !st.loggedIn) {
    $('login').hidden = false;
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/login', { method: 'POST', body: { password: $('login-pass').value } });
        $('login').hidden = true;
        startApp();
      } catch (err) {
        $('login-err').textContent = err.message;
      }
    });
    return;
  }
  startApp();
}

boot();
