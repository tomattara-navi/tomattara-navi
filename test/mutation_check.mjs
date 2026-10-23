// 検算（docs/PLAN.md §10）: わざと壊した版で、CI の検査（validate → test → build）が落ちることを確かめる。
//   node test/mutation_check.mjs
// 「禁止」と書いた注意書き自体に検査が当たって、実は何も検査していない、を防ぐため。
// リポジトリを一時ディレクトリに写し、写しの方だけを書き換える（作業中のファイルは変えない）。
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_TEST_CONTEXT) {
  // `node --test` は test/ の下の .mjs をすべて実行するので、その中からは動かさない
  const { test } = await import('node:test');
  test('検算（node test/mutation_check.mjs で別に実行する）', { skip: true }, () => {});
} else {
  await main();
}

async function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const SKIP = new Set(['.git', 'dist', 'node_modules']);
  const SAMPLE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'incidents.sample.json'), 'utf8'))[0];

  // 写しの中のファイルの文字列を1か所だけ置き換える（見つからなければ検算そのものの誤り）
  function replaceOnce(dir, file, from, to) {
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`検算の書き換え先が ${file} に ${count} 個あります（1個のはず）: ${from}`);
    writeFileSync(path, text.replace(from, to));
  }
  function setIncidents(dir, incidents) {
    writeFileSync(join(dir, 'data', 'incidents.json'), JSON.stringify(incidents, null, 2) + '\n');
  }

  const STEPS = [
    ['validate', ['scripts/validate.mjs']],
    ['test', ['--test']],
    ['build', ['scripts/build.mjs']],
  ];

  function runCi(dir) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const [name, args] of STEPS) {
      const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env });
      if (r.status !== 0) {
        const out = `${r.stdout}\n${r.stderr}`;
        const why = out.match(/^not ok \d+ - .*$/m)?.[0] ?? out.match(/^誤り: .*$/m)?.[0] ?? out.trim().split('\n').slice(-1)[0];
        return { ok: false, step: name, why };
      }
    }
    return { ok: true };
  }

  const cases = [
    { name: '基準（何も壊さない）', expect: 'pass', apply: () => {} },
    {
      name: '1. 「非公式」バナーを1ページ（プライバシー）から消す',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/render.mjs',
        '<div class="banner" role="note"><p>${BANNER_TEXT}</p></div>',
        '${page.path === \'privacy/\' ? \'\' : raw(`<div class="banner" role="note"><p>${BANNER_TEXT}</p></div>`)}'),
    },
    {
      name: '2. 403 を ok に分類する',
      expect: 'skip',
      why: '観測（scripts/check.mjs）はフェーズ2で作るため、フェーズ2の PR でこの検算を足す',
    },
    {
      name: '3. 許可ドメイン外のリンクを1本足す（このサイトについて）',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'content/about.html', '<h2>このサイトがやること</h2>', '<p><a href="https://example.com/">外部</a></p>\n<h2>このサイトがやること</h2>'),
    },
    {
      name: '3の対照. 許可ドメイン（bk.mufg.jp）のリンクを足すのは通る',
      expect: 'pass',
      apply: (d) => replaceOnce(d, 'content/about.html', '<h2>このサイトがやること</h2>', '<p><a href="https://www.bk.mufg.jp/">外部</a></p>\n<h2>このサイトがやること</h2>'),
    },
    {
      name: '4. incidents から official の出典を消す（報道の出典だけの登録）',
      expect: 'fail',
      apply: (d) => setIncidents(d, [{ ...SAMPLE, sources: SAMPLE.sources.filter((s) => s.type !== 'official') }]),
    },
    {
      name: '4の対照. official の出典がある同じ登録は通る',
      expect: 'pass',
      apply: (d) => setIncidents(d, [SAMPLE]),
    },
    {
      name: '5. <input> を1つ足す（このサイトについて）',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'content/about.html', '<h2>このサイトがやること</h2>', '<input name="q">\n<h2>このサイトがやること</h2>'),
    },
    {
      name: '6. 移管前の公開 URL（個人名入り）を README に戻す',
      expect: 'fail',
      // このファイル自体が個人名の試験に当たらないよう、つないで作る
      apply: (d) => replaceOnce(d, 'README.md', 'https://tomattara-navi.github.io/tomattara-navi/', `https://${['ueda', 'takashi'].join('')}.github.io/tomattara-navi/`),
    },
    {
      name: '7. Search Console の確認用 meta を全ページに出す',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/render.mjs', "${page.path === '' && site.google_site_verification ?", '${site.google_site_verification ?'),
    },
    {
      name: '8. verified_by を内部の呼び名（session2 調査）に戻す',
      expect: 'fail',
      apply: (d) => {
        const path = join(d, 'data', 'services.json');
        const services = JSON.parse(readFileSync(path, 'utf8'));
        services.find((s) => s.id === 'mufg').verified_by = 'session2 調査（公式ページで確認）';
        writeFileSync(path, JSON.stringify(services, null, 2) + '\n');
      },
    },
    {
      name: '9. 描画の側で内部の呼び名を足す（データの検査をすり抜ける形）',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/render.mjs', '確かめた人・方法: ${s.verified_by}', '確かめた人・方法: ${s.verified_by}（Opus）'),
    },
  ];

  let bad = 0;
  for (const c of cases) {
    if (c.expect === 'skip') {
      console.log(`- 見送り  ${c.name}（${c.why}）`);
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), 'tomattara-mutation-'));
    try {
      cpSync(ROOT, dir, { recursive: true, filter: (src) => !SKIP.has(src.slice(ROOT.length + 1).split(/[\\/]/)[0]) });
      c.apply(dir);
      const r = runCi(dir);
      const good = c.expect === 'pass' ? r.ok : !r.ok;
      if (!good) bad++;
      const result = r.ok ? '通った' : `落ちた（${r.step}: ${r.why}）`;
      console.log(`${good ? '✓ 期待どおり' : '✗ 期待と違う'}  ${c.name} → ${result}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (bad) {
    console.error(`\n検算: 期待と違う結果が ${bad} 件あります。`);
    process.exit(1);
  }
  console.log('\n検算: すべて期待どおり');
}
