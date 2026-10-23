// GitHub Actions の決まり（docs/PLAN.md §2.4-21・22、§8 フェーズ2）を、ワークフローの文字で確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../scripts/lib/data.mjs';

const DIR = join(ROOT, '.github', 'workflows');
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (f) => readFileSync(join(DIR, f), 'utf8');

test('uses: は actions/* だけで、フルコミット SHA で固定し、版をコメントに書く', () => {
  let n = 0;
  for (const f of files) {
    for (const line of read(f).split('\n')) {
      const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
      if (!m) continue;
      n++;
      assert.match(m[1], /^actions\/[a-z0-9-]+(?:\/[a-z0-9-]+)?@[0-9a-f]{40}$/, `${f}: ${line.trim()}`);
      assert.match(m[2], /^\s+# v\d+\.\d+\.\d+$/, `${f}: 版のコメント ${line.trim()}`);
    }
  }
  assert.ok(n >= 8);
});

test('既定の権限は permissions: {}、pull_request_target を使わない', () => {
  for (const f of files) {
    const text = read(f);
    assert.match(text, /^permissions: \{\}$/m, f);
    assert.ok(!text.includes('pull_request_target'), f);
  }
});

test('deploy.yml: cron 7,37 * * * * で観測し、観測は cron の回だけ', () => {
  const text = read('deploy.yml');
  assert.match(text, /schedule:\n\s+- cron: '7,37 \* \* \* \*'/);
  const observe = text.slice(text.indexOf('- name: 観測\n'));
  assert.match(observe.slice(0, 200), /if: github\.event_name == 'schedule'/);
  assert.match(text, /run: node scripts\/check\.mjs\n/);
  assert.match(text, /run: node scripts\/check\.mjs --carry/);
  assert.match(text, /STATUS_FILE: \.cache\/status\.json/);
  // 順番: check → build → デプロイ
  assert.ok(text.indexOf('node scripts/check.mjs') < text.indexOf('node scripts/build.mjs'));
  assert.ok(text.indexOf('node scripts/build.mjs') < text.indexOf('actions/deploy-pages'));
});

test('ci.yml は観測しない（PR ごとに各社へアクセスしない）', () => {
  assert.ok(!read('ci.yml').includes('scripts/check.mjs'));
});
