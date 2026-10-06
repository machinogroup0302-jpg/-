// ニュース画面：無料のニュース収集（信頼度つき）と、AIによる詳しい調査
import { api, $, esc, store, busy, signalClass } from './util.js';
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

function renderResearch(r, when) {
  const f = r.fundamentals || {};
  const news = (r.news || []).slice().sort((a, b) => (b.credibility || 0) - (a.credibility || 0));
  const kept = news.filter((n) => n.verdict !== '除外');
  const dropped = news.filter((n) => n.verdict === '除外');
  const o = r.outlook || {};
  $('ai-research-out').innerHTML = `
    <p class="small muted" style="margin:10px 0 4px">${esc(when)} の調査結果</p>
    <h3>見通し <span class="badge ${signalClass(o.direction || '')}">${esc(o.direction || '—')}</span></h3>
    <p class="small"><b>短期:</b> ${esc(o.short_term || '')}<br><b>中期:</b> ${esc(o.mid_term || '')}</p>
    ${(o.risks || []).length ? `<p class="small"><b>注意するリスク:</b> ${(o.risks || []).map(esc).join(' / ')}</p>` : ''}
    <h3>ファンダメンタルズ分析</h3>
    <p class="small">${esc(f.summary || '')}</p>
    <ul class="list">${(f.factors || []).map((x) => `<li><div class="li-head"><span class="name small">${esc(x.name)}</span><span class="badge ${signalClass(x.direction || '')}">${esc(x.direction)}</span></div><div class="small muted">${esc(x.detail)}</div></li>`).join('')}</ul>
    ${r.sns ? `<h3>SNS・掲示板の雰囲気</h3><p class="small">${esc(r.sns.summary || '')}${r.sns.bullish_percent != null ? `（強気 ${Math.round(r.sns.bullish_percent)}%）` : ''}</p>
      ${(r.sns.rumors || []).length ? `<p class="small muted"><b>除外した噂:</b> ${(r.sns.rumors || []).map(esc).join(' / ')}</p>` : ''}` : ''}
    ${(r.events || []).length ? `<h3>今後の予定</h3><ul class="list">${r.events.map((e) => `<li class="small"><span class="badge ${e.importance === '高' ? 'bad' : e.importance === '中' ? 'warn' : 'neutral'}">${esc(e.importance)}</span> ${esc(e.date)} ${esc(e.name)}</li>`).join('')}</ul>` : ''}
    <h3>確認できた情報（${kept.length}件）</h3>
    <ul class="list">${kept.map((n) => `<li><div class="li-head"><span class="badge ${verdictBadge(n.verdict)}">${esc(n.verdict)} ${esc(n.credibility)}</span><span class="small muted grow">${esc(n.source)} ${esc(n.date || '')}</span><span class="badge ${signalClass(n.impact || '')}">${esc(n.impact)}</span></div>
      ${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--text);font-weight:600;text-decoration:none">${esc(n.title)}</a>` : `<b>${esc(n.title)}</b>`}<div class="small muted">${esc(n.reason)}</div></li>`).join('')}</ul>
    ${dropped.length ? `<details class="small" style="margin-top:8px"><summary>除外した情報（${dropped.length}件）</summary><ul class="list">${dropped.map((n) => `<li><b>${esc(n.title)}</b> <span class="muted">${esc(n.source)}</span><div class="muted">${esc(n.reason)}</div></li>`).join('')}</ul></details>` : ''}`;
}

function updateResearchTarget() {
  $('ai-research-name').textContent = chartState.name || chartState.symbol;
  const saved = store.get('research_' + chartState.symbol, null);
  if (saved) renderResearch(saved.result, saved.when);
  else $('ai-research-out').innerHTML = '';
}

export function initNewsView() {
  $('news-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('news-q').value.trim();
    if (q) searchNews(q);
  });
  $('show-excluded').addEventListener('change', renderNews);
  $('ai-research').addEventListener('click', async () => {
    const btn = $('ai-research');
    busy(btn, true, 'AIが調べています（1〜2分）…');
    try {
      const result = await api('/api/ai/research', { method: 'POST', body: { symbol: chartState.symbol, name: chartState.name } });
      const when = new Date().toLocaleString('ja-JP');
      store.set('research_' + chartState.symbol, { result, when });
      renderResearch(result, when);
    } catch (e) {
      $('ai-research-out').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    } finally {
      busy(btn, false);
      $('ai-research-name').textContent = chartState.name || chartState.symbol;
    }
  });
}

// チャートで銘柄が変わったらニュースも切り替える
export function onSymbol(st) {
  updateResearchTarget();
  const q = queryFor(st);
  if (!current || current.query !== q) searchNews(q);
}
