// ニュース画面：無料のニュース収集（信頼度つき）と、AIによる詳しい調査
import { api, $, esc, store, busy, signalClass } from './util.js';
import { term } from './glossary.js';
import { state as chartState } from './chartview.js';

let current = null;

// 銘柄コードから検索ワードを作る
const QUERY_NAMES = {
  'USDJPY=X': 'ドル円', 'EURJPY=X': 'ユーロ円', 'GBPJPY=X': 'ポンド円', 'AUDJPY=X': '豪ドル円', 'NZDJPY=X': 'NZドル円',
  'CADJPY=X': 'カナダドル円', 'CHFJPY=X': 'スイスフラン円', 'ZARJPY=X': '南アフリカランド円', 'MXNJPY=X': 'メキシコペソ円', 'TRYJPY=X': 'トルコリラ円',
  'EURUSD=X': 'ユーロドル', 'GBPUSD=X': 'ポンドドル', 'AUDUSD=X': '豪ドル 米ドル', '^N225': '日経平均', '^DJI': 'NYダウ', '^GSPC': 'S&P500',
};

export function queryFor(st) {
  return QUERY_NAMES[st.symbol] || (st.name && st.name !== st.symbol ? st.name : st.symbol.replace(/\.T$|=X$/, ''));
}

function verdictBadge(v) {
  return v === '信頼' ? 'ok' : v === '要注意' ? 'warn' : 'bad';
}

function renderNews() {
  if (!current) return;
  const show = $('show-excluded').checked;
  const s = current.summary;
  $('news-summary').innerHTML = `
    <div class="grid2">
      <div class="stat"><div class="label">ニュースの雰囲気</div><div class="value ${signalClass(s.mood) === 'buy' ? 'plus' : signalClass(s.mood) === 'sell' ? 'minus' : ''}">${esc(s.mood)}</div></div>
      <div class="stat"><div class="label">上昇材料 / 下落材料</div><div class="value num">${s.bullish} / ${s.bearish}</div></div>
    </div>
    <p class="small muted" style="margin:8px 0 0">直近7日の${s.total}件を確認し、信頼度の低い${s.excluded}件を除外しました。</p>`;
  const items = current.items.filter((it) => show || it.verdict !== '除外');
  $('news-list').innerHTML = items.map((it) => `
    <li><div class="li-head"><span class="badge ${verdictBadge(it.verdict)}">${esc(it.verdict)} ${it.credibility}</span>
      <span class="small muted grow">${esc(it.source)}・${esc(it.date ? new Date(it.date).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')}</span>
      <span class="badge ${signalClass(it.impact)}">${esc(it.impact)}</span></div>
      <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" style="display:block;margin:4px 0;color:var(--text);font-weight:600;text-decoration:none">${esc(it.title)}</a>
      <div class="small muted">${esc(it.reason)}</div></li>`).join('') || '<li class="empty">表示できるニュースがありません</li>';
}

export async function searchNews(q) {
  $('news-q').value = q;
  $('news-list').innerHTML = '<li class="empty"><span class="spinner"></span></li>';
  try {
    current = await api(`/api/news?q=${encodeURIComponent(q)}`);
    renderNews();
  } catch (e) {
    $('news-list').innerHTML = `<li class="error">${esc(e.message)}</li>`;
  }
}

export function initNewsView() {
  $('news-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('news-q').value.trim();
    if (q) searchNews(q);
  });
  $('show-excluded').addEventListener('change', renderNews);
}

// チャートで銘柄が変わったらニュースも切り替える
export function onSymbol(st) {
  const q = queryFor(st);
  if (!current || current.query !== q) searchNews(q);
}
