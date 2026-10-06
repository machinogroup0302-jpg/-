// 自分専用 FX・株 分析サイトのサーバー
// 起動: npm start  →  http://localhost:3000
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getChart } from './lib/market.js';
import { getNews } from './lib/news.js';
import { searchListings, listingMeta } from './lib/listings.js';
import { startScan, scanStatus } from './lib/scanner.js';
import { analyzeChartImage, extractTradesFromImage, coachTrades, researchMarket, scenarioForecast, analyzeOrderBookImage, aiErrorMessage } from './lib/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const VENDOR = {
  '/vendor/lightweight-charts.js': path.join(here, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'),
};
const PORT = Number(process.env.PORT) || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('ma:' + SITE_PASSWORD).digest('hex');
const MAX_BODY = 15 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('データが大きすぎます（15MBまで）'), { status: 413, expose: true }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('送信データの形式が正しくありません'), { status: 400, expose: true }));
      }
    });
    req.on('error', reject);
  });
}

// ---- ログイン（SITE_PASSWORD を設定したときだけ有効） ----
function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('hex');
}
function makeToken() {
  const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}
function validToken(token) {
  const [exp, mac] = String(token || '').split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}
function authed(req) {
  return !SITE_PASSWORD || validToken(cookie(req, 'ma_session'));
}
function samePassword(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(SITE_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// 予想シナリオに渡すデータを、決まった形と大きさにそろえる
function scenarioInput(b) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const mc = b.mc || {};
  return {
    symbol: String(b.symbol || '').slice(0, 30),
    name: String(b.name || '').slice(0, 60),
    price: n(b.price),
    closes: (Array.isArray(b.closes) ? b.closes : []).slice(-60).map(n),
    technical: String(b.technical || '').slice(0, 20),
    levels: (Array.isArray(b.levels) ? b.levels : []).slice(0, 10).map((l) => String(l).slice(0, 40)),
    mc: { p05: n(mc.p05), p50: n(mc.p50), p95: n(mc.p95) },
  };
}

// ---- API ----
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/status') {
    return json(res, 200, { loginRequired: !!SITE_PASSWORD, loggedIn: authed(req), aiServerKey: !!process.env.ANTHROPIC_API_KEY });
  }
  if (route === 'POST /api/login') {
    const body = await readBody(req);
    if (!SITE_PASSWORD || samePassword(body.password || '')) {
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `ma_session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}${secure}`);
      return json(res, 200, { ok: true });
    }
    await new Promise((r) => setTimeout(r, 800));
    return json(res, 401, { error: 'パスワードが違います' });
  }
  if (!authed(req)) return json(res, 401, { error: 'ログインしてください' });

  if (route === 'GET /api/chart') {
    try {
      return json(res, 200, await getChart(url.searchParams.get('symbol'), url.searchParams.get('tf') || '1h'));
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }
  if (route === 'GET /api/stocks/search') {
    try {
      return json(res, 200, { items: await searchListings(String(url.searchParams.get('q') || '').slice(0, 40)) });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }
  if (route === 'GET /api/stocks/meta') {
    try {
      return json(res, 200, await listingMeta());
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }
  if (route === 'POST /api/stocks/scan') {
    const body = await readBody(req);
    const markets = (Array.isArray(body.markets) ? body.markets : []).map(String).filter((m) => ['プライム', 'スタンダード', 'グロース', '外国株'].includes(m));
    const j = startScan({ markets });
    return json(res, 200, { status: j.status });
  }
  if (route === 'GET /api/stocks/scan') {
    const q = url.searchParams;
    return json(res, 200, scanStatus({
      view: q.get('view') || 'buy',
      sector: q.get('sector') || '',
      minPrice: Number(q.get('min')) || 0,
      maxPrice: Number(q.get('max')) || 0,
      limit: Number(q.get('limit')) || 100,
    }));
  }
  if (route === 'GET /api/news') {
    try {
      return json(res, 200, await getNews(url.searchParams.get('q')));
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  const userKey = String(req.headers['x-anthropic-key'] || '');
  const aiRoutes = {
    'POST /api/ai/chart-image': (b) => analyzeChartImage(userKey, b.image, String(b.memo || '').slice(0, 500)),
    'POST /api/ai/trades-image': (b) => extractTradesFromImage(userKey, b.image),
    'POST /api/ai/coach': (b) => coachTrades(userKey, b.stats),
    'POST /api/ai/orderbook-image': (b) => analyzeOrderBookImage(userKey, b.image),
    'POST /api/ai/scenario': (b) => scenarioForecast(userKey, scenarioInput(b)),
    'POST /api/ai/research': (b) => researchMarket(userKey, { symbol: String(b.symbol || '').slice(0, 30), name: String(b.name || '').slice(0, 60) }),
  };
  if (aiRoutes[route]) {
    try {
      const body = await readBody(req);
      return json(res, 200, await aiRoutes[route](body));
    } catch (e) {
      if (e.expose) return json(res, e.status, { error: e.message });
      const { status, message } = aiErrorMessage(e);
      console.error(route, e);
      return json(res, status, { error: message });
    }
  }
  return json(res, 404, { error: 'not found' });
}

// ---- 画面ファイル ----
async function serveStatic(req, res, url) {
  let file = VENDOR[url.pathname];
  if (!file) {
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
  }
  try {
    const data = await fs.readFile(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': type, 'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300' });
  } catch {
    send(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return await serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || 'サーバーエラー' });
  }
});

server.listen(PORT, () => {
  console.log(`分析サイトを起動しました: http://localhost:${PORT}`);
  if (!SITE_PASSWORD) console.log('注意: SITE_PASSWORD が未設定のため、URLを知っている人は誰でも開けます。');
});
