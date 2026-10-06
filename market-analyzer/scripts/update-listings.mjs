// 東証の上場企業一覧を JPX から取ってきて data/listings.json に保存する（GitHub Actions で実行）
import fs from 'node:fs/promises';
import { downloadFromJpx, downloadUpcoming, mergeListing } from '../lib/listings.js';

const FILE = new URL('../data/listings.json', import.meta.url);
let prev = null;
try { prev = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { /* 初回 */ }

const items = await downloadFromJpx();
const upcoming = await downloadUpcoming();
const today = new Date().toISOString().slice(0, 10);
const next = mergeListing(prev, items, upcoming.length ? upcoming : prev?.upcoming || [], today);

// 中身が変わっていなければ保存しない（不要な更新を増やさない）
const same = prev && JSON.stringify(prev.items) === JSON.stringify(next.items) && JSON.stringify(prev.upcoming) === JSON.stringify(next.upcoming);
if (same) {
  console.log(`変更なし（${items.length}社）`);
} else {
  await fs.mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ ...next, fetchedAt: Date.now() }));
  console.log(`保存しました（${items.length}社・上場予定 ${upcoming.length}社）`);
}
