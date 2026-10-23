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

test('電話の確認状況: 番号あり16件・窓口なし9件・未確認5件（JAL・ANA・えきねっと・Amazon・楽天市場）', () => {
  const by = (v) => data.services.filter((s) => s.phone_desk === v).map((s) => s.id).sort();
  assert.equal(by('listed').length, 16);
  assert.equal(by('none').length, 9);
  assert.deepEqual(by('unverified'), ['amazon', 'ana', 'ekinet', 'jal', 'rakutenichiba']);
});

test('JAL・Amazon・楽天市場は「大部分が未確認」', () => {
  assert.deepEqual(data.services.filter((s) => s.mostly_unverified).map((s) => s.id).sort(), ['amazon', 'jal', 'rakutenichiba']);
});

test('コミックシーモアの公式ドメインは確かめるまで nttsolmare.com だけ', () => {
  assert.deepEqual(data.services.find((s) => s.id === 'cmoa').official_domains, ['nttsolmare.com']);
});

test('data/schema/*.schema.json は JSON として読める', () => {
  const dir = join(ROOT, 'data', 'schema');
  const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
  assert.ok(files.length >= 4);
  for (const f of files) JSON.parse(readFileSync(join(dir, f), 'utf8'));
});
