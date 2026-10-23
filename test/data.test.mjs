// data/ が docs/PLAN.md 付録A の決まりどおりに入っているか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadData, ROOT } from '../scripts/lib/data.mjs';
import { validate } from '../scripts/validate.mjs';

const data = loadData();

test('data/ は検査を通る', () => {
  assert.deepEqual(validate(data, { today: '2026-10-23' }).errors, []);
});

test('付録A の30件（goo は入れない）', () => {
  assert.equal(data.services.length, 30);
  assert.ok(!data.services.some((s) => s.id === 'goo'));
  const byCat = Object.groupBy(data.services, (s) => s.category);
  assert.deepEqual(Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, v.length])), {
    bank: 6, travel: 5, delivery: 3, shopping: 5, mobile: 4, info: 3, gov: 2, media: 2,
  });
});

test('電話の確認状況: 番号あり17件・窓口なし11件・未確認2件（ANA・えきねっと）', () => {
  const by = (v) => data.services.filter((s) => s.phone_desk === v).map((s) => s.id).sort();
  assert.equal(by('listed').length, 17);
  assert.equal(by('none').length, 11);
  assert.deepEqual(by('unverified'), ['ana', 'ekinet']);
});

test('「大部分が未確認」のサービスは無い（JAL・Amazon・楽天市場は 2026-10-23 に確認）', () => {
  assert.deepEqual(data.services.filter((s) => s.mostly_unverified).map((s) => s.id), []);
});

test('コミックシーモアの公式ドメインは nttsolmare.com と cmoa.jp（運営会社の事業紹介のページからのリンクで確認）', () => {
  assert.deepEqual(data.services.find((s) => s.id === 'cmoa').official_domains, ['nttsolmare.com', 'cmoa.jp']);
});

test('data/schema/*.schema.json は JSON として読める', () => {
  const dir = join(ROOT, 'data', 'schema');
  const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
  assert.ok(files.length >= 4);
  for (const f of files) JSON.parse(readFileSync(join(dir, f), 'utf8'));
});
