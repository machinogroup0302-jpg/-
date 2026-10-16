// 毎朝のメール（GitHub Actions から動かす）
// やることボードのサイトに「明日の予定・引き落とし」を聞いて、あればメールで送る
// 必要な GitHub Secrets:
//   BOARD_URL      … やることボードのURL（例 https://yarukoto-board.onrender.com）
//   BOARD_PASSWORD … やることボードのパスワード（Render と同じもの）
//   MAIL_USER・MAIL_PASS … 送るのに使う Gmail とアプリパスワード（売買サインのメールと同じもの）
// TEST_MAIL=1 のときは、予定がなくても送る
const { BOARD_URL, BOARD_PASSWORD, MAIL_USER, MAIL_PASS, TEST_MAIL } = process.env;

if (!BOARD_URL || !BOARD_PASSWORD) {
  console.log('BOARD_URL・BOARD_PASSWORD が登録されていないため送れません');
  process.exit(0);
}

// Render の無料プランは眠っていることがあるので、起きるまで何度か聞く
async function getDigest() {
  const url = BOARD_URL.replace(/\/+$/, '') + '/api/digest';
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, { headers: { 'x-board-key': BOARD_PASSWORD }, signal: AbortSignal.timeout(90000) });
      if (res.status === 401) throw Object.assign(new Error('パスワードが違います（BOARD_PASSWORD を確認してください）'), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      console.log(`まだ返事がありません（${i + 1}回目）: ${e.message}`);
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
  throw lastErr;
}

const d = await getDigest();
console.log(`${d.date}: 予定・引き落とし ${d.count}件 / 宛先 ${d.to ? 'あり' : 'なし'}`);
if (!d.to) { console.log('サイトの「設定」でメールが登録されていないか、オフになっています'); process.exit(0); }
if (!d.count && !TEST_MAIL) { console.log('明日は何もないので送りません'); process.exit(0); }
if (!MAIL_USER || !MAIL_PASS) { console.log('MAIL_USER・MAIL_PASS が登録されていないため送れません'); process.exit(1); }

const nodemailer = (await import('nodemailer')).default;
const tr = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS.replace(/\s/g, '') } });
await tr.sendMail({ from: `やることボード <${MAIL_USER}>`, to: d.to, subject: (TEST_MAIL && !d.count ? '【テスト】' : '') + d.subject, text: d.text });
console.log('送りました');
