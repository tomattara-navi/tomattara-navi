// サイト・URL・ファイルに店主の個人名を出さない（リポジトリは Organization へ移した）。
// あわせて、公開ページに作業の内部の呼び名（session1・Opus など）を出さない。
// docs/PLAN.md（移管前の経緯を残す）と画像を除く全ファイルと、生成した dist を調べる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, extname } from 'node:path';
import { build } from '../scripts/build.mjs';
import { ROOT } from '../scripts/lib/data.mjs';
import { INTERNAL_NAME_RE } from '../scripts/validate.mjs';

// この試験のファイル自体に当たらないよう、つないで作る
const NAME = ['ueda', 'takashi'].join('');
const SKIP_DIRS = new Set(['.git', 'dist', 'node_modules']);
const SKIP_FILES = new Set(['docs/PLAN.md']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return dir === base && SKIP_DIRS.has(f) ? [] : walk(p, base);
    return [p];
  });
}

// 個人名を含むファイル（パスか中身）を「パス:行」で返す
function findName(dir, { skip = () => false } = {}) {
  const hits = [];
  for (const p of walk(dir)) {
    const rel = relative(dir, p).split('\\').join('/');
    if (skip(rel) || IMAGE_EXTS.has(extname(p).toLowerCase())) continue;
    if (rel.toLowerCase().includes(NAME)) hits.push(`${rel}（ファイル名）`);
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (line.toLowerCase().includes(NAME)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

test('リポジトリのファイル（docs/PLAN.md と画像を除く）に個人名が無い', () => {
  assert.deepEqual(findName(ROOT, { skip: (rel) => SKIP_FILES.has(rel) }), []);
});

test('生成した dist に個人名が無い', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'tomattara-name-'));
  build({ outDir, now: new Date('2026-10-23T07:00:00Z') });
  assert.deepEqual(findName(outDir), []);
});

test('生成した dist に作業の内部の呼び名（session1・Opus など）が無い', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'tomattara-internal-'));
  build({ outDir, now: new Date('2026-10-23T07:00:00Z') });
  const hits = [];
  for (const p of walk(outDir)) {
    if (IMAGE_EXTS.has(extname(p).toLowerCase())) continue;
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(INTERNAL_NAME_RE);
      if (m) hits.push(`${relative(outDir, p)}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(hits, []);
});
