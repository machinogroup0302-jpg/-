// 通貨ペアの日本語名（サーバーと画面の両方で使う）
export const FX_PAIRS = [
  ['USDJPY', 'ドル円'], ['EURJPY', 'ユーロ円'], ['GBPJPY', 'ポンド円'], ['AUDJPY', '豪ドル円'], ['NZDJPY', 'NZドル円'],
  ['CADJPY', 'カナダドル円'], ['CHFJPY', 'スイスフラン円'], ['ZARJPY', '南アフリカランド円'], ['MXNJPY', 'メキシコペソ円'], ['TRYJPY', 'トルコリラ円'],
  ['CNHJPY', '人民元円'], ['HKDJPY', '香港ドル円'], ['SGDJPY', 'シンガポールドル円'], ['NOKJPY', 'ノルウェークローネ円'], ['SEKJPY', 'スウェーデンクローナ円'],
  ['EURUSD', 'ユーロドル'], ['GBPUSD', 'ポンドドル'], ['AUDUSD', '豪ドル米ドル'], ['NZDUSD', 'NZドル米ドル'], ['USDCHF', 'ドルスイスフラン'],
  ['USDCAD', 'ドルカナダドル'], ['EURGBP', 'ユーロポンド'], ['EURAUD', 'ユーロ豪ドル'], ['GBPAUD', 'ポンド豪ドル'], ['AUDNZD', '豪ドルNZドル'],
].map(([code, name]) => ({ code, symbol: `${code}=X`, name }));

const kata = (s) => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/[\s/・]/g, '');

export function fxName(symbol) {
  return FX_PAIRS.find((p) => p.symbol === symbol || p.code === symbol)?.name || null;
}

// 漢字の部分も読みで探せるようにする（どるえん → ドル円）
const READ = [['円', 'エン'], ['豪', 'ゴウ'], ['米', 'ベイ'], ['人民元', 'ジンミンゲン'], ['香港', 'ホンコン'], ['南アフリカ', 'ミナミアフリカ']];
const yomi = (s) => READ.reduce((t, [k, v]) => t.split(k).join(v), kata(s));

export function searchFx(q) {
  const n = yomi(q);
  if (!n) return FX_PAIRS.slice(0, 10);
  return FX_PAIRS.filter((p) => p.code.toLowerCase().includes(n) || kata(p.name).includes(n) || yomi(p.name).includes(n));
}
