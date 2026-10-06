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
import { buildScenarioSeries, dateToTime } from '../public/js/scenario.js';

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

test('AI予想をチャートの点と目印に変換', () => {
  const last = dateToTime('2026-10-06', 0);
  const b = buildScenarioSeries({
    main: [{ date: '2026-10-20', price: 148, label: '日銀会合' }, { date: '2026-10-09', price: 151, label: '雇用統計' }, { date: '2026-10-01', price: 140, label: '過去' }],
    events: [{ date: '2026-10-14', name: '米CPI', impact: '下落要因' }],
    bull: [{ date: '2026-10-20', price: 155 }],
    bear: [],
  }, last, 150);
  assert.equal(b.points.length, 2); // 過去の点は除く
  assert.equal(b.points[0].label, '雇用統計');
  assert.equal(b.line[0].value, 150);
  for (let i = 1; i < b.line.length; i++) assert.ok(b.line[i].time > b.line[i - 1].time);
  const ev = b.markers.find((m) => m.kind === 'event');
  assert.ok(ev && b.line.some((p) => p.time === ev.time));
  assert.equal(b.markers.find((m) => m.kind === 'point').shape, 'arrowUp');
  assert.equal(b.bull.length, 2);
  assert.equal(b.bear.length, 0);
});
