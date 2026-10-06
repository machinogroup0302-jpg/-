// AI（Claude）を使う分析
// ・チャート画像の分析と抵抗線の位置の読み取り
// ・取引履歴の画像から取引を読み取る
// ・ネット/SNSの情報を集めて嘘っぽい情報を除いた総合分析（ファンダメンタルズ含む）
// ・取引成績へのアドバイス
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
// 安全フィルタで断られた場合に、自動で別モデルに切り替えて続行する
const BETAS = ['server-side-fallback-2026-07-01'];

export class AiNotConfigured extends Error {}

function clientFor(userKey) {
  const apiKey = process.env.ANTHROPIC_API_KEY || userKey;
  if (!apiKey) throw new AiNotConfigured('AIのAPIキーが設定されていません。「設定」画面でAPIキーを入れてください。');
  return new Anthropic({ apiKey });
}

function textOf(message) {
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function checkStop(message) {
  if (message.stop_reason === 'refusal') throw new Error('AIがこの依頼を処理できませんでした。別の画像や内容でお試しください。');
  if (message.stop_reason === 'max_tokens') throw new Error('AIの回答が長すぎて途中で切れました。もう一度お試しください。');
}

// JSONスキーマで形を固定した回答をもらう
async function structured(userKey, { system, content, schema, effort = 'medium', maxTokens = 16000 }) {
  const client = clientFor(userKey);
  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: BETAS,
    fallbacks: 'default',
    output_config: { effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  checkStop(message);
  return JSON.parse(textOf(message));
}

function imageBlock(dataUrl) {
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('画像の形式が正しくありません（PNG / JPEG / WebP に対応）');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[3] } };
}

const str = { type: 'string' };
const num = { type: 'number' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });

// ---------------- チャート画像の分析 ----------------
const CHART_SCHEMA = obj({
  symbol: str,
  timeframe: str,
  trend: { type: 'string', enum: ['上昇', '下降', '横ばい', '不明'] },
  current_price: num,
  summary: str,
  axis_ticks: arr(obj({ price: num, y: num })),
  levels: arr(obj({
    kind: { type: 'string', enum: ['support', 'resistance'] },
    price: num,
    y: num,
    strength: { type: 'string', enum: ['強', '中', '弱'] },
    note: str,
  })),
  trendlines: arr(obj({
    kind: { type: 'string', enum: ['上昇トレンドライン', '下降トレンドライン', 'チャネル上限', 'チャネル下限'] },
    x1: num, y1: num, x2: num, y2: num,
    note: str,
  })),
  patterns: arr(obj({ name: str, meaning: str })),
  signals: arr(obj({ name: str, direction: { type: 'string', enum: ['買い', '売り', '中立'] }, detail: str })),
  scenario: obj({ bullish: str, bearish: str, plan: str }),
});

export async function analyzeChartImage(userKey, dataUrl, memo) {
  return structured(userKey, {
    effort: 'high',
    system: 'あなたはFXと日本株のテクニカル分析の専門家です。投資初心者にも分かる、専門用語をできるだけ使わない、中学生にも分かるやさしい日本語で（専門用語を使うときは、かっこで短い説明を付けて）答えてください。断定は避け、根拠を添えてください。',
    content: [
      imageBlock(dataUrl),
      {
        type: 'text',
        text: `このチャートのスクリーンショット（iSPEED や LION FX など）を分析してください。${memo ? `\n利用者のメモ: ${memo}` : ''}

座標のルール:
- 画像の左上を (0,0)、右下を (1,1) とした割合で表してください（x は横、y は縦）。
- axis_ticks: 右側（または左側）の価格目盛りから、読み取れる数字を上から下まで3〜6個、その価格と縦位置 y を入れてください。読めなければ空にしてください。
- levels: 重要なサポートライン・レジスタンスラインを合計3〜6本。何度も止められた価格、直近の高値・安値、キリの良い数字を優先し、price と y の両方を入れてください。
- trendlines: 引ける場合だけ、ローソク足の安値同士（上昇）または高値同士（下降）を結ぶ線を最大3本。始点と終点を座標で入れてください。
- current_price: 読み取れる現在値。分からなければ 0。
- symbol / timeframe: 画面から読み取れなければ「不明」。
- patterns: ダブルトップ、三角持ち合い、ヘッドアンドショルダーなど、見えるもの。なければ空。
- signals: 画面に出ているインジケーター（移動平均、RSI、MACD、ボリンジャーバンド、一目均衡表など）から読み取れるサイン。
- scenario: 上がる場合・下がる場合のシナリオと、エントリー・損切りの考え方の例（plan）。`,
      },
    ],
    schema: CHART_SCHEMA,
  });
}

// ---------------- 取引履歴画像の読み取り ----------------
const TRADES_SCHEMA = obj({
  trades: arr(obj({
    datetime: str,
    symbol: str,
    side: { type: 'string', enum: ['買', '売', '不明'] },
    quantity: num,
    price: num,
    pnl: num,
    is_closed: { type: 'boolean' },
  })),
  note: str,
});

export async function extractTradesFromImage(userKey, dataUrl) {
  return structured(userKey, {
    effort: 'medium',
    system: 'あなたは証券会社・FX会社の取引履歴画面を正確に表データへ書き起こす担当者です。読み取れない値は推測せず 0 または「不明」にしてください。',
    content: [
      imageBlock(dataUrl),
      {
        type: 'text',
        text: `この取引履歴（約定履歴・決済履歴）のスクリーンショットから、1行ずつ取引を書き出してください。
- datetime: 「2026-10-01 14:23」の形式（年が無ければ分かる範囲で）
- side: 買 / 売（新規・決済の区別ではなく、売買の方向）
- pnl: 決済損益（円）。損失はマイナス。決済でない行や不明な場合は 0
- is_closed: 決済（損益が確定した）行なら true
- note: 読み取りで気になった点があれば一言`,
      },
    ],
    schema: TRADES_SCHEMA,
  });
}

// ---------------- 取引成績へのアドバイス ----------------
const COACH_SCHEMA = obj({
  summary: str,
  strengths: arr(str),
  weaknesses: arr(str),
  rules: arr(str),
});

export async function coachTrades(userKey, stats) {
  return structured(userKey, {
    effort: 'medium',
    system: 'あなたは個人トレーダーのコーチです。統計データだけを根拠に、専門用語をできるだけ使わない、中学生にも分かるやさしい日本語で（専門用語を使うときは、かっこで短い説明を付けて）具体的に助言してください。特定の銘柄の売買を勧めないでください。',
    content: [{
      type: 'text',
      text: `次は私の過去の取引成績の集計です。良い点・直すべき癖・明日から守るルール（3〜5個）を教えてください。\n\n${JSON.stringify(stats)}`,
    }],
    schema: COACH_SCHEMA,
  });
}

// ---------------- ネット・SNS情報の総合分析（Web検索あり） ----------------
const RESEARCH_FORMAT = `{
  "fundamentals": {
    "summary": "ファンダメンタルズの要点（3〜5文）",
    "factors": [{ "name": "要因名（例: 日米金利差、決算、PER）", "direction": "上昇要因|下落要因|中立", "detail": "説明" }]
  },
  "news": [{
    "title": "見出し", "source": "媒体名", "url": "URL", "date": "YYYY-MM-DD",
    "credibility": 0から100の数値,
    "verdict": "信頼|要注意|除外",
    "reason": "その判定の理由（裏付けの有無・情報源・あおり表現など）",
    "impact": "上昇材料|下落材料|中立"
  }],
  "sns": { "summary": "SNSや掲示板での話題の傾向", "bullish_percent": 0から100の数値, "rumors": ["裏付けのない噂（除外したもの）"] },
  "events": [{ "date": "YYYY-MM-DD", "name": "今後の予定（経済指標・決算・会合など）", "importance": "高|中|低" }],
  "outlook": { "direction": "上昇|下落|横ばい", "short_term": "数日〜1週間の見通し", "mid_term": "1〜3か月の見通し", "risks": ["注意すべきリスク"] }
}`;

// Web検索をしながら調べてもらい、最後のJSONを受け取る
async function webSearchJson(userKey, { system, prompt, maxUses = 8 }) {
  const client = clientFor(userKey);
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }];
  const userMsg = { role: 'user', content: prompt };
  const messages = [userMsg];
  let message;
  for (let i = 0; i < 5; i++) {
    message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: BETAS,
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system,
      tools,
      messages,
    });
    if (message.stop_reason !== 'pause_turn') break;
    // 検索が長引いて一時停止した場合は、そのまま続きを依頼する
    messages.splice(1, messages.length - 1, { role: 'assistant', content: message.content });
  }
  checkStop(message);
  if (message.stop_reason === 'pause_turn') throw new Error('調査に時間がかかりすぎました。もう一度お試しください。');

  const text = textOf(message);
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('AIの回答を読み取れませんでした。もう一度お試しください。');
  }
}

export async function researchMarket(userKey, { symbol, name }) {
  const today = new Date().toISOString().slice(0, 10);
  return webSearchJson(userKey, {
    system: 'あなたは慎重な金融リサーチャーです。事実と噂をはっきり区別し、専門用語をできるだけ使わない、中学生にも分かるやさしい日本語で（専門用語を使うときは、かっこで短い説明を付けて）書いてください。',
    prompt: `今日は ${today} です。「${name || symbol}」（コード: ${symbol}）について、Web検索で最新の情報を集めて分析してください。

手順:
1. 大手メディア・公的機関・会社の発表などの一次情報、金融専門メディア、SNSや掲示板の話題を幅広く調べる。
2. 1つ1つの情報について、情報源の信頼性、複数の独立した情報源で裏付けが取れるか、日付が新しいか、あおり表現がないかを確認し、credibility を付ける。裏付けのない噂・古い情報の使い回し・誇張は verdict を「除外」にする。
3. FXなら金利・金融政策・経済指標・要人発言、株なら業績・決算・PER/PBR・配当・業界動向などのファンダメンタルズをまとめる。
4. 今後の予定と見通しをまとめる。

最後に、次の形式のJSONだけを \`\`\`json と \`\`\` で囲んで出力してください（説明文は不要）。news は8〜15件。
${RESEARCH_FORMAT}`,
  });
}

// ---------------- 理由つきの予想シナリオ（為替介入・今後のイベントを含む） ----------------
const SCENARIO_FORMAT = `{
  "summary": "今後1か月の見通しの要点（2〜4文）",
  "direction": "上昇|下落|横ばい",
  "main": [{ "date": "YYYY-MM-DD", "price": 数値, "label": "チャートに出す短い見出し（全角10文字以内）", "reason": "その日にその価格になると考える理由" }],
  "bull": [{ "date": "YYYY-MM-DD", "price": 数値 }],
  "bear": [{ "date": "YYYY-MM-DD", "price": 数値 }],
  "bull_reason": "上ぶれするとしたら何が起きたときか",
  "bear_reason": "下ぶれするとしたら何が起きたときか",
  "events": [{ "date": "YYYY-MM-DD", "name": "イベント名", "impact": "上昇要因|下落要因|どちらも", "detail": "影響の説明" }],
  "intervention": { "applicable": true または false, "risk": "高|中|低|対象外", "level": 数値（警戒される価格。なければ0）, "reason": "説明" },
  "key_levels": [{ "price": 数値, "reason": "その価格が意識される理由" }]
}`;

export async function scenarioForecast(userKey, ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const isFx = /=X$/.test(ctx.symbol);
  return webSearchJson(userKey, {
    maxUses: 8,
    system: 'あなたは為替と日本株の相場見通しを作るストラテジストです。根拠のある予想だけを書き、噂は使わず、専門用語をできるだけ使わない、中学生にも分かるやさしい日本語で（専門用語を使うときは、かっこで短い説明を付けて）書いてください。予想は外れることがある前提で書いてください。',
    prompt: `今日は ${today} です。「${ctx.name || ctx.symbol}」（コード: ${ctx.symbol}）の今後およそ1か月（20営業日）の値動きの予想シナリオを作ってください。

いまの相場データ（日足）:
- 現在値: ${ctx.price}
- 直近の終値（古い順）: ${ctx.closes.join(', ')}
- テクニカルの総合判定: ${ctx.technical}
- 自動検出した抵抗線・支持線: ${ctx.levels.join(', ') || 'なし'}
- 統計シミュレーション（20営業日後）: 中心 ${ctx.mc.p50} / 90%の範囲 ${ctx.mc.p05}〜${ctx.mc.p95}

手順:
1. Web検索で、今後1か月の重要イベント（中央銀行の会合・要人発言・経済指標・選挙・決算発表など）と最新の情勢を調べる。
2. ${isFx ? '円が絡む通貨ペアなら、財務省・日銀による為替介入の可能性（過去に介入があった水準、最近の口先介入、財務官の発言など）を必ず調べて intervention に書く。円が絡まない通貨ペアは applicable を false にする。' : '株なので intervention は applicable を false、risk を「対象外」、level を 0 にする。'}
3. 上の相場データとイベントを組み合わせ、メインシナリオ main を 5〜8 個の点（日付と価格）で作る。点はイベントの日や、流れが変わりそうな日に置き、それぞれに「なぜ上がる／下がるのか」の理由を付ける。date はすべて今日より後の営業日にする。
4. 上ぶれ（bull）と下ぶれ（bear）のシナリオも 3〜4 点ずつ作る。

最後に、次の形式のJSONだけを \`\`\`json と \`\`\` で囲んで出力してください（説明文は不要）。
${SCENARIO_FORMAT}`,
  });
}

// ---------------- 板・歩み値の画像の読み取り ----------------
const ORDERBOOK_SCHEMA = obj({
  symbol: str,
  board: arr(obj({ price: num, sell_qty: num, buy_qty: num })),
  ticks: arr(obj({ time: str, price: num, qty: num, side: { type: 'string', enum: ['買い', '売り', '不明'] } })),
  comment: str,
});

export async function analyzeOrderBookImage(userKey, dataUrl) {
  return structured(userKey, {
    effort: 'medium',
    system: 'あなたは株の板情報と歩み値（約定履歴）を正確に読み取る担当者です。読み取れない値は推測しないでください。',
    content: [
      imageBlock(dataUrl),
      {
        type: 'text',
        text: `この画面（iSPEED などの板・歩み値・約定履歴）から数字を読み取ってください。
- board: 板の各行。price=値段、sell_qty=売り注文の株数、buy_qty=買い注文の株数（無い側は0）。値段の高い順。
- ticks: 歩み値の各行。time=時刻、price=約定値段、qty=株数。side は、直前より値段が上がった約定や売り板の値段での約定なら「買い」、下がった約定や買い板の値段での約定なら「売り」、判断できなければ「不明」。
- 板か歩み値の片方しか写っていなければ、もう片方は空の配列にする。
- comment: 厚い板（大きな注文がたまっている値段）、大口の約定、買いと売りどちらが優勢かを、初心者にも分かるように2〜4文で。`,
      },
    ],
    schema: ORDERBOOK_SCHEMA,
  });
}

export function aiErrorMessage(e) {
  if (e instanceof AiNotConfigured) return { status: 400, message: e.message };
  if (e instanceof Anthropic.AuthenticationError) return { status: 401, message: 'APIキーが正しくありません。設定を確認してください。' };
  if (e instanceof Anthropic.PermissionDeniedError) return { status: 403, message: 'このAPIキーでは利用できません。' };
  if (e instanceof Anthropic.RateLimitError) return { status: 429, message: '短時間に使いすぎています。少し待ってからお試しください。' };
  if (e instanceof Anthropic.BadRequestError) return { status: 400, message: `AIへの依頼が受け付けられませんでした: ${e.message}` };
  if (e instanceof Anthropic.APIError) return { status: 502, message: `AIサービスでエラーが発生しました (${e.status ?? '接続エラー'})` };
  return { status: 500, message: e.message || '不明なエラーが発生しました' };
}
