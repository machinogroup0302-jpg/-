// 決算発表のあと、上がりやすいか・下がりやすいか（日本株）
// ・過去の決算：次の発表日から3か月ずつさかのぼった日のまわりで、出来高が急に増えた日を「決算の翌日」とみなし、その日の値動きを見る
// ・業績：売上・利益の伸び、利益率、割高さ、アナリストの目標株価
// ・まわりの声：ニュースの雰囲気、掲示板・SNSの強気・弱気
// ・期待の織り込み：発表前にもう大きく上がっていると「材料出尽くし」で下がりやすい
import { getChart } from './market.js';
import { getFundamentals } from './fundamentals.js';
import { getCrowd } from './crowd.js';

const DAY = 86400;

// candles（日足）と次の発表日から、過去の決算の翌日の値動きを探す
export function pastReactions(candles, nextDate, { quarters = 8 } = {}) {
  if (!candles?.length || !nextDate) return [];
  const t0 = Date.parse(`${nextDate}T00:00:00Z`) / 1000;
  const out = [];
  const used = new Set();
  for (let k = 1; k <= quarters; k++) {
    const center = t0 - k * 91.3 * DAY;
    let best = null;
    for (let i = 21; i < candles.length; i++) {
      const c = candles[i];
      if (Math.abs(c.time - center) > 14 * DAY || used.has(i)) continue;
      const avgVol = candles.slice(i - 20, i).reduce((a, x) => a + (x.volume || 0), 0) / 20;
      if (!(avgVol > 0)) continue;
      const volRatio = (c.volume || 0) / avgVol;
      const ret = c.close / candles[i - 1].close - 1;
      const gap = Math.abs(c.open / candles[i - 1].close - 1);
      const score = volRatio * (1 + gap * 20);
      if (!best || score > best.score) best = { i, score, volRatio, ret, gap, time: c.time };
    }
    // 出来高がふだんの1.8倍以上に増えた日だけ（決算の反応とみなせる日）
    if (best && best.volRatio >= 1.8) {
      used.add(best.i);
      // 翌日まで含めた2日間の動き（発表の次の日に動き切らないこともあるため）
      const n = candles[best.i + 1];
      const ret2 = n ? n.close / candles[best.i - 1].close - 1 : best.ret;
      out.push({ date: new Date(best.time * 1000).toISOString().slice(0, 10), ret: best.ret, ret2, volRatio: best.volRatio });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const raw = (v) => (v && typeof v === 'object' ? v.raw : v) ?? null;

// 材料を点数にして、決算後に上がりやすいか下がりやすいかを出す
export function judgeOutlook({ reactions = [], fund = null, crowd = null, runup = null }) {
  const items = [];
  const add = (name, pts, text) => items.push({ name, pts, text });
  // 1) 過去の決算のあとの動き
  if (reactions.length >= 3) {
    const up = reactions.filter((r) => r.ret > 0).length, down = reactions.length - up;
    const avg = reactions.reduce((a, r) => a + r.ret, 0) / reactions.length;
    const rate = up / reactions.length;
    add('過去の決算のあと', rate >= 0.67 ? 1 : rate <= 0.33 ? -1 : 0,
      `過去${reactions.length}回の決算の翌日：上がった${up}回・下がった${down}回（平均 ${avg >= 0 ? '+' : ''}${(avg * 100).toFixed(1)}%）`);
  } else add('過去の決算のあと', 0, '過去の決算の動きが分かる回数が少ないので、判断に入れていません');
  // 2) 業績（会社の数字）
  const rows = fund?.rows || [];
  const row = (name) => rows.find((r) => r.name === name);
  const eg = row('利益の伸び（前年比）'), rg = row('売上の伸び（前年比）'), pm = row('売上に対する利益（利益率）'), per = row('株価の割安さ（PER）'), tg = row('アナリストの目標株価との差');
  const sig = (r) => (r?.signal === '上がる要因' ? 1 : r?.signal === '下がる要因' ? -1 : 0);
  if (eg) add('利益の伸び', sig(eg), `利益の伸び ${eg.value}：${eg.detail}`);
  if (rg) add('売上の伸び', sig(rg) * 0.5, `売上の伸び ${rg.value}：${rg.detail}`);
  if (pm && pm.signal === '下がる要因') add('利益率', -0.5, `利益率 ${pm.value}：${pm.detail}`);
  if (per && per.signal === '下がる要因') add('株価の高さ', -0.5, `PER ${per.value}：期待が大きいので、良い決算でも「思ったほどではない」と売られやすい`);
  if (tg) add('アナリストの見方', sig(tg) * 0.5, `目標株価との差 ${tg.value}：${tg.detail}`);
  if (!eg && !rg) add('業績', 0, '業績の数字が取れなかったので、判断に入れていません');
  // 3) ニュースの雰囲気
  const nw = row('最近のニュースの雰囲気');
  if (nw) add('ニュース', sig(nw) * 0.5, `ニュース：${nw.value}（${nw.detail}）`);
  // 4) 掲示板・SNSの声
  if (crowd && crowd.posts >= 8 && crowd.bullPct != null) {
    const p = crowd.bullPct;
    add('みんなの声', p >= 0.65 ? 0.5 : p <= 0.35 ? -0.5 : 0, `掲示板・SNS：強気${Math.round(p * 100)}%（${crowd.bull}件・弱気${crowd.bear}件）`);
  }
  // 5) 発表前の値動き（期待がどれだけ入っているか）
  if (runup != null) {
    if (runup > 0.15) add('発表前の上がり方', -1, `この1か月で +${(runup * 100).toFixed(0)}% と大きく上がっている。良い結果でも「材料出尽くし」で売られやすい`);
    else if (runup < -0.15) add('発表前の下がり方', 0.5, `この1か月で ${(runup * 100).toFixed(0)}% と大きく下がっている。悪い結果もある程度は値段に入っている（あく抜けで上がることも）`);
  }
  const score = items.reduce((a, x) => a + x.pts, 0);
  const verdict = score >= 1.5 ? 'up' : score <= -1.5 ? 'down' : 'even';
  const absAvg = reactions.length ? reactions.reduce((a, r) => a + Math.abs(r.ret), 0) / reactions.length : null;
  return { score: Math.round(score * 10) / 10, verdict, items, swing: absAvg };
}

const cache = new Map();
export async function getEarningsOutlook(symbol, name, nextDate) {
  const key = `${symbol}|${nextDate}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.data;
  const [chart, fund, crowd] = await Promise.all([
    getChart(symbol, '1d').catch(() => null),
    getFundamentals(symbol, name).catch(() => null),
    getCrowd({ symbol, name, mode: 'stock' }).catch(() => null),
  ]);
  const c = chart?.candles || [];
  const reactions = pastReactions(c, nextDate);
  const runup = c.length > 22 ? c[c.length - 1].close / c[c.length - 22].close - 1 : null;
  const data = { symbol, nextDate, reactions, ...judgeOutlook({ reactions, fund, crowd, runup }), at: Date.now() };
  cache.set(key, { at: Date.now(), data });
  return data;
}
