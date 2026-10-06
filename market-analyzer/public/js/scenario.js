// AIの予想シナリオを、チャートに描ける形（時刻と価格の点・目印）に変える
// times はチャート表示用（日本時間にずらした秒）

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫';

export function circled(i) {
  return CIRCLED[i] || `(${i + 1})`;
}

// "2026-10-09" → その日の秒。timeOfDay を日足の時刻に合わせると、統計予想の点と同じ位置に並ぶ
export function dateToTime(date, timeOfDay = 12 * 3600) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(date || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000 + timeOfDay;
}

function cleanPath(points, lastTime) {
  const seen = new Set();
  const tod = ((lastTime % 86400) + 86400) % 86400;
  return (points || [])
    .map((p) => ({ ...p, time: dateToTime(p.date, tod), price: Number(p.price) }))
    .filter((p) => p.time && p.time > lastTime && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.time - b.time)
    .filter((p) => (seen.has(p.time) ? false : seen.add(p.time)));
}

function interpolate(path, time) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (time >= a.time && time <= b.time) return a.value + ((b.value - a.value) * (time - a.time)) / (b.time - a.time || 1);
  }
  return path[path.length - 1].value;
}

export function buildScenarioSeries(result, lastTime, lastClose) {
  const start = { time: lastTime, value: lastClose };
  const mainPts = cleanPath(result.main, lastTime);
  const line = [start, ...mainPts.map((p) => ({ time: p.time, value: p.price }))];

  const markers = mainPts.map((p, i) => {
    const prev = i === 0 ? lastClose : mainPts[i - 1].price;
    const up = p.price >= prev;
    return { time: p.time, position: up ? 'aboveBar' : 'belowBar', shape: up ? 'arrowUp' : 'arrowDown', up, text: `${circled(i)}${p.label || ''}`, kind: 'point' };
  });

  // イベントの日にも目印を付ける（線の上に点を足して位置を合わせる）
  const events = cleanPath((result.events || []).map((e) => ({ ...e, price: 1 })), lastTime);
  if (line.length > 1) {
    for (const ev of events) {
      if (ev.time > line[line.length - 1].time) continue;
      if (!line.some((p) => p.time === ev.time)) line.push({ time: ev.time, value: interpolate(line.slice().sort((a, b) => a.time - b.time), ev.time) });
      markers.push({ time: ev.time, position: 'inBar', shape: 'square', up: ev.impact === '上昇要因', text: ev.name.slice(0, 12), kind: 'event', impact: ev.impact });
    }
  }
  line.sort((a, b) => a.time - b.time);
  markers.sort((a, b) => a.time - b.time);

  const alt = (pts) => {
    const c = cleanPath(pts, lastTime);
    return c.length ? [start, ...c.map((p) => ({ time: p.time, value: p.price }))] : [];
  };
  return { line, markers, bull: alt(result.bull), bear: alt(result.bear), points: mainPts };
}
