import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, technicalSummary } from '../public/js/indicators.js';
import { supportResistance, trendlines, pivots } from '../public/js/levels.js';
import { monteCarlo, futureTimes } from '../public/js/forecast.js';
import { parseCsv, findHeader, guessMapping, rowsToTrades, computeStats, insights, toNumber, parseDate } from '../public/js/trades.js';
import { parseRss, scoreItems } from '../lib/news.js';
import { parseChart, aggregateCandles, normalizeSymbol } from '../lib/market.js';

// 波打ちながら上がる架空の値動き
function makeCandles(n = 300, start = 150) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = start + i * 0.02 + Math.sin(i / 8) * 1.5;
    out.push({ time: 1_700_000_000 + i * 3600, open: o, high: Math.max(o, p) + 0.1, low: Math.min(o, p) - 0.1, close: p, volume: 100 });
  }
  return out;
}

test('移動平均・EMA', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3);
});

test('RSI は上昇だけなら100、下落だけなら0', () => {
  const up = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(rsi(up).at(-1), 100);
  const down = up.slice().reverse();
  assert.equal(rsi(down).at(-1), 0);
});

test('MACD・ボリンジャーの長さが揃う', () => {
  const v = makeCandles().map((c) => c.close);
  const m = macd(v);
  assert.equal(m.line.length, v.length);
  const bb = bollinger(v);
  assert.ok(bb.upper.at(-1) > bb.mid.at(-1) && bb.mid.at(-1) > bb.lower.at(-1));
});

test('テクニカルの一覧に判定が付く', () => {
  const t = technicalSummary(makeCandles());
  assert.ok(t.rows.length >= 8);
  for (const r of t.rows) assert.ok(['買い', '売り', '中立'].includes(r.signal));
  assert.ok(['強い買い', '買い', '中立', '売り', '強い売り'].includes(t.label));
});

test('抵抗線・支持線は現在値の上下に分かれる', () => {
  const c = makeCandles();
  const price = c.at(-1).close;
  const lv = supportResistance(c);
  assert.ok(lv.length > 0);
  for (const l of lv) {
    if (l.kind === 'resistance') assert.ok(l.price > price);
    else assert.ok(l.price <= price);
  }
});

test('トレンドラインとピボット', () => {
  const tl = trendlines(makeCandles());
  for (const t of tl) assert.ok(t.to.time > t.from.time);
  const p = pivots({ high: 110, low: 100, close: 105 });
  assert.equal(p.P, 105);
  assert.ok(p.R1 > p.P && p.S1 < p.P);
});

test('予想は幅が順番どおりで、未来の時刻は土日を飛ばす', () => {
  const c = makeCandles();
  const fc = monteCarlo(c, { horizon: 10, paths: 500 });
  for (const b of fc.bands) assert.ok(b.p05 <= b.p25 && b.p25 <= b.p50 && b.p50 <= b.p75 && b.p75 <= b.p95);
  assert.ok(fc.upProb >= 0 && fc.upProb <= 1);
  const fri = Date.UTC(2026, 9, 2, 12) / 1000; // 2026/10/2 金曜
  const ft = futureTimes([{ time: fri - 86400 }, { time: fri }], 2, '1d');
  assert.equal(new Date(ft[0] * 1000).getUTCDay(), 1);
});

test('楽天証券っぽいCSVを読み込める', () => {
  const csv = [
    '"取引履歴"',
    '"約定日時","通貨ペア","売買","取引数量","約定価格","決済損益","スワップ","手数料"',
    '"2026/09/01 10:15","USD/JPY","売","10,000","146.500","3,200","10","0"',
    '"2026/09/02 22:40","EUR/JPY","買","10,000","157.200","▲5,000","0","0"',
    '"2026/09/03 09:05","USD/JPY","買","10,000","147.000","1,500","-20","0"',
  ].join('\r\n');
  const rows = parseCsv(csv);
  const h = findHeader(rows);
  assert.equal(h, 1);
  const map = guessMapping(rows[h]);
  assert.equal(map.date, 0);
  assert.equal(map.pnl, 5);
  const trades = rowsToTrades(rows, h, map);
  assert.equal(trades.length, 3);
  assert.equal(trades[0].pnl, 3200); // 決済損益はスワップ込みの合計なので足さない
  assert.equal(trades[1].pnl, -5000);
  assert.equal(trades[0].side, '売');
  const s = computeStats(trades);
  assert.equal(s.count, 3);
  assert.equal(Math.round(s.winRate * 100), 67);
  assert.equal(s.totalPnl, 3200 - 5000 + 1500);
  assert.equal(s.maxDrawdown, 5000);
  assert.ok(Array.isArray(insights(s)));
});

test('数値と日付の変換', () => {
  assert.equal(toNumber('▲1,234'), -1234);
  assert.equal(toNumber('(500)'), -500);
  assert.equal(toNumber('+2,000円'), 2000);
  assert.ok(Number.isNaN(toNumber('')));
  const d = parseDate('2026年9月1日 10:15');
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getHours(), 10);
});

test('ニュースの信頼度：大手で裏付けありは高く、ブログのあおりは除外', () => {
  const xml = `<rss><channel>
    <item><title>日銀、追加利上げを決定 - 日本経済新聞</title><link>https://a</link><pubDate>Mon, 05 Oct 2026 01:00:00 GMT</pubDate><source url="x">日本経済新聞</source></item>
    <item><title>日銀が追加利上げを決定、円高進む - ロイター</title><link>https://b</link><pubDate>Mon, 05 Oct 2026 02:00:00 GMT</pubDate><source url="x">ロイター</source></item>
    <item><title>【緊急】ドル円 爆上げ確実！ - アメーバブログ</title><link>https://c</link><pubDate>Mon, 05 Oct 2026 03:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = scoreItems(parseRss(xml));
  assert.equal(items.length, 3);
  assert.equal(items[2].source, 'アメーバブログ');
  assert.equal(items[0].verdict, '信頼');
  assert.ok(items[0].corroboratedBy.includes('ロイター'));
  assert.equal(items[2].verdict, '除外');
});

test('Yahoo のデータ形式を読み、4時間足にまとめる', () => {
  const json = { chart: { result: [{ meta: { symbol: 'USDJPY=X', currency: 'JPY' }, timestamp: [0, 3600, 7200, 10800, 14400], indicators: { quote: [{ open: [1, 2, 3, 4, 5], high: [2, 3, 4, 5, 6], low: [0, 1, 2, null, 4], close: [2, 3, 4, 5, 6], volume: [1, 1, 1, 1, 1] }] } }] } };
  const d = parseChart(json);
  assert.equal(d.candles.length, 4); // null の足は除く
  const agg = aggregateCandles(d.candles, 4);
  assert.equal(agg.length, 2);
  assert.equal(agg[0].open, 1);
  assert.equal(agg[0].close, 4);
  assert.equal(agg[0].high, 4);
});

test('銘柄コードの変換', () => {
  assert.equal(normalizeSymbol('usdjpy'), 'USDJPY=X');
  assert.equal(normalizeSymbol('7203'), '7203.T');
  assert.equal(normalizeSymbol('^N225'), '^N225');
  assert.throws(() => normalizeSymbol('a b<c>'));
});

import { volumeProfile, buySellPressure, vwap, summarizeTicks, splitVolume } from '../public/js/volume.js';

test('価格帯別出来高と買い売りの推定', () => {
  const c = makeCandles(200).map((x, i) => ({ ...x, volume: 1000 + (i % 10) * 100 }));
  const p = volumeProfile(c, 20);
  assert.equal(p.rows.length, 20);
  assert.ok(Math.abs(p.rows.reduce((s, r) => s + r.total, 0) - c.reduce((s, x) => s + x.volume, 0)) < 1e-6);
  assert.ok(p.valueLow <= p.poc.mid && p.poc.mid <= p.valueHigh);
  const sv = splitVolume({ open: 10, high: 12, low: 10, close: 12, volume: 100 });
  assert.equal(sv.buy, 100);
  assert.equal(buySellPressure(c).length, c.length);
  assert.equal(volumeProfile(makeCandles(50).map((x) => ({ ...x, volume: 0 }))), null); // 出来高なし（為替）は対象外
  const v = vwap([{ time: 0, high: 2, low: 0, close: 1, volume: 1 }, { time: 60, high: 5, low: 1, close: 3, volume: 3 }]);
  assert.equal(v[1], (1 * 1 + 3 * 3) / 4);
});

test('歩み値の集計と大口', () => {
  const s = summarizeTicks([
    { time: '9:00', price: 100, qty: 100, side: '買い' },
    { time: '9:01', price: 100, qty: 100, side: '売り' },
    { time: '9:02', price: 101, qty: 100, side: '買い' },
    { time: '9:03', price: 101, qty: 5000, side: '買い' },
  ]);
  assert.equal(s.buy, 5200);
  assert.equal(s.sell, 100);
  assert.equal(s.rows[0].price, 101);
  assert.equal(s.big.length, 1);
});



import * as XLSX from 'xlsx';
import { priceLimit, stopInfo } from '../public/js/limits.js';
import { parseListingRows, parseNewListings, mergeListing, shortMarket } from '../lib/listings.js';
import { parseSpark, evaluate, closesToCandles } from '../lib/scanner.js';

test('値幅制限とストップ高・安', () => {
  assert.equal(priceLimit(99), 30);
  assert.equal(priceLimit(100), 50);
  assert.equal(priceLimit(1000), 300);
  assert.equal(priceLimit(2999), 500);
  assert.equal(priceLimit(3000), 700);
  const s = stopInfo(1000, 1300);
  assert.equal(s.up, 1300);
  assert.equal(s.down, 700);
  assert.equal(s.status, 'ストップ高');
  assert.equal(stopInfo(1000, 790).status, 'ストップ安に近い');
  assert.equal(stopInfo(1000, 1010).status, null);
});

test('東証の上場銘柄一覧（Excel）を読み込む', () => {
  const rows = [
    ['日付', 'コード', '銘柄名', '市場・商品区分', '33業種コード', '33業種区分', '17業種コード', '17業種区分', '規模コード', '規模区分'],
    ['20260930', '1301', '極洋', 'プライム（内国株式）', '50', '水産・農林業', '1', '食品', '7', 'TOPIX Small 2'],
    ['20260930', '1305', 'ｉＦｒｅｅＥＴＦ　ＴＯＰＩＸ', 'ETF・ETN', '-', '-', '-', '-', '-', '-'],
    ['20260930', '130A', 'Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ', 'グロース（内国株式）', '9050', 'サービス業', '10', '情報通信', '-', '-'],
    ['20260930', 7203, 'トヨタ自動車', 'プライム（内国株式）', '3700', '輸送用機器', '6', '自動車', '1', 'TOPIX Core30'],
  ];
  // 実物と同じく .xls（古いExcel形式）にしてから読み直す
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
  const back = XLSX.read(buf, { type: 'buffer' });
  const parsed = parseListingRows(XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1, raw: false, defval: '' }));
  assert.deepEqual(parsed.map((x) => x.code), ['1301', '130A', '7203']);
  assert.equal(parsed[2].market, 'プライム');
  assert.equal(parsed[1].sector, 'サービス業');
  assert.equal(shortMarket('PRO Market'), null);
});

test('新しく上場した会社を見つける', () => {
  const prev = { items: [{ code: '1301' }], firstSeen: {} };
  const m = mergeListing(prev, [{ code: '1301' }, { code: '555A' }], [], '2026-10-06');
  assert.deepEqual(m.firstSeen, { '555A': '2026-10-06' });
  // 初回は全部が「新規」にならない
  assert.deepEqual(mergeListing(null, [{ code: '1301' }], [], '2026-10-06').firstSeen, {});
  const html = '<table><tr><th>上場日</th><th>会社名</th><th>コード</th></tr><tr><td>2026/10/21</td><td><a>サンプル株式会社</a></td><td>（555A）</td><td>グロース</td></tr></table>';
  const nl = parseNewListings(html);
  assert.equal(nl.length, 1);
  assert.equal(nl[0].code, '555A');
  assert.equal(nl[0].date, '2026-10-21');
  assert.equal(nl[0].name, 'サンプル株式会社');
});

test('まとめて取得した株価（spark）を読み、判定する', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 1000 + i * 2 + Math.sin(i / 5) * 10);
  closes[closes.length - 1] = closes[closes.length - 2] + 300; // ストップ高
  const ts = closes.map((_, i) => 1_700_000_000 + i * 86400);
  const v8 = parseSpark({ '7203.T': { symbol: '7203.T', timestamp: ts, close: closes } });
  const v7 = parseSpark({ spark: { result: [{ symbol: '7203.T', response: [{ timestamp: ts, indicators: { quote: [{ close: closes }] } }] }] } });
  assert.deepEqual(v8['7203.T'].closes, v7['7203.T'].closes);
  const r = evaluate({ code: '7203', name: 'トヨタ自動車', market: 'プライム', sector: '輸送用機器' }, v8['7203.T']);
  assert.equal(r.symbol, '7203.T');
  assert.equal(r.stop.status, 'ストップ高');
  assert.ok(r.reasons.every((x) => x.key));
  assert.equal(closesToCandles([1, 2, 3], [10, null, 12]).length, 2);
});

import { searchUs, usName } from '../lib/usstocks.js';
import { parseSummary, gradeJa, firmJa } from '../lib/ratings.js';
import { ptsSession } from '../public/js/ratingsview.js';

test('米国株のカタカナ名と検索', () => {
  assert.equal(usName('nvda'), 'エヌビディア');
  assert.equal(searchUs('えぬびでぃあ')[0].symbol, 'NVDA'); // ひらがなでも探せる
  assert.equal(searchUs('AAPL')[0].name, 'アップル');
  assert.ok(searchUs('グーグル').some((x) => x.symbol === 'GOOGL'));
  assert.equal(usName('ZZZZ'), null);
});

test('レーティングの読み取りと日本語化', () => {
  const json = { quoteSummary: { result: [{
    financialData: { currentPrice: { raw: 180 }, targetMeanPrice: { raw: 210 }, targetHighPrice: { raw: 250 }, targetLowPrice: { raw: 150 }, recommendationMean: { raw: 1.9 }, numberOfAnalystOpinions: { raw: 40 } },
    recommendationTrend: { trend: [{ period: '0m', strongBuy: 10, buy: 20, hold: 8, sell: 1, strongSell: 1 }] },
    upgradeDowngradeHistory: { history: [{ epochGradeDate: 1790000000, firm: 'Morgan Stanley', toGrade: 'Overweight', fromGrade: 'Equal-Weight', action: 'up' }] },
  }] } };
  const r = parseSummary(json);
  assert.equal(r.consensus, '買い');
  assert.equal(r.target.mean, 210);
  assert.equal(r.counts.buy, 20);
  assert.equal(r.history[0].firm, 'モルガン・スタンレー');
  assert.equal(r.history[0].to, '買い');
  assert.equal(r.history[0].from, '中立');
  assert.equal(r.history[0].action, '格上げ');
  assert.equal(gradeJa('Underperform'), '売り');
  assert.equal(firmJa('Unknown Capital'), 'Unknown Capital');
  assert.equal(parseSummary({}), null);
});

test('PTSの取引時間', () => {
  const at = (h, m, day = 6) => new Date(Date.UTC(2026, 9, day, h - 9, m)); // 日本時間で指定（10/6は火曜）
  assert.equal(ptsSession(at(9, 0)).open, true);
  assert.equal(ptsSession(at(16, 10)).open, false);
  assert.match(ptsSession(at(20, 0)).label, /ナイトタイム/);
  assert.equal(ptsSession(at(12, 0, 4)).open, false); // 日曜
  assert.equal(ptsSession(at(3, 0, 7)).open, true); // 水曜の夜中（火曜のナイトタイムの続き）
  assert.equal(ptsSession(at(3, 0, 5)).open, false); // 月曜の夜中はお休み
  assert.equal(ptsSession(at(16, 40)).open, false); // 16:00〜17:00はお休み
});

import { flowBreakdown, lastSession } from '../public/js/volume.js';
import { parseRatingHeadline } from '../lib/ratings.js';
import { stockRows, fxRows } from '../lib/fundamentals.js';
import { searchFx, fxName } from '../public/js/fxpairs.js';
import { findListLink } from '../lib/listings.js';

test('今日の売買の割合（円グラフ用）', () => {
  const old = { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 };
  const day = Array.from({ length: 30 }, (_, i) => ({ time: 100000 + i * 300, open: 100, high: 102, low: 98, close: i % 2 ? 101.5 : 99, volume: i === 15 ? 10000 : 100 }));
  const s = lastSession([old, ...day]);
  assert.equal(s.length, 30);
  const f = flowBreakdown(s);
  assert.ok(Math.abs(f.buySell.buy + f.buySell.sell - 1) < 1e-9);
  assert.ok(Math.abs(f.aggressive.buy + f.aggressive.sell + f.aggressive.flat - 1) < 1e-9);
  assert.ok(Math.abs(f.big.buy + f.big.sell + f.big.small - 1) < 1e-9);
  assert.ok(f.big.buy + f.big.sell > 0.5); // 大口の1本が大部分
  assert.equal(flowBreakdown([old]), null);
});

test('レーティングのニュース見出しを表にする', () => {
  const a = parseRatingHeadline('トヨタ、野村が目標株価引き上げ 3,000円→3,500円');
  assert.equal(a.firm, '野村証券');
  assert.equal(a.targetFrom, 3000);
  assert.equal(a.targetTo, 3500);
  assert.equal(a.up, true);
  const b = parseRatingHeadline('楽天Ｇ、ＳＭＢＣ日興が格下げ 中立に');
  assert.equal(b.firm, 'SMBC日興証券');
  assert.equal(b.to, '中立');
  assert.equal(b.down, true);
  assert.equal(parseRatingHeadline('きょうの株式市場は全面高'), null);
});

test('ファンダメンタルズの判定', () => {
  const rows = stockRows({ trailingPE: { raw: 40 } }, { priceToBook: { raw: 0.8 } }, { earningsGrowth: { raw: -0.2 }, debtToEquity: { raw: 30 } });
  const by = Object.fromEntries(rows.map((r) => [r.key + r.name, r.signal]));
  assert.equal(by['per株価の割安さ（PER）'], '下がる要因');
  assert.equal(by['pbr会社の財産に比べた株価（PBR）'], '上がる要因');
  assert.equal(rows.find((r) => r.name.startsWith('利益の伸び')).signal, '下がる要因');
  assert.equal(rows.find((r) => r.key === 'debt').signal, '上がる要因');
  // 米金利が上がる → ドル円は上がる要因、ユーロドルは下がる要因
  assert.equal(fxRows({ pair: 'USDJPY', tnx: { last: 4.5, change: 0.3 } })[0].signal, '上がる要因');
  assert.equal(fxRows({ pair: 'EURUSD', tnx: { last: 4.5, change: 0.3 } })[0].signal, '下がる要因');
  // 恐怖指数が高い → クロス円は下がる要因
  assert.equal(fxRows({ pair: 'AUDJPY', vix: { last: 30 } })[0].signal, '下がる要因');
});

test('通貨ペアの日本語検索と、一覧ファイルの場所探し', () => {
  assert.equal(searchFx('どるえん')[0].code, 'USDJPY');
  assert.equal(searchFx('ポンド')[0].code, 'GBPJPY');
  assert.equal(fxName('EURJPY=X'), 'ユーロ円');
  assert.equal(findListLink('<a href="/markets/x/data_j.xlsx">一覧</a>'), 'https://www.jpx.co.jp/markets/x/data_j.xlsx');
  assert.equal(findListLink('<p>なし</p>'), null);
});

import { evaluateForecasts } from '../public/js/backtest.js';
import { runStrategy, regimeLookup, regimeScore } from '../public/js/strategies.js';

function walk(n = 400, seed = 7) {
  const out = [];
  let p = 100, s = seed;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = o * (1 + (r() - 0.48) * 0.03);
    out.push({ time: 1_700_000_000 + i * 86400, open: o, high: Math.max(o, p) * 1.005, low: Math.min(o, p) * 0.995, close: p, volume: 1000 });
  }
  return out;
}

test('予想の答え合わせ：最近の予想は「答え合わせ待ち」になる', () => {
  const c = walk();
  const e = evaluateForecasts(c, { horizon: 5, days: 60, paths: 200 });
  assert.equal(e.stats.pending, 5);
  assert.equal(e.stats.count, e.rows.length - 5);
  const done = e.rows.find((r) => r.actual != null);
  const i = c.findIndex((x) => x.time === done.time);
  assert.equal(done.actual, c[i + 5].close);
  assert.ok(e.stats.dirHit >= 0 && e.stats.dirHit <= 1);
  // 同じデータなら毎回同じ予想になる（あとから出し直しても変わらない）
  const again = evaluateForecasts(c, { horizon: 5, days: 60, paths: 200 });
  assert.deepEqual(again.rows.map((r) => r.center), e.rows.map((r) => r.center));
});

test('自動売買：次の日の始まりの値段で売買し、損益が合う', () => {
  const c = walk();
  for (const id of ['trend', 'rebound', 'combo']) {
    const r = runStrategy(c, id, { kind: 'fx', pair: 'USDJPY' });
    for (const t of r.trades) {
      const ei = c.findIndex((x) => x.time === t.entryTime);
      assert.equal(t.entryPrice, c[ei].open); // 未来の値段を使っていない
      assert.ok(t.exitTime > t.entryTime);
    }
    const realized = r.trades.reduce((s, t) => s + t.pnl, 0);
    assert.ok(Math.abs(realized - r.stats.realized) < 1e-6);
    const sumDaily = r.daily.reduce((s, d) => s + d.pnl, 0);
    assert.ok(Math.abs(sumDaily - r.stats.total) < 1e-6);
  }
  // 株は売りから入らない
  assert.ok(runStrategy(c, 'trend', { kind: 'stock' }).trades.every((t) => t.side === 1));
});

test('情勢の点数', () => {
  const day = (i) => ({ time: 1_700_000_000 + i * 86400 });
  const look = regimeLookup({
    vix: Array.from({ length: 60 }, (_, i) => ({ ...day(i), close: 30 })),
    tnx: Array.from({ length: 60 }, (_, i) => ({ ...day(i), close: 4 + i * 0.01 })),
    nikkei: Array.from({ length: 60 }, (_, i) => ({ ...day(i), close: 30000 - i * 10 })),
  });
  const r = look('2099-01-01');
  assert.equal(r.vix.v, 30);
  const sc = regimeScore(r, 'fx', 'USDJPY');
  assert.ok(sc.notes.some((n) => /恐怖指数/.test(n)));
  assert.ok(sc.notes.some((n) => /金利が上昇/.test(n)));
});

import { detectFormat, fileId } from '../public/js/trades.js';

test('LION FX の決済履歴：合計の損益をそのまま使い、売り買いを判定する', () => {
  const csv = [
    '決済約定日時,ポジション番号,通貨ペア,両建,注文手法,約定区分,執行条件,指定レート,売買,Lot数,新規約定日時,新規約定値,決済約定値,pip損益,円換算レート,売買損益,手数料,スワップ損益,決済損益',
    '2026/09/01 10:15:30,1001,USD/JPY,,通常,決済,成行,0,売,1,2026/08/30 09:00:00,146.500,146.800,30.0,1,3000,0,120,3120',
    '2026/09/02 22:40:10,1002,EUR/JPY,,通常,決済,成行,0,買,2,2026/09/01 21:00:00,157.200,157.000,20.0,1,4000,0,-50,3950',
    '2026/09/03 09:05:00,1003,GBP/JPY,,通常,決済,成行,0,売,1,2026/09/02 10:00:00,197.000,196.500,-50.0,1,-5000,0,10,-4990',
    ',,,,,,,,,,,,,,,,合計,,2080',
  ].join('\n');
  const rows = parseCsv(csv);
  const h = findHeader(rows);
  assert.equal(detectFormat(rows[h]).id, 'lion');
  const map = guessMapping(rows[h]);
  assert.equal(rows[h][map.price], '決済約定値');
  const t = rowsToTrades(rows, h, map);
  assert.equal(t.length, 3); // 合計の行は数えない
  assert.deepEqual(t.map((x) => x.pnl), [3120, 3950, -4990]);
  assert.deepEqual(t.map((x) => x.side), ['買', '売', '買']); // 値段の動きと損益から判定
  assert.equal(computeStats(t).totalPnl, 2080);
});

test('楽天証券の実現損益：合計の行を除き、円の損益を使う', () => {
  const csv = [
    '約定日,受渡日,銘柄コード,銘柄名,口座,取引,数量［株］,売却/決済単価［円］,売却/決済額［円］,平均取得価額［円］,実現損益［円］',
    '"2026/9/1","2026/9/3","7203","トヨタ自動車","特定","売付","100","3,100","310,000","3,000","10,000"',
    '"2026/9/2","2026/9/4","4588","オンコリスバイオファーマ","特定","売付","200","800","160,000","900","-20,000"',
    '"合計","","","","","","","","","","-10,000"',
  ].join('\r\n');
  const rows = parseCsv(csv);
  const h = findHeader(rows);
  assert.equal(detectFormat(rows[h]).id, 'rakuten');
  const t = rowsToTrades(rows, h, guessMapping(rows[h]));
  assert.equal(t.length, 2);
  assert.equal(computeStats(t).totalPnl, -10000);
  assert.equal(t[1].symbol, 'オンコリスバイオファーマ');
  assert.equal(fileId(csv), fileId(csv));
  assert.notEqual(fileId(csv), fileId(csv + ' '));
});

import { parseEarningsRows, parseMarginLines, toDate } from '../lib/jpxdata.js';
import { pickAndTrade } from '../public/js/strategies.js';

test('決算発表予定日のExcel（実物と同じ並び）を読む', () => {
  const rows = [
    ['９月に四半期末又は期末を迎えた決算発表予定会社の一覧', '', ''],
    ['2026年10月1日 現在'],
    ['決算発表予定日\nScheduled Dates for Earnings Announcements', 'コード\nCode', '会社名', 'Issue Name', '決算期末\nFiscal Year-end', '業種名', 'Industry', '種別', 'Fiscal Year/Quarter', '市場区分', 'Market Segment'],
    [new Date('2026-10-05T00:00:00.000Z'), 2753, 'あみやき亭', 'AMIYAKI TEI', new Date('2027-03-31T00:00:00.000Z'), '小売業', 'Retail', '第２四半期', 'Second quarter', 'プライム', 'Prime'],
    ['2026/10/28', '7203', 'トヨタ自動車', 'TOYOTA', '2027/3/31', '輸送用機器', '', '第２四半期', '', 'プライム', ''],
  ];
  const e = parseEarningsRows(rows);
  assert.equal(e.length, 2);
  assert.deepEqual([e[0].date, e[0].code, e[0].period, e[0].kind], ['2026-10-05', '2753', '2027-03', '第2四半期']);
  assert.equal(e[1].date, '2026-10-28');
  assert.equal(toDate(46000), '2025-12-09'); // Excel の日付番号
});

test('信用残高のPDF（1社分の列）を読む', () => {
  const col = (code, v) => [...v, `JP000 株数 Shs.`, code, '貸', 'プライム', '普通株式', '会社', 'B'];
  const lines = [
    col('72030', ['▲ 592,200', '10,563,400', '▲ 512,000', '8,249,100', '5,400', '1,524,800', '8,900', '139,500', '0.1%', '▲ 1,104,200', '18,812,500', '0.0%', '14,300', '1,664,300']),
    col('13010', ['900', '122,900', '300', '38,400', '0', '9,400', '100', '100', '1.3%', '1,200', '999,999', '0.1%', '100', '9,500']), // 合計が合わない行は使わない
  ];
  const m = parseMarginLines(lines);
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].code, m[0].buy, m[0].sell, m[0].buyChg], ['7203', 18812500, 1664300, -1104200]);
});

test('勝率の高い銘柄だけを選ぶ売買：選ぶときに未来を使わず、損益が合う', () => {
  const list = [1, 2, 3, 4, 5].map((i) => ({ symbol: `S${i}`, name: `銘柄${i}`, candles: walk(500, i * 11) }));
  const r = pickAndTrade(list, { kind: 'fx' });
  for (const p of r.periods) {
    for (const pk of p.picks) {
      assert.ok(pk.winRate >= 0.5 && pk.trades >= 2);
    }
  }
  for (const t of r.trades) {
    const p = r.periods.find((x) => t.entryDate >= x.from && t.entryDate <= x.to);
    assert.ok(p.picks.some((x) => x.symbol === t.symbol)); // 選んだ期間に選んだ銘柄だけ
  }
  const daily = r.daily.reduce((a, d) => a + d.pnl, 0);
  const sum = r.trades.reduce((a, t) => a + t.pnl, 0);
  assert.ok(Math.abs(daily - sum) < 1e-6);
});

import { coach, excursion, excursionAdvice, tradeSymbol, pickInterval, sessionOf } from '../public/js/tradecoach.js';
import { earningsInfo, daysBetween } from '../public/js/earningsview.js';

const mk = (i, pnl, extra = {}) => ({ date: new Date(2026, 8, 1 + Math.floor(i / 3), 10 + (i % 3) * 5, 0).toISOString(), symbol: i % 2 ? 'USD/JPY' : 'EUR/JPY', side: '買', qty: 1, pnl, ...extra });

test('取引アドバイス：コツコツドカンと大きな負けを見つけて、損切りルールの効果を計算する', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(mk(i, i % 5 === 4 ? -20000 : 3000));
  const c = coach(list, 'fx');
  assert.equal(c.type.name, 'コツコツ勝って、ドカンと負けるタイプ');
  const f = c.findings.find((x) => x.title.includes('大きな負け') || x.title.includes('損切りが少し遅め'));
  assert.ok(f, '損切りのアドバイスが出る');
  assert.ok(/合計は/.test(f.rule));
  assert.ok(c.top.length >= 1);
  assert.ok(c.sessions.length >= 1, '時刻があれば時間帯別が出る');
});

test('取引アドバイス：負けを長く持つくせと、負けた直後の取引を見つける', () => {
  const list = [];
  for (let i = 0; i < 24; i++) {
    const win = i % 2 === 0;
    const close = new Date(2026, 8, 1, 9, 0).getTime() + i * 3 * 3600e3;
    const hold = win ? 10 * 60e3 : 90 * 60e3;
    list.push({ date: new Date(close).toISOString(), openDate: new Date(close - hold).toISOString(), symbol: 'USD/JPY', side: '買', qty: 1, pnl: win ? 2000 : -2500 });
  }
  const c = coach(list, 'fx');
  assert.ok(c.findings.some((x) => x.title === '負けている取引を長く持ちすぎています'));
  assert.ok(c.holding.loss > c.holding.win);
  assert.equal(c.timeKey, 'openDate');
});

test('取引アドバイス：日付だけのCSVでは時間帯の分析をしない', () => {
  const list = Array.from({ length: 6 }, (_, i) => ({ date: new Date(2026, 8, 1 + i).toISOString(), symbol: '7203', side: '売', qty: 100, pnl: i % 2 ? 1000 : -500 }));
  const c = coach(list, 'stock');
  assert.equal(c.sessions.length, 0);
  assert.equal(c.timeKey, null);
});

test('時間帯の分け方', () => {
  assert.equal(sessionOf(new Date(2026, 8, 1, 22, 0), 'fx'), 'ニューヨーク時間（21〜翌2時）');
  assert.equal(sessionOf(new Date(2026, 8, 1, 1, 0), 'fx'), 'ニューヨーク時間（21〜翌2時）');
  assert.equal(sessionOf(new Date(2026, 8, 1, 9, 10), 'stock'), '寄り付き直後（9:00〜9:30）');
});

test('値動きとの照らし合わせ：含み益から負けになった取引と、飛びつき買いを見つける', () => {
  const base = Date.UTC(2026, 8, 1, 0, 0) / 1000;
  const candles = [];
  // 入る前の6時間：100 → 102 に上がっていく
  for (let i = 0; i < 72; i++) candles.push({ time: base + i * 300, open: 100 + i / 36, high: 100 + i / 36 + 0.05, low: 100 + i / 36 - 0.05, close: 100 + i / 36 });
  // 持っている間：102.5 まで上がってから 101 に下がる
  const start = base + 72 * 300;
  for (let i = 0; i < 24; i++) {
    const p = i < 12 ? 102 + i * 0.04 : 102.5 - (i - 12) * 0.13;
    candles.push({ time: start + i * 300, open: p, high: p + 0.02, low: p - 0.02, close: p });
  }
  const t = { openDate: new Date(start * 1000).toISOString(), date: new Date((start + 24 * 300) * 1000).toISOString(), side: '買', entry: 102, price: 101, pnl: -10000 };
  const r = excursion(t, candles, '5m');
  assert.ok(r.mfe > 4000 && r.mfe < 6000, `含み益の最大 ${r.mfe}`);
  assert.equal(r.chase, true);
  const adv = excursionAdvice([r, r, r, { ...r, pnl: 3000, chase: false, position: 0.5, mfe: 3000, mae: 0 }, { ...r, pnl: 3000, chase: false, position: 0.4, mfe: 3200, mae: 0 }, { ...r, pnl: 2000, chase: false, position: 0.3, mfe: 2000, mae: 0 }], { avgWin: 3000, avgLoss: 10000 });
  assert.ok(adv.findings.some((f) => f.title.startsWith('含み益があったのに')));
  assert.ok(adv.findings.some((f) => f.title.startsWith('上がりきった')));
});

test('取引の銘柄名から値動きのコードを作る', () => {
  assert.equal(tradeSymbol({ symbol: 'USD/JPY' }, 'fx'), 'USDJPY=X');
  assert.equal(tradeSymbol({ symbol: '米ドル/円' }, 'fx'), 'USDJPY=X');
  assert.equal(tradeSymbol({ symbol: 'トヨタ自動車', code: '7203' }, 'stock'), '7203.T');
  assert.equal(tradeSymbol({ symbol: 'AAPL' }, 'us'), 'AAPL');
  const now = Date.UTC(2026, 9, 6);
  assert.equal(pickInterval({ openDate: new Date(now - 86400e3).toISOString(), date: new Date(now - 86400e3 + 3600e3).toISOString() }, now), '5m');
  assert.equal(pickInterval({ openDate: new Date(now - 200 * 86400e3).toISOString(), date: new Date(now - 200 * 86400e3 + 5 * 3600e3).toISOString() }, now), '60m');
  assert.equal(pickInterval({ openDate: new Date(now - 200 * 86400e3).toISOString(), date: new Date(now - 200 * 86400e3 + 60e3).toISOString() }, now), null);
});

test('LION FX：新規約定日時を、持ち始めた時刻として読む', () => {
  const csv = [
    '決済約定日時,ポジション番号,通貨ペア,売買,Lot数,新規約定日時,新規約定値,決済約定値,決済損益',
    '2026/09/01 10:15:30,1001,USD/JPY,売,1,2026/09/01 09:00:00,146.500,146.800,3120',
  ].join('\n');
  const rows = parseCsv(csv);
  const h = findHeader(rows);
  const t = rowsToTrades(rows, h, guessMapping(rows[h]));
  assert.equal(new Date(t[0].openDate).getHours(), 9);
  assert.equal(new Date(t[0].date).getHours(), 10);
});

test('決算発表まであと何日', () => {
  assert.equal(daysBetween('2026-10-06', '2026-10-28'), 22);
  assert.equal(earningsInfo({ date: '2026-10-07' }, '2026-10-06').when, '明日');
  assert.equal(earningsInfo({ date: '2026-10-08' }, '2026-10-06').level, 'bad');
  assert.equal(earningsInfo({ date: '2026-10-01' }, '2026-10-06').when, '5日前に発表済み');
});

test('お気に入りの共有：人ごとに別々に保存し、時刻が進む', async () => {
  process.env.NODE_ENV = 'test'; // テストでは GitHub から読まない
  const { putPref, getPrefs, _reset, encrypt, decrypt, backupBlob, alertProfile, addUser, checkUser, listUsers, removeUser, setUserPassword } = await import('../lib/prefs.js');
  _reset();
  const a = await putPref('admin', 'favs_fx', [{ code: 'USDJPY', name: 'ドル円' }]);
  const b = await putPref('admin', 'favs_fx', [{ code: 'EURJPY', name: 'ユーロ円' }]);
  assert.ok(b.ts > a.ts);
  assert.equal((await getPrefs('admin')).items.favs_fx.value[0].code, 'EURJPY');
  await assert.rejects(() => putPref('admin', 'secret', []));
  // あなたの設定：メール・予算・持つ日数
  await putPref('admin', 'profile', { email: 'a@example.com', budget: '500000', riskPct: 2, maxPos: 3, swingDays: 10, notify: { fx: true } });
  await assert.rejects(() => putPref('admin', 'profile', { email: 'not-an-email' }));
  // 取引履歴も保存できる
  await putPref('admin', 'trades_fx', [{ date: '2026-09-01T01:00:00.000Z', symbol: 'USD/JPY', side: '買', qty: 1, price: 146.8, entry: 146.5, pnl: 3120, file: 'abc' }]);
  assert.equal((await getPrefs('admin')).items.trades_fx.value[0].pnl, 3120);
  // ほかの人を追加：データは別々
  await addUser({ id: 'Tanaka', name: '田中さん', password: 'secret1' });
  await assert.rejects(() => addUser({ id: 'tanaka', password: 'secret2' }), /もう使われています/);
  await assert.rejects(() => addUser({ id: 'x', password: 'secret2' }), /3〜20文字/);
  assert.equal((await checkUser('tanaka', 'secret1')).name, '田中さん');
  assert.equal(await checkUser('tanaka', 'wrong'), null);
  await putPref('tanaka', 'favs_fx', [{ code: 'GBPJPY', name: 'ポンド円' }]);
  assert.equal((await getPrefs('tanaka')).items.favs_fx.value[0].code, 'GBPJPY');
  assert.equal((await getPrefs('admin')).items.favs_fx.value[0].code, 'EURJPY');
  assert.equal((await getPrefs('tanaka')).items.profile, undefined, 'ほかの人の設定は見えない');
  await setUserPassword('tanaka', 'newpass1');
  assert.ok(await checkUser('tanaka', 'newpass1'));
  const ap = await alertProfile();
  assert.equal(ap.profile.email, 'a@example.com');
  assert.equal(ap.profile.swingDays, 10);
  assert.equal(ap.users.length, 2);
  assert.equal(ap.users[1].favs.fx[0].code, 'GBPJPY');
  // 暗号化したコピーから元に戻せる（パスワードのハッシュも入るが、メールアドレスなどは読めない）
  const bk = await backupBlob();
  assert.ok(!bk.blob.includes('example.com'));
  assert.equal(decrypt(bk.blob).profile.value.email, 'a@example.com');
  assert.deepEqual(decrypt(encrypt({ x: 1 })), { x: 1 });
  await removeUser('tanaka');
  assert.equal((await listUsers()).length, 0);
  assert.equal((await getPrefs('tanaka')).items.favs_fx, undefined);
});

test('勝つ確率の目安：銘柄の回数が少ないときは全体の勝率に近づく', async () => {
  const { signalOdds } = await import('../public/js/strategies.js');
  const pool = [];
  for (let i = 0; i < 40; i++) pool.push({ symbol: 'A', side: 1, strength: 0.7, pnl: i % 2 ? 100 : -100, ret: i % 2 ? 0.03 : -0.02, exitDate: `2026-0${1 + (i % 8)}-10` });
  pool.push({ symbol: 'B', side: 1, strength: 0.7, pnl: 100, ret: 0.03, exitDate: '2026-05-01' });
  const o = signalOdds(pool, { symbol: 'B', side: 1, strength: 0.7 });
  assert.ok(o.p > 0.5 && o.p < 0.6, `p=${o.p}`);
  assert.equal(signalOdds(pool, { symbol: 'A', side: -1, strength: 0.7 }), null);
  const past = signalOdds(pool, { symbol: 'A', side: 1, strength: 0.7, before: '2026-02-01' });
  assert.ok(past.base < 40);
});

test('デイトレ：その日のうちに必ず決済し、次の日に持ち越さない', async () => {
  const { runStrategy } = await import('../public/js/strategies.js');
  const cs = [];
  let p = 100, seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let d = 0; d < 30; d++) {
    const t0 = Date.UTC(2026, 8, 1 + d, 0, 0) / 1000; // 日本時間 9:00
    for (let k = 0; k < 26; k++) { const o = p; p = o * (1 + (rnd() - 0.48) * 0.006); cs.push({ time: t0 + k * 900, open: o, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, close: p, volume: 1 }); }
  }
  const r = runStrategy(cs, 'combo', { kind: 'stock', days: 26 * 20, intraday: true });
  assert.ok(r.trades.length > 0);
  const day = (t) => Math.floor((t + 9 * 3600) / 86400);
  assert.ok(r.trades.every((t) => day(t.entryTime) === day(t.exitTime)), '同じ日に決済している');
});

test('持っている株のアドバイス：損切りの線を割ったら「損切りを」、上向きなら「持ち続けてOK」', async () => {
  const { adviseHolding } = await import('../public/js/holdingadvice.js');
  const up = [], down = [];
  for (let i = 0; i < 120; i++) {
    const t = Date.UTC(2026, 3, 1) / 1000 + i * 86400;
    const pu = 1000 + i * 5 + Math.sin(i) * 8, pd = 2000 - i * 8 + Math.sin(i) * 8;
    up.push({ time: t, open: pu - 2, high: pu + 6, low: pu - 6, close: pu, volume: 1 });
    down.push({ time: t, open: pd + 2, high: pd + 6, low: pd - 6, close: pd, volume: 1 });
  }
  const a = adviseHolding({ symbol: '7203.T', side: 1, price: 1500, qty: 100 }, up, { mode: 'stock' });
  assert.ok(['hold', 'trim'].includes(a.key), a.key);
  assert.ok(a.plYen > 0);
  const b = adviseHolding({ symbol: '7203.T', side: 1, price: 1500, qty: 100 }, down, { mode: 'stock' });
  assert.equal(b.key, 'cut');
  assert.ok(b.reasons[0].includes('損切りの線'));
});

test('米国株の検索：カタカナ・ひらがな・別の呼び方でも見つかる', async () => {
  const { searchUs } = await import('../lib/usstocks.js');
  assert.equal(searchUs('あっぷる')[0].symbol, 'AAPL');
  assert.equal(searchUs('ソフィ')[0].symbol, 'SOFI');
  assert.equal(searchUs('ロケットラボ')[0].symbol, 'RKLB');
  assert.equal(searchUs('フェイスブック')[0].symbol, 'META');
});

test('いつ決済するのが一番いいか：日数ごとの見込みを出す', async () => {
  const { adviseHolding, exitTiming } = await import('../public/js/holdingadvice.js');
  const cs = [];
  let p = 1000, seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 200; i++) { const o = p; p = o * (1 + (rnd() - 0.5) * 0.03); cs.push({ time: Date.UTC(2026, 0, 1) / 1000 + i * 86400, open: o, high: Math.max(o, p) * 1.005, low: Math.min(o, p) * 0.995, close: p, volume: 1 }); }
  const h = { symbol: '7203.T', side: 1, price: p * 1.2, qty: 100 };
  const adv = adviseHolding(h, cs, { mode: 'stock' });
  const t = exitTiming(h, cs, adv, { mode: 'stock' });
  assert.equal(t.rows.length, 6);
  assert.ok(t.losing);
  assert.ok(t.rows.every((r) => r.pLine >= 0 && r.pLine <= 1 && r.pEscape >= 0 && r.pEscape <= 1));
  assert.ok(/損/.test(t.text));
  // 同じ入力なら同じ結果（毎回変わらない）
  assert.equal(exitTiming(h, cs, adv, { mode: 'stock' }).best.mean, t.best.mean);
});

test('スイングの持つ日数の上限を守る', async () => {
  const { runStrategy } = await import('../public/js/strategies.js');
  const cs = [];
  let p = 100;
  for (let i = 0; i < 400; i++) { const o = p; p = o * (1 + 0.003 + Math.sin(i / 9) * 0.004); cs.push({ time: Date.UTC(2025, 0, 1) / 1000 + i * 86400, open: o, high: Math.max(o, p) * 1.002, low: Math.min(o, p) * 0.998, close: p, volume: 1 }); }
  const r = runStrategy(cs, 'trend', { kind: 'stock', maxHold: 5 });
  assert.ok(r.trades.length > 0);
  assert.ok(r.trades.every((t) => t.days <= 6), JSON.stringify(r.trades.map((t) => t.days)));
});

test('長い目で見ると：1か月・3か月・半年の見込みと理由を出す', async () => {
  const { adviseHolding, longTermView } = await import('../public/js/holdingadvice.js');
  const cs = [];
  let p = 1000, seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) { const o = p; p = o * (1 + (rnd() - 0.49) * 0.03); cs.push({ time: Date.UTC(2025, 0, 1) / 1000 + i * 86400, open: o, high: Math.max(o, p) * 1.005, low: Math.min(o, p) * 0.995, close: p, volume: 1 }); }
  const h = { symbol: '7203.T', side: 1, price: p * 1.1, qty: 100 };
  const adv = adviseHolding(h, cs, { mode: 'stock' });
  const v = longTermView(h, cs, adv, { mode: 'stock' });
  assert.deepEqual(v.rows.map((r) => r.label), ['1か月', '3か月', '半年']);
  assert.ok(v.reasons.some((r) => /1年の高値/.test(r)));
  assert.ok(v.line < adv.now);
  assert.ok(v.rows.every((r) => r.p10 <= r.mean && r.mean <= r.p90));
});


test('取引時間の判定（日本株・米国株・為替）', async () => {
  const { openMarkets } = await import('../lib/markethours.js');
  // 水曜 10:00（日本時間）＝ 01:00 UTC：日本株と為替
  assert.deepEqual(openMarkets(new Date('2026-10-07T01:00:00Z')).sort(), ['fx', 'stock']);
  // 水曜 12:00（日本時間）：昼休みなので日本株は休み
  assert.deepEqual(openMarkets(new Date('2026-10-07T03:00:00Z')), ['fx']);
  // 水曜 23:00（日本時間）＝ ニューヨーク 10:00：米国株と為替
  assert.deepEqual(openMarkets(new Date('2026-10-07T14:00:00Z')).sort(), ['fx', 'us']);
  // 日曜：どこも休み
  assert.deepEqual(openMarkets(new Date('2026-10-11T03:00:00Z')), []);
});


test('寄り付きのくせ：寄り天・寄り底と、始まり方ごとの割合', async () => {
  const { openingStats, bucketOf, openingVerdict } = await import('../public/js/openingview.js');
  const cs = [{ time: 0, open: 100, high: 101, low: 99, close: 100 }];
  // 大きく上で始まって、寄り天（始まりが一番高い）の日を10日
  for (let i = 1; i <= 10; i++) { const p = cs[cs.length - 1].close; const o = p * 1.03; cs.push({ time: i, open: o, high: o, low: o * 0.97, close: o * 0.98 }); }
  // ほぼ同じで始まって、寄り底の日を10日
  for (let i = 11; i <= 20; i++) { const p = cs[cs.length - 1].close; cs.push({ time: i, open: p, high: p * 1.02, low: p, close: p * 1.015 }); }
  const st = openingStats(cs);
  assert.equal(st.days, 20);
  assert.equal(st.all.top, 0.5);
  const big = st.buckets[bucketOf(0.03)];
  assert.equal(big.n, 10);
  assert.equal(big.top, 1);
  assert.equal(big.up, 0);
  assert.ok(/寄り天/.test(openingVerdict(big)));
  assert.equal(st.buckets[bucketOf(0)].bottom, 1);
});

test('時刻の書き方（判断した時刻・売買する時刻）', async () => {
  const { fmtTime, judgedText, execText } = await import('../public/js/sessiontime.js');
  const t = Date.UTC(2026, 9, 6, 0, 0) / 1000; // 日本時間 10/6 9:00
  assert.equal(fmtTime(t), '10/6 09:00');
  assert.ok(judgedText('stock', t).startsWith('10/6 15:30'));
  assert.ok(judgedText('fx', t, true).startsWith('10/6 09:15'));
  assert.ok(execText('stock').includes('9:00'));
});

import { sizePosition as sizePos2, replayWithBudget as replay2, levFor, MAINT } from '../public/js/plan.js';

test('レバレッジ：設定の範囲と、量・必要なお金', () => {
  assert.equal(levFor({ levStock: 5 }, 'stock'), 3.3);
  assert.equal(levFor({}, 'stock'), 1);
  assert.equal(levFor({ levStock: 2 }, 'stock'), 3.3);
  assert.equal(levFor({}, 'fx'), 25);
  const base = { mode: 'stock', symbol: '7203.T', price: 1000, stop: 900, budget: 300000, riskPct: 100, maxPos: 1 };
  const one = sizePos2({ ...base, leverage: 1 });
  const three = sizePos2({ ...base, leverage: 3 });
  assert.equal(one.qty, 300);
  assert.equal(three.qty, 900);
  assert.equal(three.cost, 300000); // 保証金は 90万円 ÷ 3
  assert.equal(three.notional, 900000);
});

test('レバレッジ：振り返りでロスカットを数える', () => {
  const trades = [
    { entryDate: '2026-01-01', exitDate: '2026-01-05', ret: 0.05, mae: -0.01, stopPct: 0.05 },
    { entryDate: '2026-01-06', exitDate: '2026-01-09', ret: -0.02, mae: -0.3, stopPct: 0.05 },
  ];
  const r1 = replay2(trades, { budget: 100000, riskPct: 2, maxPos: 1, leverage: 1, maint: MAINT.stock });
  assert.equal(r1.losscuts, 0);
  const r3 = replay2(trades, { budget: 100000, riskPct: 2, maxPos: 1, leverage: 3, maint: MAINT.stock });
  assert.equal(r3.losscuts, 1);
  // 1回目 +15,000円、2回目は維持率20%を割って -100,000 + 300,000×0.2 = -40,000円
  assert.equal(Math.round(r3.total), 15000 - 40000);
});

import { themeHeat, THEMES } from '../lib/themes.js';
import { themeOdds } from '../public/js/themeview.js';

test('テーマ：ニュースの増え方', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  const at = (h) => ({ date: new Date(now - h * 3600000).toUTCString() });
  const items = [...Array(20)].map((_, i) => at(i * 2)).concat([...Array(5)].map((_, i) => at(60 + i * 20)));
  const h = themeHeat(items, now);
  assert.equal(h.recent, 20);
  assert.equal(h.before, 5);
  assert.equal(h.heat, 10);
  assert.equal(h.label, '急に増えている');
  assert.ok(THEMES.every((t) => t.stock.every(([c]) => /^\d{4}$/.test(c))));
});

test('テーマ：似た形のときに上がっていた確率', () => {
  // ずっと少しずつ上がる銘柄 → 確率は高い
  const up = [...Array(300)].map((_, i) => ({ close: 100 * 1.002 ** i, volume: 1000 }));
  const o = themeOdds(up);
  assert.ok(o.p > 0.9 && o.hits > 100);
  assert.equal(themeOdds(up.slice(0, 50)), null);
});

import { sizeOpts as sizeOpts2 } from '../public/js/plan.js';
test('為替：ロット数で決める', () => {
  const o = sizeOpts2({ fxLots: 2, fxLotSize: 10000 }, 'fx');
  const z = sizePos2({ mode: 'fx', symbol: 'USDJPY=X', price: 150, stop: 149, budget: 1000000, riskPct: 2, maxPos: 3, ...o });
  assert.equal(z.qty, 20000);
  assert.equal(z.lots, 2);
  assert.equal(z.cost, 120000); // 300万円 ÷ 25
  assert.equal(z.maxLoss, 20000);
  assert.equal(Math.round(z.effLev * 10) / 10, 3);
  assert.equal(z.over, false);
  const big = sizePos2({ mode: 'fx', symbol: 'USDJPY=X', price: 150, stop: 149, budget: 100000, riskPct: 2, maxPos: 3, ...o });
  assert.equal(big.qty, 0); // 証拠金が足りない
  assert.deepEqual(sizeOpts2({ fxLots: 0 }, 'fx'), { leverage: 25 });
});

import { sizeFor, sidesFor, splitBudget, orderText, lotNote } from '../public/js/plan.js';
import { runStrategy as runS2 } from '../public/js/strategies.js';
test('取引のしかた：現物・信用・空売り・為替の向き', () => {
  const mix = { budget: 1000000, maxPos: 2, ...wayPf({}, 'stock', 'mixShort') };
  assert.equal(sidesFor(mix, 'stock'), 'both');
  assert.equal(sidesFor(wayPf({}, 'stock', 'shortOnly'), 'stock'), 'short');
  assert.equal(sidesFor(wayPf({}, 'stock', 'cash'), 'stock'), 'long');
  assert.equal(sidesFor({ fxSides: 'short' }, 'fx'), 'short');
  assert.equal(sidesFor({ levUs: 2 }, 'us'), 'long');
  const args = { symbol: '7203.T', price: 1000, stop: 950, budget: 1000000, riskPct: 2, maxPos: 2 };
  const buy = sizeFor({ ...wayPf({}, 'stock', 'cash') }, 'stock', 1, args);
  assert.equal(buy.acct, 'cash');
  assert.equal(orderText(1, buy), '現物で買う：400株');
  const sell = sizeFor(mix, 'stock', -1, { ...args, stop: 1050 });
  assert.equal(sell.acct, 'margin');
  assert.match(orderText(-1, sell), /^信用で空売り/);
  assert.equal(sizeFor(wayPf({}, 'stock', 'cash'), 'stock', -1, args).qty, 0);
  // 現物で足りない分を信用で買い足す
  const big = sizeFor(mix, 'stock', 1, { ...args, price: 4000, stop: 3990 });
  assert.equal(big.acct, 'mix');
  assert.match(orderText(1, big), /現物で買う：100株＋信用で買う/);
  assert.match(lotNote({ budget: 1000000, maxPos: 2 }, 1, 6000), /信用なら買える/);
  // 向きを決めると、その向きの取引しか出ない
  const cs = [...Array(400)].map((_, i) => { const p = 100 + 10 * Math.sin(i / 12) + i * 0.02; return { time: 1.7e9 + i * 86400, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000 }; });
  const l = runS2(cs, 'combo', { kind: 'fx', sides: 'long' }).trades;
  const sh = runS2(cs, 'combo', { kind: 'fx', sides: 'short' }).trades;
  assert.ok(l.length && l.every((t) => t.side > 0));
  assert.ok(sh.length && sh.every((t) => t.side < 0));
});

import { compareWays as cmpWays, wayProfile as wayPf, wayNotes as wNotes } from '../public/js/plan.js';
test('やり方を自動で選ぶ', () => {
  const mk = (side, ret, n, d0 = 0) => [...Array(n)].map((_, i) => ({ side, ret, stopPct: 0.03, mae: -0.01, entryDate: `2026-0${1 + ((i + d0) % 9)}-${String(1 + (i % 27)).padStart(2, '0')}`, exitDate: `2026-0${1 + ((i + d0) % 9)}-${String(2 + (i % 27)).padStart(2, '0')}`, entryTime: 1.7e9 + i * 86400 * 3, exitTime: 1.7e9 + i * 86400 * 3 + 86400, entryPrice: 100, symbol: '7203.T' }));
  const long = mk(1, 0.02, 30);
  const shortLoss = mk(-1, -0.02, 30, 1);
  const cmp = cmpWays({ long, both: [...long, ...shortLoss] }, 'stock', { riskPct: 2, maxPos: 3 }, 1000000, {});
  assert.equal(cmp.rows.length, 6); // 空売りだけ（short の取引）は渡していないので6つ
  assert.ok(!cmp.best.short); // 空売りが負けているなら選ばない
  assert.ok(wNotes(cmp, 'stock', 1000000).some((x) => x.includes('空売りはやめた方がいい')));
  assert.equal(wayPf({}, 'stock', 'short').stockShort, true);
  assert.equal(wayPf({}, 'fx', 'long').fxSides, 'long');
});

import { coach as coach2 } from '../public/js/tradecoach.js';
test('取引分析：やり方ごとの成績', () => {
  const t = (kind, pnl, i) => ({ kind, side: '売', pnl, date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), symbol: 'トヨタ' });
  const list = [...[1, 2, 3, 4].map((i) => t('cash', 5000, i)), ...[5, 6, 7, 8].map((i) => t('short', -3000, i))];
  const c = coach2(list, 'stock');
  const f = c.findings.find((x) => x.cat === 'やり方');
  assert.match(f.title, /現物/);
  assert.match(f.rule, /空売り/);
});

import { parseBoard, summarize as crowdSum, sentimentOf } from '../lib/crowd.js';
import { budgets } from '../public/js/plan.js';
import { addOnAdvice, adviseHolding as advH } from '../public/js/holdingadvice.js';
test('みんなの声：投稿から強気・弱気の割合', () => {
  const html = `<script>window.__X__={"items":[${['明日は絶対上がる！ストップ高', 'まだまだ上昇期待、ガチホ', 'もう天井、暴落くるぞ', '押し目で買い増しした', '決算待ちで様子見です'].map((t) => `{"body":"${t}"}`).join(',')}]}</script>`;
  const posts = parseBoard(html);
  assert.equal(posts.length, 5);
  const s = crowdSum(posts.map((text) => ({ text })));
  assert.equal(s.bull, 3);
  assert.equal(s.bear, 1);
  assert.equal(s.sure, 1);
  assert.equal(sentimentOf('損切りして撤退'), -1);
});

test('予算：現物と信用・空売りを分ける', () => {
  assert.deepEqual(budgets({ budget: 500000, marginBudget: 300000 }), { cash: 500000, margin: 300000, sep: true, total: 800000 });
  assert.equal(budgets({ budget: 500000 }).sep, false);
  const pf = { budget: 500000, marginBudget: 300000, riskPct: 2, maxPos: 1, ...wayPf({}, 'stock', 'cashShort') };
  const args = { symbol: '7203.T', price: 1000, stop: 900, budget: 500000, riskPct: 2, maxPos: 1 };
  const buy = sizeFor(pf, 'stock', 1, args);
  assert.equal(buy.qty, 100); // 1回で減っていい額は (50万+30万)×2%＝1.6万 → 損切り幅100円なので100株（160株は100株単位で100）
  const sh = sizeFor(pf, 'stock', -1, { ...args, stop: 1100 });
  assert.equal(sh.acct, 'margin');
});

test('買い増し・ナンピンのアドバイス', () => {
  const up = [...Array(200)].map((_, i) => { const p = 100 + i * 0.5 + Math.sin(i / 3) * 2; return { time: 1.7e9 + i * 86400, open: p, high: p + 1, low: p - 1, close: p, volume: 1000 }; });
  const h = { symbol: 'X.T', side: 1, price: 150, qty: 200 };
  const adv = advH(h, up, { mode: 'stock' });
  const a = addOnAdvice(h, up, adv, { mode: 'stock' });
  assert.ok(['add', 'wait', 'none'].includes(a.kind));
  const down = up.map((c, i) => ({ ...c, close: 300 - i * 0.8, open: 300 - i * 0.8, high: 301 - i * 0.8, low: 299 - i * 0.8 }));
  const h2 = { symbol: 'X.T', side: 1, price: 200, qty: 200 };
  const a2 = addOnAdvice(h2, down, advH(h2, down, { mode: 'stock' }), { mode: 'stock' });
  assert.equal(a2.kind, 'no'); // 下がり続けているならナンピンしない
});

test('取引分析：為替のロット数のアドバイス', () => {
  const t = (qty, pnl, i) => ({ side: '買', qty, pnl, date: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), symbol: 'ドル円' });
  const list = [t(1, -3000, 1), t(3, -9000, 2), t(1, 2000, 3), t(1, -3000, 4), t(4, -12000, 5), t(1, 2500, 6), t(1, 3000, 7)];
  const c = coach2(list, 'fx', { budget: 300000, riskPct: 2 });
  const f = c.findings.find((x) => x.cat === '量' && /ロット/.test(x.title));
  assert.match(f.title, /上げすぎない/);
  assert.match(f.body, /最大2\.0ロットまで/);
});

import { putPref as putP, getPrefs as getP, _reset as resetP } from '../lib/prefs.js';
test('持っている株：空っぽで上書きしても、前の中身をとっておく', async () => {
  resetP();
  await putP('admin', 'holdings_stock', [{ code: '5803', name: 'フジクラ', price: 7582, qty: 200, side: 1 }]);
  await putP('admin', 'holdings_stock', []);
  const { items } = await getP('admin');
  assert.equal(items.holdings_stock.value.length, 0);
  assert.equal(items['holdings_stock~prev'].value[0].name, 'フジクラ');
});

test('おすすめはマイナスのやり方を選ばない', () => {
  const mk = (side, ret, mae, n, d0 = 0) => [...Array(n)].map((_, i) => ({ side, ret, stopPct: 0.01, mae, entryDate: `2026-0${1 + ((i + d0) % 9)}-${String(1 + (i % 27)).padStart(2, '0')}`, exitDate: `2026-0${1 + ((i + d0) % 9)}-${String(2 + (i % 27)).padStart(2, '0')}`, entryTime: 1.7e9 + i * 86400 * 3, exitTime: 1.7e9 + i * 86400 * 3 + 86400, entryPrice: 150, symbol: 'USDJPY=X' }));
  // 買いだけ：大きく勝つが減り方も大きい／売りだけ：小さく負け続ける
  const long = [...mk(1, 0.03, -0.02, 20), ...mk(1, -0.02, -0.03, 12, 3)];
  const short = mk(-1, -0.003, -0.004, 30, 1);
  const cmp = cmpWays({ long, short, both: [...long, ...short] }, 'fx', { riskPct: 2, maxPos: 3 }, 100000, {});
  assert.ok(cmp.best.r.total > 0);
  assert.notEqual(cmp.best.key, 'short');
  const all = cmpWays({ long: short.map((t) => ({ ...t, side: 1 })), short, both: short }, 'fx', { riskPct: 2, maxPos: 3 }, 100000, {});
  assert.equal(all.note, 'rest');
});

import { searchCustom as findRule } from '../public/js/plan.js';
test('AIの特別ルール：前半で見つけて後半で確かめる', () => {
  // 確率の目安が高いサインは勝ち、低いサインは負ける取引を、1年分（前半・後半）用意する
  const trades = [];
  for (let i = 0; i < 80; i++) {
    const hi = i % 2 === 0;
    const m = 1 + Math.floor(i / 8), d = 1 + (i % 8) * 3;
    const ed = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    trades.push({ side: 1, ret: hi ? 0.03 : -0.03, stopPct: 0.03, mae: -0.01, odds: { p: hi ? 0.72 : 0.52 }, entryDate: ed, exitDate: ed, entryTime: 1.7e9 + i * 3e5, exitTime: 1.7e9 + i * 3e5 + 86400, entryPrice: 100, symbol: '7203.T' });
  }
  const pf = { riskPct: 2, maxPos: 3 };
  const std = cmpWays({ long: trades, both: trades }, 'stock', pf, 1000000, {});
  const c = findRule({ long: trades, both: trades }, 'stock', pf, 1000000, {}, std);
  assert.ok(c);
  assert.ok(c.minOdds >= 0.55 && c.minOdds <= 0.7);
  assert.ok(c.test.total > 0);
  assert.equal(c.adopted, true);
});
