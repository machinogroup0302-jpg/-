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
  assert.equal(trades[0].pnl, 3210);
  assert.equal(trades[1].pnl, -5000);
  assert.equal(trades[0].side, '売');
  const s = computeStats(trades);
  assert.equal(s.count, 3);
  assert.equal(Math.round(s.winRate * 100), 67);
  assert.equal(s.totalPnl, 3210 - 5000 + 1480);
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
