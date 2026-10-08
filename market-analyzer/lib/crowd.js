// 「みんなの声」：個人投資家が掲示板・SNS・ブログでどう思っているか（買いが強いか、売りが強いか）
// ・日本株：Yahoo!ファイナンスの掲示板
// ・米国株：StockTwits（米国の投資家SNS。投稿に「強気・弱気」の印が付いている）
// ・全部：Google ニュースに出てくる個人ブログ・まとめなど
// ※ X（旧Twitter）は無料で読み取る方法がないので入れていない
// ※ 根拠のない願望や言い切りも多いので、あくまで「雰囲気」の目安
import { fetchRss, sourceTrust } from './news.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BULL = ['上がる', '上がれ', '上がり', '爆上げ', '買い増し', '買い時', '買いだ', '押し目', '反発', '上昇', '期待', 'ストップ高', '底打ち', '底値', '上抜け', '握力', 'ガチホ', '爆益', '強い', '最高値', '踏み上げ', 'まだ上', '🚀', 'GU', 'ギャップアップ', '買い', 'ロング'];
const BEAR = ['下がる', '下がれ', '下がり', '暴落', '売り時', '損切', '逃げ', '下落', '弱い', '終わり', 'ストップ安', '天井', 'オワコン', '空売り', '下抜け', '撤退', '含み損', '爆損', '売り', 'ショート', 'GD', 'ギャップダウン', '崩れ', '悲報'];
const SURE = ['確定', '絶対', '間違いない', '間違いなく', '必ず', '確実', '100%', '断言'];

// 1つの投稿が強気（1）・弱気（-1）・どちらでもない（0）か
export function sentimentOf(text) {
  const t = String(text);
  let b = 0, s = 0;
  for (const w of BULL) if (t.includes(w)) b++;
  for (const w of BEAR) if (t.includes(w)) s++;
  // 「買い」「売り」は「買い増し」「売り時」などと重なるので、長い言葉が当たっていれば短い方は数えない
  return b > s ? 1 : s > b ? -1 : 0;
}

export function summarize(posts) {
  const scored = posts.map((p) => ({ ...p, sent: p.sent ?? sentimentOf(p.text), sure: SURE.some((w) => p.text.includes(w)) }));
  const bull = scored.filter((p) => p.sent > 0).length, bear = scored.filter((p) => p.sent < 0).length;
  const judged = bull + bear;
  return {
    posts: scored.length, bull, bear, neutral: scored.length - judged,
    bullPct: judged ? bull / judged : null,
    sure: scored.filter((p) => p.sure).length,
    samples: scored.filter((p) => p.sent !== 0).slice(0, 8).map((p) => ({ text: p.text.slice(0, 90), sent: p.sent, sure: p.sure, source: p.source })),
  };
}

const decode = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\//g, '/');
const stripTags = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// 掲示板のページから投稿の文章を取り出す（ページの作りが変わっても、なるべく取れるように2通りで探す）
export function parseBoard(html) {
  // 1) ページに埋め込まれたデータ（"body":"…" のような形）から
  const fromJson = [...html.matchAll(/"(?:body|text|comment|content|message)"\s*:\s*"((?:\\.|[^"\\]){8,400})"/g)].map((m) => decode(m[1]).trim());
  const uniq = (a) => [...new Set(a)].filter((t) => /[ぁ-んァ-ン一-龥]/.test(t));
  if (uniq(fromJson).length >= 5) return uniq(fromJson).slice(0, 100);
  // 2) 画面の文字から、投稿らしい長さの行を拾う
  const lines = stripTags(html).split(/\n+/).map((x) => x.trim()).filter((x) => x.length >= 8 && x.length <= 400);
  return uniq(lines).filter((t) => sentimentOf(t) !== 0).slice(0, 100);
}

async function get(url, accept = 'text/html') {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'ja,en;q=0.8' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function yahooBoard(code) {
  const html = await (await get(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T/bbs`)).text();
  return parseBoard(html).map((text) => ({ text, source: 'Yahoo!ファイナンス掲示板' }));
}

async function stocktwits(sym) {
  const j = await (await get(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`, 'application/json')).json();
  return (j.messages || []).map((m) => {
    const tag = m.entities?.sentiment?.basic;
    return { text: String(m.body || ''), source: 'StockTwits', sent: tag === 'Bullish' ? 1 : tag === 'Bearish' ? -1 : undefined };
  });
}

async function blogs(name) {
  const items = await fetchRss(`https://news.google.com/rss/search?q=${encodeURIComponent(`${name} 株価 予想 OR ${name} 掲示板 when:7d`)}&hl=ja&gl=JP&ceid=JP:ja`);
  // 個人ブログ・まとめ・個人向けの投稿サイトなど（大手の記者が書いたものではないもの）
  return items.filter((x) => sourceTrust(x.source) <= 0.45).map((x) => ({ text: x.title, source: x.source }));
}

const cache = new Map();
export async function getCrowd({ symbol, name, mode }) {
  const key = `${mode}|${symbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.data;
  const code = String(symbol).replace(/\.T$|=X$/, '');
  const jobs = [];
  if (mode === 'stock' && /^[0-9][0-9A-Z]{3}$/.test(code)) jobs.push(['Yahoo!ファイナンス掲示板', yahooBoard(code)]);
  if (mode === 'us') jobs.push(['StockTwits', stocktwits(code)]);
  if (name) jobs.push(['個人ブログ・まとめ', blogs(name)]);
  const sources = [];
  const posts = [];
  for (const [label, p] of jobs) {
    try {
      const got = await p;
      sources.push({ label, ok: true, n: got.length });
      posts.push(...got);
    } catch (e) {
      sources.push({ label, ok: false, error: e.message });
    }
  }
  const data = { symbol, at: Date.now(), sources, ...summarize(posts) };
  cache.set(key, { at: Date.now(), data });
  return data;
}
