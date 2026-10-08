// ニュース画面：無料のニュース収集（信頼度つき）と、AIによる詳しい調査
import { api, $, esc, store, busy, signalClass } from './util.js';
import { term } from './glossary.js';
import { state as chartState } from './chartview.js';

let current = null;
let crowdKey = '';

// みんなの声：掲示板・SNS・個人ブログの投稿から、強気（上がる）と弱気（下がる）の割合を出す
export async function updateCrowd(st, mode, { silent = false } = {}) {
  const box = $('crowd-box');
  if (!st?.symbol) return;
  const key = `${mode}|${st.symbol}`;
  if (!silent || crowdKey !== key) box.innerHTML = '<p class="small muted"><span class="spinner"></span> 掲示板やブログの声を集めています…</p>';
  crowdKey = key;
  $('crowd-name').textContent = queryFor(st);
  let d;
  try {
    d = await api(`/api/crowd?symbol=${encodeURIComponent(st.symbol)}&name=${encodeURIComponent(queryFor(st))}&mode=${mode}`);
  } catch (e) { if (crowdKey === key) box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  if (crowdKey !== key) return;
  const src = d.sources.map((x) => `${esc(x.label)}${x.ok ? `（${x.n}件）` : '（取得できませんでした）'}`).join('・');
  if (d.bullPct == null) {
    box.innerHTML = `<p class="small muted">強気・弱気が分かる投稿が見つかりませんでした。</p><p class="small muted">調べた場所：${src}</p>`;
    return;
  }
  const bp = Math.round(d.bullPct * 100);
  const mood = bp >= 65 ? '強気（買いが強い）' : bp <= 35 ? '弱気（売りが強い）' : '五分五分';
  box.innerHTML = `
    <div class="li-head"><b>${mood}</b><span class="small muted">${d.bull + d.bear}件の投稿から</span></div>
    <div class="crowd-bar" style="display:flex;height:12px;border-radius:999px;overflow:hidden;margin:6px 0">
      <i style="width:${bp}%;background:var(--buy)"></i><i style="width:${100 - bp}%;background:var(--sell)"></i></div>
    <div class="small"><span class="plus">強気（上がる）${bp}%・${d.bull}件</span>　／　<span class="minus">弱気（下がる）${100 - bp}%・${d.bear}件</span>${d.sure ? `　／　「絶対」「確定」など言い切り ${d.sure}件` : ''}</div>
    ${d.samples.length ? `<details class="more-box"><summary>投稿の例を見る</summary><ul class="list">${d.samples.map((x) => `<li class="small"><span class="badge ${x.sent > 0 ? 'buy' : 'sell'}">${x.sent > 0 ? '強気' : '弱気'}</span>${x.sure ? '<span class="badge warn">言い切り</span>' : ''} ${esc(x.text)} <span class="muted">（${esc(x.source || '')}）</span></li>`).join('')}</ul></details>` : ''}
    <p class="notice" style="margin-top:8px">個人の投稿は、根拠のない願望や「絶対上がる」のような言い切りも多いので、参考程度にしてください。みんなが強気に偏りすぎているときは、逆に天井（下がる前）のこともあります。調べた場所：${src}。X（旧Twitter）は無料で読み取る方法がないため入っていません。</p>`;
}

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

export async function searchNews(q, { silent = false } = {}) {
  $('news-q').value = q;
  if (!silent) $('news-list').innerHTML = '<li class="empty"><span class="spinner"></span></li>';
  try {
    current = await api(`/api/news?q=${encodeURIComponent(q)}`);
    renderNews();
  } catch (e) {
    if (!silent) $('news-list').innerHTML = `<li class="error">${esc(e.message)}</li>`;
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
