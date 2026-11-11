// チャートの形（パターン）の自動検出
// 天井の形（ダブルトップ・トリプルトップ・三尊・ソーサートップ・V字天井）、
// 底の形（それぞれの逆）、続く形（三角保ち合い・ウェッジ・フラッグ・ペナント・ボックス）を探し、
// 形を作っている線（上値抵抗線・下値支持線・ネックライン）と、抜けたときの目標の値段を返す。
import { atr } from './indicators.js';
import { swings } from './levels.js';

const LOOK = 160; // 見る範囲（チャートに出ている本数くらい）
const FRESH = 30; // 形ができてから、これより古いものは出さない
const BROKE_FRESH = 20; // 抜けてから、これより古いものは出さない

// 山と谷を交互に並べ、小さな上下（ふだんの揺れ）は消す
export function zigzag(candles, A, k = 3) {
  const { highs, lows } = swings(candles, k);
  const pts = [...highs.map((p) => ({ ...p, t: 'H' })), ...lows.map((p) => ({ ...p, t: 'L' }))]
    .sort((a, b) => a.i - b.i || (a.t === 'H' ? -1 : 1));
  const alt = [];
  for (const p of pts) {
    const last = alt[alt.length - 1];
    if (last && last.t === p.t) {
      if (p.t === 'H' ? p.price >= last.price : p.price <= last.price) alt[alt.length - 1] = p;
    } else alt.push(p);
  }
  const thr = A * 1.2;
  const extreme = (a, b) => (a.t === 'H' ? (a.price >= b.price ? a : b) : (a.price <= b.price ? a : b));
  for (;;) {
    let j = -1, best = Infinity;
    for (let x = 1; x < alt.length; x++) {
      const d = Math.abs(alt[x].price - alt[x - 1].price);
      if (d < thr && d < best) { best = d; j = x; }
    }
    if (j < 0) break;
    if (j === 1) alt.splice(0, 1);
    else if (j === alt.length - 1) alt.splice(j, 1);
    else {
      alt[j - 2] = extreme(alt[j - 2], alt[j]);
      alt[j + 1] = extreme(alt[j + 1], alt[j - 1]);
      alt.splice(j - 1, 2);
    }
  }
  return alt;
}

const lineAt = (p1, p2) => {
  const slope = (p2.price - p1.price) / (p2.i - p1.i || 1);
  return (i) => p1.price + slope * (i - p1.i);
};
const seg = (candles, f, from, to) => [
  { time: candles[from].time, price: f(from) },
  { time: candles[to].time, price: f(to) },
];
const flat = (price) => () => price;

// ネックライン（など）をいつ抜けたか。dir=-1 は下に割る、1 は上に抜ける
function breakAt(candles, f, from, dir, A) {
  for (let i = from + 1; i < candles.length; i++) {
    if (dir < 0 ? candles[i].close < f(i) - A * 0.1 : candles[i].close > f(i) + A * 0.1) return i;
  }
  return -1;
}

// ---------- 天井・底の形（山と谷の並びで見る） ----------
function reversals(candles, P, A) {
  const n = candles.length;
  const out = [];
  const tol = A * 0.9;
  for (let m = P.length - 1; m >= 2; m--) {
    const e = P[m];
    if (n - 1 - e.i > FRESH + BROKE_FRESH) break;
    const top = e.t === 'H';
    const dir = top ? -1 : 1; // 完成したら動く向き
    const hi = (p) => (top ? p.price : -p.price); // 天井でも底でも「山」として比べる
    const a5 = m >= 4 ? P.slice(m - 4, m + 1) : null;
    const a3 = P.slice(m - 2, m + 1);
    let found = null;

    if (a5) {
      const [s1, n1, h, n2, s2] = a5;
      const shoulders = Math.abs(s1.price - s2.price) <= tol * 1.6;
      const headUp = hi(h) > Math.max(hi(s1), hi(s2)) + A * 0.5;
      const same3 = Math.max(hi(s1), hi(h), hi(s2)) - Math.min(hi(s1), hi(h), hi(s2)) <= tol * 1.2;
      const deep = Math.min(hi(s1), hi(h), hi(s2)) - Math.max(hi(n1), hi(n2)) >= A * 1.5;
      if (shoulders && headUp && deep) {
        found = {
          key: top ? 'hs-top' : 'hs-bottom',
          name: top ? '三尊（ヘッド・アンド・ショルダー）' : '逆三尊（逆ヘッド・アンド・ショルダー）',
          neck: lineAt(n1, n2), start: s1, peak: h,
          marks: [[s1, top ? '左肩' : '左肩'], [h, top ? '頭' : '頭'], [s2, '右肩']],
          note: top
            ? '真ん中がいちばん高い3つの山。上がる力が弱まった天井の形で、谷を結んだ線（ネックライン）を下に割ると下がりやすくなります。'
            : '真ん中がいちばん低い3つの谷。下がる力が弱まった底の形で、山を結んだ線（ネックライン）を上に抜けると上がりやすくなります。',
        };
      } else if (same3 && deep && Math.abs(n1.price - n2.price) <= tol * 1.5) {
        const neckP = top ? Math.min(n1.price, n2.price) : Math.max(n1.price, n2.price);
        found = {
          key: top ? 'triple-top' : 'triple-bottom',
          name: top ? 'トリプルトップ' : 'トリプルボトム',
          neck: flat(neckP), start: s1, peak: top ? [s1, h, s2].reduce((x, y) => (y.price > x.price ? y : x)) : [s1, h, s2].reduce((x, y) => (y.price < x.price ? y : x)),
          resist: (s1.price + h.price + s2.price) / 3, resistFrom: s1, resistTo: s2,
          marks: [[s2, top ? 'トリプルトップ' : 'トリプルボトム']],
          note: top
            ? '同じくらいの高さで3回上がって止められた天井の形。谷の線（ネックライン）を下に割ると下がりやすくなります。'
            : '同じくらいの安さで3回下げ止まった底の形。山の線（ネックライン）を上に抜けると上がりやすくなります。',
        };
      }
    }
    if (!found) {
      const [p1, nk, p2] = a3;
      const same = Math.abs(p1.price - p2.price) <= tol;
      const deep = Math.min(hi(p1), hi(p2)) - hi(nk) >= A * 3;
      const wide = p2.i - p1.i >= 10;
      // その前は反対側から来ている（天井なら下から上がってきた）
      const before = P[m - 3];
      const came = !before || (top ? before.price < nk.price : before.price > nk.price);
      if (same && deep && wide && came) {
        found = {
          key: top ? 'double-top' : 'double-bottom',
          name: top ? 'ダブルトップ' : 'ダブルボトム',
          neck: flat(nk.price), start: p1, peak: hi(p1) >= hi(p2) ? p1 : p2,
          resist: (p1.price + p2.price) / 2, resistFrom: p1, resistTo: p2,
          marks: [[p2, top ? 'ダブルトップ' : 'ダブルボトム']],
          note: top
            ? '同じくらいの高さで2回上がって止められた天井の形（Mの字）。真ん中の谷の値段（ネックライン）を下に割ると下がりやすくなります。'
            : '同じくらいの安さで2回下げ止まった底の形（Wの字）。真ん中の山の値段（ネックライン）を上に抜けると上がりやすくなります。',
        };
      }
    }
    if (!found) continue;

    // 形のあと、天井（底）をはっきり超えたら、その形は崩れた
    const lim = found.peak.price + (top ? A * 0.3 : -A * 0.3);
    let failed = false;
    for (let i = e.i + 1; i < n; i++) if (top ? candles[i].close > lim : candles[i].close < lim) { failed = true; break; }
    if (failed) continue;
    const b = breakAt(candles, found.neck, e.i, dir, A);
    if (b >= 0 && n - 1 - b > BROKE_FRESH) continue;
    if (b < 0 && n - 1 - e.i > FRESH) continue;
    const height = Math.abs(found.peak.price - found.neck(found.peak.i));
    const at = b >= 0 ? b : n - 1;
    const lines = [{ role: 'neck', label: 'ネックライン', pts: seg(candles, found.neck, found.start.i, n - 1) }];
    if (found.resist != null) {
      lines.push({ role: top ? 'res' : 'sup', label: top ? '上値抵抗線' : '下値支持線', pts: seg(candles, flat(found.resist), found.resistFrom.i, n - 1) });
    }
    out.push({
      key: found.key, name: found.name, dir, family: 'rev',
      status: b >= 0 ? 'done' : 'forming',
      endI: Math.max(e.i, b), pivI: e.i,
      neckNow: found.neck(n - 1),
      target: found.neck(at) + dir * height,
      lines,
      marks: found.marks.map(([p, text]) => ({ time: p.time, text, top: p.t === 'H' })),
      note: found.note,
    });
  }
  return out;
}

// ---------- 続く形（線で囲まれた保ち合い） ----------
function fitEdge(pts, upper) {
  const xs = pts.map((p) => p.i), ys = pts.map((p) => p.price);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, k) => { num += (x - mx) * (ys[k] - my); den += (x - mx) ** 2; });
  const slope = den ? num / den : 0;
  // 線が点を突き抜けないよう、いちばん外の点に合わせる
  const off = Math.max(...pts.map((p) => (upper ? 1 : -1) * (p.price - (my + slope * (p.i - mx)))));
  const c = my + (upper ? off : -off);
  return { slope, f: (i) => c + slope * (i - mx) };
}

function consolidation(candles, P, A) {
  const n = candles.length;
  const recent = P.filter((p) => p.i >= n - 80);
  // 最後の4〜6個の山と谷で見る
  for (let len = Math.min(6, recent.length); len >= 4; len--) {
    const pts = recent.slice(-len);
    const hs = pts.filter((p) => p.t === 'H'), ls = pts.filter((p) => p.t === 'L');
    if (hs.length < 2 || ls.length < 2) continue;
    const s = pts[0].i;
    const span = n - 1 - s;
    if (span < 12) continue;
    if (n - 1 - pts[pts.length - 1].i > FRESH) continue;
    const U = fitEdge(hs, true), L = fitEdge(ls, false);
    const su = (U.slope * span) / A, sl = (L.slope * span) / A; // 形の中で何ATR動いたか
    const w0 = U.f(s) - L.f(s), w1 = U.f(n - 1) - L.f(n - 1);
    if (w0 < A * 1.5 || w1 <= 0) continue;
    // 抜けた足（最後の数本まで）より前は、ほとんど線の中にある
    const last = pts[pts.length - 1].i;
    let outside = 0;
    for (let i = s; i <= last; i++) if (candles[i].close > U.f(i) + A * 0.5 || candles[i].close < L.f(i) - A * 0.5) outside++;
    if (outside > (last - s + 1) * 0.1) continue;

    const conv = w1 < w0 * 0.75, parallel = w1 >= w0 * 0.75 && w1 <= w0 * 1.33;
    const fU = Math.abs(su) < 1, fL = Math.abs(sl) < 1;
    // 形の前に勢いよく動いた「旗ざお」
    const p0 = Math.max(0, s - 15);
    const lowB = Math.min(...candles.slice(p0, s + 1).map((c) => c.low));
    const highB = Math.max(...candles.slice(p0, s + 1).map((c) => c.high));
    const poleUp = candles[s].close - lowB >= A * 4, poleDown = highB - candles[s].close >= A * 4;
    const pole = poleUp ? highB - lowB : poleDown ? highB - lowB : 0;

    let key = null, name, note, dir = 0;
    if (fU && fL && parallel) {
      key = 'box'; name = 'ボックス（レンジ）';
      note = '上と下の決まった値段の間を行ったり来たりしている形。上の線を抜けたら上へ、下の線を割ったら下へ動きやすくなります。';
    } else if (span <= 30 && parallel && ((poleUp && su <= 0.5 && sl <= 0.5) || (poleDown && su >= -0.5 && sl >= -0.5))) {
      key = 'flag'; dir = poleUp ? 1 : -1;
      name = poleUp ? '上昇フラッグ' : '下降フラッグ';
      note = poleUp
        ? '勢いよく上がった後の、少し下向きの小休止（旗の形）。上の線を抜けると、また上がりやすい形です。'
        : '勢いよく下がった後の、少し上向きの小休止（旗の形）。下の線を割ると、また下がりやすい形です。';
    } else if (conv && fU && sl >= 1) {
      key = 'asc-tri'; dir = 1; name = '上昇三角形（アセンディング・トライアングル）';
      note = '上は同じ値段で止められ、下（安値）はだんだん切り上がっている形。上の線を抜けると上がりやすくなります。';
    } else if (conv && fL && su <= -1) {
      key = 'desc-tri'; dir = -1; name = '下降三角形（ディセンディング・トライアングル）';
      note = '下は同じ値段で支えられ、上（高値）はだんだん切り下がっている形。下の線を割ると下がりやすくなります。';
    } else if (conv && su <= -1 && sl >= 1) {
      if (span <= 30 && (poleUp || poleDown)) {
        key = 'pennant'; dir = poleUp ? 1 : -1; name = poleUp ? '上昇ペナント' : '下降ペナント';
        note = `勢いよく${poleUp ? '上が' : '下が'}った後の、小さな三角形の小休止。${poleUp ? '上に抜ける' : '下に割る'}と、同じ向きにまた動きやすい形です。`;
      } else {
        key = 'sym-tri'; name = '三角保ち合い（シンメトリカル・トライアングル）';
        note = '高値は切り下がり、安値は切り上がって、値動きがだんだん小さくなっている形。抜けた方向に大きく動きやすくなります。';
      }
    } else if (conv && su >= 1 && sl >= 1 && sl > su) {
      key = 'rise-wedge'; dir = -1; name = '上昇ウェッジ';
      note = '上がってはいるけれど、上げ幅がだんだん小さくなっている形。下の線を割ると下がりやすい（天井になりやすい）形です。';
    } else if (conv && su <= -1 && sl <= -1 && su < sl) {
      key = 'fall-wedge'; dir = 1; name = '下降ウェッジ';
      note = '下がってはいるけれど、下げ幅がだんだん小さくなっている形。上の線を抜けると上がりやすい（底になりやすい）形です。';
    }
    if (!key) continue;

    const bu = breakAt(candles, U.f, last, 1, A), bd = breakAt(candles, L.f, last, -1, A);
    const cands = [bu >= 0 ? [bu, 1] : null, bd >= 0 ? [bd, -1] : null].filter(Boolean).sort((x, y) => x[0] - y[0]);
    const br = cands[0] || null;
    if (br && n - 1 - br[0] > BROKE_FRESH) continue;
    const height = key === 'flag' || key === 'pennant' ? pole : w0;
    const bdir = br ? br[1] : dir;
    const edge = bdir > 0 ? U.f : L.f;
    const at = br ? br[0] : n - 1;
    return [{
      key, name, dir, family: 'cont',
      status: br ? 'done' : 'forming',
      broke: br ? br[1] : 0,
      endI: br ? br[0] : last,
      upper: U.f(n - 1), lower: L.f(n - 1),
      target: bdir ? edge(at) + bdir * height : null,
      lines: [
        { role: 'res', label: '上値抵抗線', pts: seg(candles, U.f, s, n - 1) },
        { role: 'sup', label: '下値支持線', pts: seg(candles, L.f, s, n - 1) },
      ],
      marks: [{ time: candles[last].time, text: name.replace(/（.*）/, ''), top: true }],
      note,
    }];
  }
  return [];
}

// ---------- ソーサー（おわん型）とV字 ----------
function rounding(candles, A) {
  const n = candles.length;
  const out = [];
  for (const w of [80, 50]) {
    if (n < w + 5) continue;
    const s = n - w;
    const ys = candles.slice(s).map((c) => c.close);
    const xs = ys.map((_, k) => (2 * k) / (w - 1) - 1);
    // 2次式 y = a x^2 + b x + c を最小二乗で
    const S = (f) => xs.reduce((t, x, k) => t + f(x, ys[k]), 0);
    const s0 = w, s1 = S((x) => x), s2 = S((x) => x * x), s3 = S((x) => x ** 3), s4 = S((x) => x ** 4);
    const t0 = S((x, y) => y), t1 = S((x, y) => x * y), t2 = S((x, y) => x * x * y);
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const M = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
    const D = det(M);
    if (!D) continue;
    const a = det([[t2, s3, s2], [t1, s2, s1], [t0, s1, s0]]) / D;
    const b = det([[s4, t2, s2], [s3, t1, s1], [s2, t0, s0]]) / D;
    const c = det([[s4, s3, t2], [s3, s2, t1], [s2, s1, t0]]) / D;
    const fit = (x) => a * x * x + b * x + c;
    const my = t0 / w;
    const ssr = S((x, y) => (y - fit(x)) ** 2), sst = S((x, y) => (y - my) ** 2);
    const r2 = sst ? 1 - ssr / sst : 0;
    const vx = -b / (2 * a);
    const depth = Math.abs((fit(-1) + fit(1)) / 2 - fit(vx));
    if (r2 < 0.85 || Math.abs(vx) > 0.4 || depth < A * 3) continue;
    // 左右どちらのふちも、底（天井）からしっかり離れている
    if (Math.min(Math.abs(fit(-1) - fit(vx)), Math.abs(fit(1) - fit(vx))) < A * 2) continue;
    const bottom = a > 0;
    // ふちの値段（左側のはじめの2割でいちばん高い／安い値段）をネックラインにする
    const rimC = candles.slice(s, s + Math.round(w * 0.2));
    const rim = bottom ? Math.max(...rimC.map((x) => x.high)) : Math.min(...rimC.map((x) => x.low));
    const dir = bottom ? 1 : -1;
    const b2 = breakAt(candles, flat(rim), s + Math.round(w * 0.2), dir, A);
    const curve = xs.filter((_, k) => k % 2 === 0 || k === w - 1).map((x) => {
      const k = Math.round(((x + 1) * (w - 1)) / 2);
      return { time: candles[s + k].time, price: fit(x) };
    });
    out.push({
      key: bottom ? 'saucer-bottom' : 'saucer-top', name: bottom ? 'ソーサーボトム（おわん型の底）' : 'ソーサートップ（おわんを伏せた天井）',
      dir, family: 'rev', status: b2 >= 0 ? 'done' : 'forming', endI: b2 >= 0 ? b2 : n - 1, neckNow: rim,
      target: rim + dir * depth,
      lines: [{ role: 'shape', label: 'おわんの形', pts: curve }, { role: 'neck', label: 'ネックライン（ふちの値段）', pts: seg(candles, flat(rim), s, n - 1) }],
      marks: [{ time: candles[s + Math.round(((vx + 1) * (w - 1)) / 2)].time, text: bottom ? 'ソーサーボトム' : 'ソーサートップ', top: !bottom }],
      note: bottom
        ? 'ゆっくり下がって、ゆっくり上がってきたおわん型の底。左のふちの値段（ネックライン）を上に抜けると、上がりやすくなります。'
        : 'ゆっくり上がって、ゆっくり下がってきたおわんを伏せた形の天井。左のふちの値段（ネックライン）を下に割ると、下がりやすくなります。',
    });
    break;
  }
  // V字（スパイク）：急に下がって急に戻した（天井はその逆）
  const from = Math.max(13, n - 30);
  for (const bottom of [true, false]) {
    let j = -1;
    for (let i = from; i < n - 2; i++) if (j < 0 || (bottom ? candles[i].low < candles[j].low : candles[i].high > candles[j].high)) j = i;
    if (j < 0) continue;
    const ext = bottom ? candles[j].low : candles[j].high;
    // ここ60本でいちばん安い（高い）ところでなければ、ふつうの上下
    const wide60 = candles.slice(Math.max(0, n - 60));
    if (bottom ? ext > Math.min(...wide60.map((c) => c.low)) : ext < Math.max(...wide60.map((c) => c.high))) continue;
    let a = j - 1;
    for (let i = j - 12; i < j; i++) if (bottom ? candles[i].high > candles[a].high : candles[i].low < candles[a].low) a = i;
    const startP = bottom ? candles[a].high : candles[a].low;
    const drop = Math.abs(startP - ext);
    if (drop < A * 5 || drop / (j - a) < A * 0.8) continue; // 急に動いたときだけ
    let r = -1;
    for (let i = j + 1; i <= Math.min(n - 1, j + 12); i++) if (r < 0 || (bottom ? candles[i].close > candles[r].close : candles[i].close < candles[r].close)) r = i;
    if (r < 0 || Math.abs(candles[r].close - ext) < drop * 0.6) continue;
    const dir = bottom ? 1 : -1;
    const b3 = breakAt(candles, flat(startP), j, dir, A);
    out.push({
      key: bottom ? 'v-bottom' : 'v-top', name: bottom ? 'V字の底（スパイク・ボトム）' : '逆V字の天井（スパイク・トップ）',
      dir, family: 'rev', status: b3 >= 0 ? 'done' : 'forming', endI: Math.max(r, b3), neckNow: startP,
      target: null,
      lines: [
        { role: 'shape', label: bottom ? '急に下がった線' : '急に上がった線', pts: [{ time: candles[a].time, price: startP }, { time: candles[j].time, price: ext }] },
        { role: 'shape', label: bottom ? '急に戻した線' : '急に下がった線', pts: [{ time: candles[j].time, price: ext }, { time: candles[r].time, price: candles[r].close }] },
        { role: bottom ? 'res' : 'sup', label: bottom ? '上値抵抗線（下がり始めた値段）' : '下値支持線（上がり始めた値段）', pts: seg(candles, flat(startP), a, n - 1) },
      ],
      marks: [{ time: candles[j].time, text: bottom ? 'V字' : '逆V字', top: !bottom }],
      note: bottom
        ? '急に下がった後、同じくらいの勢いですぐ戻した形。売りが出尽くした合図のことがあり、下がり始めた値段を超えると戻りが強いサインです。'
        : '急に上がった後、同じくらいの勢いですぐ下がった形。買いが出尽くした合図のことがあり、上がり始めた値段を割ると下げが強いサインです。',
    });
  }
  return out;
}

// まとめ：見つかった形を、新しいもの・はっきりしたものから最大3つ
export function detectPatterns(candles) {
  if (!candles || candles.length < 60) return [];
  const all = candles.slice(-Math.max(LOOK + 20, 120));
  const a = atr(all).filter((v) => v != null).slice(-50).sort((x, y) => x - y);
  const A = a[Math.floor(a.length / 2)] || all[all.length - 1].close * 0.01;
  const P = zigzag(all, A).filter((p) => p.i >= all.length - LOOK);
  const found = [...reversals(all, P, A), ...consolidation(all, P, A), ...rounding(all, A)];
  // 同じ種類（天井・底の形／続く形）は、いちばん新しいものだけ
  // ボックスがあるときの「まだ形の途中」の天井・底は、ボックスの上下の線と同じなので出さない
  const box = found.some((p) => p.key === 'box');
  const triple = found.some((p) => /^triple-/.test(p.key));
  // あとから反対向きの天井・底の形ができたら、前の形はもう終わっている
  const superseded = (p) => p.pivI != null && found.some((q) => q !== p && q.pivI != null && q.dir !== p.dir && q.pivI > p.pivI);
  // 同じ山と谷が2つの形に見えるときは、よりはっきりした方だけ出す
  //  三尊があれば三角形・ウェッジは出さない／上昇・下降三角形や旗・ペナントがあればダブル・トリプルは出さない
  const hs = found.some((p) => p.key.startsWith('hs-'));
  const flatTri = found.some((p) => /^(asc-tri|desc-tri|flag|pennant)$/.test(p.key));
  const rank = (p) => (p.key.startsWith('v-') ? 1 : 0); // V字は目安が弱いので後回し
  const seen = new Set();
  return found
    .filter((p) => !(box && p.status === 'forming' && /^double-/.test(p.key)))
    .filter((p) => !(triple && p.key === 'box'))
    .filter((p) => !superseded(p))
    .filter((p) => !(hs && /tri|wedge/.test(p.key)))
    .filter((p) => !(flatTri && /^(double|triple)-/.test(p.key)))
    .filter((p) => !(/flag|pennant/.test(found.map((q) => q.key).join()) && p.key.startsWith('saucer-'))) // 旗ざおの急な動きは、ゆっくりしたおわん型ではない
    .sort((x, y) => (y.status === 'done') - (x.status === 'done') || rank(x) - rank(y) || y.endI - x.endI)
    .filter((p) => {
      const g = p.family + (p.family === 'rev' ? p.dir : '');
      if (seen.has(g)) return false;
      seen.add(g);
      return true;
    })
    .slice(0, 3)
    .map(({ endI, pivI, ...p }) => ({ ...p, endTime: all[endI].time }));
}
