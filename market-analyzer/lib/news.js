// ニュースの自動収集と信頼度スコア（AIなし・無料で動く版）
// Google ニュースのRSSを集め、情報源の信頼度・あおり表現・他メディアでの裏付けから点数を付ける

const UA = 'Mozilla/5.0 (compatible; market-analyzer/1.0)';

// 情報源ごとの基本の信頼度（0〜1）
const SOURCE_TRUST = [
  [/日本銀行|日銀|財務省|金融庁|内閣府|日本取引所|JPX|東京証券取引所|FRB|連邦準備/i, 0.95],
  [/日本経済新聞|日経|ロイター|Reuters|ブルームバーグ|Bloomberg|NHK|時事|共同通信|ウォール・ストリート|WSJ|Financial Times/i, 0.9],
  [/朝日新聞|読売新聞|毎日新聞|産経|東京新聞|テレビ東京|テレ東|TBS|フジテレビ|日テレ|ANN/i, 0.8],
  [/東洋経済|ダイヤモンド|プレジデント|ITmedia|四季報|モーニングスター|QUICK|フィスコ|FISCO/i, 0.75],
  [/株探|かぶたん|Kabutan|みんかぶ|Yahoo|ヤフー|ZAi|ザイ|トレーダーズ・ウェブ|外為どっとコム|MINKABU|楽天証券|SBI|マネックス|松井証券|ヒロセ通商|GMO/i, 0.65],
  [/note|アメーバ|ameblo|ライブドアブログ|livedoor|fc2|はてな|まとめ|2ch|5ch|ブログ|YouTube|TikTok/i, 0.25],
];

// あおり・誇張表現（デマや煽り記事によく出る言葉）
const HYPE_WORDS = ['爆上げ', '爆益', '確実', '必ず', '絶対', '100%', '億り人', '緊急', '暴落確定', '大暴落', '今すぐ', '衝撃', '激震', '知らないと損', '神', 'ヤバい', 'やばい', '仕手', '噂', 'リーク', '内部情報'];

const BULL_WORDS = ['上昇', '高値', '反発', '続伸', '急伸', '買い', '好調', '増益', '上方修正', '最高益', '増配', '自社株買い', '利上げ観測', '強気', '回復', '上抜け'];
const BEAR_WORDS = ['下落', '安値', '反落', '続落', '急落', '売り', '不振', '減益', '下方修正', '赤字', '減配', '懸念', '弱気', '悪化', '下抜け', '警戒'];

export function sourceTrust(source) {
  for (const [re, score] of SOURCE_TRUST) if (re.test(source || '')) return score;
  return 0.45;
}

function bigrams(s) {
  const t = String(s).replace(/[\s「」『』【】()（）、。・!！?？:：\-]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : '';
}

export function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    let title = tag(block, 'title');
    let source = tag(block, 'source');
    // Google ニュースのタイトルは「見出し - 媒体名」
    const dash = title.lastIndexOf(' - ');
    if (dash > 0) {
      if (!source) source = title.slice(dash + 3);
      title = title.slice(0, dash);
    }
    items.push({
      title,
      source: source || '不明',
      url: tag(block, 'link'),
      date: tag(block, 'pubDate'),
    });
  }
  return items;
}

export function scoreItems(items) {
  const grams = items.map((it) => bigrams(it.title));
  return items.map((it, i) => {
    const base = sourceTrust(it.source);
    const hype = HYPE_WORDS.filter((w) => it.title.includes(w));
    // 別の媒体が似た内容を報じていれば裏付けありとみなす
    const others = new Set();
    for (let j = 0; j < items.length; j++) {
      if (j !== i && items[j].source !== it.source && similarity(grams[i], grams[j]) >= 0.3) others.add(items[j].source);
    }
    const corroboration = Math.min(others.size, 3);
    let score = base * 100 - Math.min(hype.length, 3) * 15 + corroboration * 7;
    score = Math.max(0, Math.min(100, Math.round(score)));

    const bull = BULL_WORDS.filter((w) => it.title.includes(w)).length;
    const bear = BEAR_WORDS.filter((w) => it.title.includes(w)).length;
    const impact = bull > bear ? '上昇材料' : bear > bull ? '下落材料' : '中立';

    const reasons = [];
    reasons.push(base >= 0.8 ? '信頼性の高い大手メディア・公的機関' : base >= 0.6 ? '金融系の専門メディア' : base <= 0.3 ? '個人ブログ・SNS系の情報源' : '情報源の信頼度は不明');
    if (hype.length) reasons.push(`あおり表現あり（${hype.join('、')}）`);
    if (corroboration) reasons.push(`他の${others.size}媒体でも報道あり`);
    else reasons.push('他の媒体での裏付けなし');

    const verdict = score >= 65 ? '信頼' : score >= 40 ? '要注意' : '除外';
    return { ...it, credibility: score, verdict, impact, reason: reasons.join(' / '), corroboratedBy: [...others] };
  });
}

export async function fetchRss(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`ニュース取得に失敗しました (HTTP ${res.status})`);
  return parseRss(await res.text());
}

const cache = new Map();

export async function getNews(query) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) throw new Error('検索ワードが空です');
  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=ja&gl=JP&ceid=JP:ja`;
  const raw = (await fetchRss(url)).slice(0, 60);
  // 同じ見出しの重複を除く
  const seen = new Set();
  const items = raw.filter((it) => (seen.has(it.title) ? false : seen.add(it.title)));
  const scored = scoreItems(items).sort((a, b) => new Date(b.date) - new Date(a.date));

  const kept = scored.filter((x) => x.verdict !== '除外');
  const up = kept.filter((x) => x.impact === '上昇材料').length;
  const down = kept.filter((x) => x.impact === '下落材料').length;
  const data = {
    query: q,
    items: scored,
    summary: {
      total: scored.length,
      excluded: scored.length - kept.length,
      bullish: up,
      bearish: down,
      mood: up > down * 1.3 ? '強気寄り' : down > up * 1.3 ? '弱気寄り' : '中立',
    },
  };
  cache.set(q, { at: Date.now(), data });
  return data;
}
