// ファンダメンタルズ分析の表（テクニカル分析の表と同じように「上がる要因／下がる要因」で判定）
// ・株：会社の数字（割安さ・成長・稼ぐ力・借金など）と、最近のニュースの雰囲気
// ・為替：米国の金利、世界の不安の大きさ（恐怖指数）、株価の流れ、介入などのニュース
import { fetchQuoteSummary } from './ratings.js';
import { getChart } from './market.js';
import { getNews } from './news.js';

const raw = (v) => (v && typeof v === 'object' ? v.raw : v) ?? null;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

function summarize(rows) {
  const score = rows.reduce((s, r) => s + (r.signal === '上がる要因' ? 1 : r.signal === '下がる要因' ? -1 : 0), 0);
  const n = rows.filter((r) => r.signal !== 'データなし').length || 1;
  const ratio = score / n;
  const label = ratio >= 0.4 ? '上がる要因が多い' : ratio >= 0.15 ? 'やや上がる要因が多い' : ratio <= -0.4 ? '下がる要因が多い' : ratio <= -0.15 ? 'やや下がる要因が多い' : '五分五分';
  return { rows, score, ratio, label };
}

// ---------------- 株 ----------------
export function stockRows(sd = {}, ks = {}, fd = {}) {
  const rows = [];
  const add = (key, name, value, signal, detail) => rows.push({ key, name, value, signal, detail });
  const per = raw(sd.trailingPE) ?? raw(ks.forwardPE);
  if (per != null) add('per', '株価の割安さ（PER）', `${per.toFixed(1)}倍`, per < 12 ? '上がる要因' : per > 30 ? '下がる要因' : '中立',
    per < 12 ? '利益に比べて株価が安い（割安）' : per > 30 ? '利益に比べて株価が高い（割高）。期待が大きい分、悪いニュースで下がりやすい' : 'ふつうの水準');
  const pbr = raw(ks.priceToBook);
  if (pbr != null) add('pbr', '会社の財産に比べた株価（PBR）', `${pbr.toFixed(2)}倍`, pbr < 1 ? '上がる要因' : pbr > 5 ? '下がる要因' : '中立',
    pbr < 1 ? '会社の財産より株価が安い（解散価値割れ）。見直されると上がりやすい' : pbr > 5 ? '財産に比べてかなり高く評価されている' : 'ふつうの水準');
  const dy = raw(sd.dividendYield) ?? raw(sd.trailingAnnualDividendYield);
  if (dy != null) add('dividend', '配当の多さ（配当利回り）', pct(dy), dy >= 0.03 ? '上がる要因' : '中立', dy >= 0.03 ? '配当が多く、買われやすい' : dy > 0 ? 'ふつうの配当' : '配当なし');
  const rg = raw(fd.revenueGrowth);
  if (rg != null) add('growth', '売上の伸び（前年比）', pct(rg), rg > 0.1 ? '上がる要因' : rg < 0 ? '下がる要因' : '中立', rg > 0.1 ? '売上が大きく伸びている' : rg < 0 ? '売上が減っている' : '少し伸びている');
  const eg = raw(fd.earningsGrowth);
  if (eg != null) add('growth', '利益の伸び（前年比）', pct(eg), eg > 0.1 ? '上がる要因' : eg < 0 ? '下がる要因' : '中立', eg > 0.1 ? '利益が大きく伸びている' : eg < 0 ? '利益が減っている' : '少し伸びている');
  const roe = raw(fd.returnOnEquity);
  if (roe != null) add('roe', '稼ぐ力（ROE）', pct(roe), roe > 0.1 ? '上がる要因' : roe < 0.05 ? '下がる要因' : '中立', roe > 0.1 ? 'お金を効率よく使って稼いでいる' : roe < 0.05 ? '稼ぐ力が弱い' : 'ふつう');
  const pm = raw(fd.profitMargins);
  if (pm != null) add('margin', '売上に対する利益（利益率）', pct(pm), pm > 0.1 ? '上がる要因' : pm < 0 ? '下がる要因' : '中立', pm > 0.1 ? 'もうけがしっかり出ている' : pm < 0 ? '赤字' : 'ふつう');
  const de = raw(fd.debtToEquity);
  if (de != null) add('debt', '借金の多さ（負債比率）', `${de.toFixed(0)}%`, de < 50 ? '上がる要因' : de > 200 ? '下がる要因' : '中立', de < 50 ? '借金が少なく安心' : de > 200 ? '借金が多い。金利が上がると負担が重くなる' : 'ふつう');
  const tp = raw(fd.targetMeanPrice), price = raw(fd.currentPrice);
  if (tp && price) {
    const up = tp / price - 1;
    add('target', 'アナリストの目標株価との差', `${up >= 0 ? '+' : ''}${(up * 100).toFixed(1)}%`, up > 0.15 ? '上がる要因' : up < -0.05 ? '下がる要因' : '中立',
      up > 0.15 ? '専門家は今よりかなり高い値段が妥当と見ている' : up < -0.05 ? '専門家は今の値段は高すぎると見ている' : '今の値段とだいたい同じ');
  }
  return rows;
}

async function stockFundamentals(symbol, name) {
  const [json, news] = await Promise.all([
    fetchQuoteSummary(symbol, 'summaryDetail,defaultKeyStatistics,financialData').catch(() => null),
    name ? getNews(name).catch(() => null) : null,
  ]);
  const r = json?.quoteSummary?.result?.[0] || {};
  const rows = stockRows(r.summaryDetail, r.defaultKeyStatistics, r.financialData);
  if (news?.summary) rows.push(newsRow(news.summary, '上がる要因', '下がる要因'));
  return summarize(rows);
}

function newsRow(s, upLabel, downLabel) {
  const total = s.bullish + s.bearish;
  return {
    key: 'news', name: '最近のニュースの雰囲気', value: `良い${s.bullish}件・悪い${s.bearish}件`,
    signal: !total ? '中立' : s.bullish > s.bearish * 1.3 ? upLabel : s.bearish > s.bullish * 1.3 ? downLabel : '中立',
    detail: !total ? '目立つニュースはない' : s.bullish > s.bearish ? '良いニュースの方が多い' : s.bearish > s.bullish ? '悪いニュースの方が多い' : '良いニュースと悪いニュースが同じくらい',
  };
}

// ---------------- 為替 ----------------
async function monthChange(symbol) {
  const d = await getChart(symbol, '1d');
  const c = d.candles;
  if (c.length < 23) return null;
  return { last: c[c.length - 1].close, change: c[c.length - 1].close - c[c.length - 22].close, ratio: c[c.length - 1].close / c[c.length - 22].close - 1 };
}

export function fxRows({ pair, tnx, vix, nikkei, interventionNews }) {
  const base = pair.slice(0, 3), quote = pair.slice(3, 6);
  const rows = [];
  // 「この通貨ペアが上がる／下がる」に直す。up=true なら、その出来事が base 通貨を強くする
  const dir = (strengthens) => (strengthens == null ? '中立' : strengthens ? '上がる要因' : '下がる要因');
  const add = (key, name, value, signal, detail) => rows.push({ key, name, value, signal, detail });

  if (tnx && (base === 'USD' || quote === 'USD')) {
    const rising = tnx.change > 0.1, falling = tnx.change < -0.1;
    const usdStrong = rising ? true : falling ? false : null;
    add('rate', '米国の長期金利（10年）', `${tnx.last.toFixed(2)}%（1か月で${tnx.change >= 0 ? '+' : ''}${tnx.change.toFixed(2)}）`,
      dir(usdStrong == null ? null : base === 'USD' ? usdStrong : !usdStrong),
      rising ? '金利が上がるとドルを持つ人が増え、ドル高になりやすい' : falling ? '金利が下がるとドルが売られ、ドル安になりやすい' : '大きな変化はない');
  }
  if (vix && (base === 'JPY' || quote === 'JPY')) {
    const fear = vix.last > 25, calm = vix.last < 16;
    const yenStrong = fear ? true : calm ? false : null;
    add('vix', '世界の不安の大きさ（恐怖指数VIX）', vix.last.toFixed(1), dir(yenStrong == null ? null : base === 'JPY' ? yenStrong : !yenStrong),
      fear ? '不安が大きいと、安全な円が買われて円高になりやすい' : calm ? '落ち着いていると円が売られ、円安になりやすい' : 'ふつうの水準');
  }
  if (nikkei && (base === 'JPY' || quote === 'JPY')) {
    const up = nikkei.ratio > 0.03, down = nikkei.ratio < -0.03;
    const yenStrong = up ? false : down ? true : null;
    add('stocks', '日本の株価の流れ（日経平均・1か月）', `${nikkei.ratio >= 0 ? '+' : ''}${(nikkei.ratio * 100).toFixed(1)}%`, dir(yenStrong == null ? null : base === 'JPY' ? yenStrong : !yenStrong),
      up ? '株が上がって安心感があると、円が売られやすい（円安）' : down ? '株が下がると、円が買われやすい（円高）' : '大きな変化はない');
  }
  if (interventionNews != null && (base === 'JPY' || quote === 'JPY')) {
    const many = interventionNews >= 2;
    add('intervention', '為替介入のニュース（直近7日）', `${interventionNews}件`, many ? (quote === 'JPY' ? '下がる要因' : '上がる要因') : '中立',
      many ? '国が円安を止めるために円を買う（介入）おそれがあり、急な円高に注意' : '介入の話題は少ない');
  }
  return rows;
}

async function fxFundamentals(symbol, name) {
  const pair = symbol.replace(/=X$/, '');
  const [tnx, vix, nikkei, news, iv] = await Promise.all([
    monthChange('^TNX').catch(() => null),
    monthChange('^VIX').catch(() => null),
    monthChange('^N225').catch(() => null),
    name ? getNews(name).catch(() => null) : null,
    /JPY/.test(pair) ? getNews('為替介入').catch(() => null) : null,
  ]);
  const interventionNews = iv ? iv.items.filter((x) => x.verdict !== '除外' && /介入/.test(x.title)).length : null;
  const rows = fxRows({ pair, tnx, vix, nikkei, interventionNews });
  if (news?.summary) rows.push(newsRow(news.summary, '上がる要因', '下がる要因'));
  return summarize(rows);
}

const cache = new Map();

export async function getFundamentals(symbol, name) {
  const key = `${symbol}|${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const data = /=X$/.test(symbol) ? await fxFundamentals(symbol, name) : await stockFundamentals(symbol, name);
  cache.set(key, { at: Date.now(), data });
  return data;
}
