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
  // いまの登録はそのまま残し、後ろに足す（いまの登録を前提にした試験を壊さないため）
  function addIncidents(dir, incidents) {
    const path = join(dir, 'data', 'incidents.json');
    const current = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify([...current, ...incidents], null, 2) + '\n');
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
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', "if (status === 403) return result('unknown', 'http_403', status);", "if (status === 403) return result('ok', 'http_403', status);"),
    },
    {
      name: '2の対照. 403 の行を同じ意味の別の書き方にする（unknown のまま）のは通る',
      expect: 'pass',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', "if (status === 403) return result('unknown', 'http_403', status);", "if (status === 403) return { state: 'unknown', reason: 'http_403', http_status: 403 };"),
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
      apply: (d) => addIncidents(d, [{ ...SAMPLE, sources: SAMPLE.sources.filter((s) => s.type !== 'official') }]),
    },
    {
      name: '4の対照. official の出典がある同じ登録は通る',
      expect: 'pass',
      apply: (d) => addIncidents(d, [SAMPLE]),
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
      apply: (d) => replaceOnce(d, 'scripts/lib/render.mjs', '確かめ方: ${s.verified_by}', '確かめ方: ${s.verified_by}（Opus）'),
    },
    // ---- フェーズ2（自動観測） ----
    {
      name: '10. 503 を ok に分類する',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', "return result('ng', 'http_5xx', status);", "return result('ok', 'http_5xx', status);"),
    },
    {
      name: '11. 時間切れを unknown に分類する',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', "if (e.name === 'TimeoutError' || e.name === 'AbortError') return result('ng', 'timeout');", "if (e.name === 'TimeoutError' || e.name === 'AbortError') return result('unknown', 'timeout');"),
    },
    {
      name: '12. 挑戦ページの目印を見ない',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', "if (isChallenge(headers, bodyText)) return result('unknown', 'challenge', status);", ''),
    },
    {
      name: '13. robots.txt の禁止を無視する',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/check.mjs', "if (robots === 'disallowed') return result('unknown', 'robots_disallow');", ''),
    },
    {
      name: '14. 公式ドメインの外への転送を ok にする',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', "return result('unknown', 'redirect_offsite', status);", "return result('ok', 'redirect_offsite', status);"),
    },
    {
      name: '15. ホストごとのリクエストの上限（2回）を外す',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/check.mjs', 'if (n >= MAX_REQUESTS_PER_HOST) throw new HostBudgetError(host);', ''),
    },
    {
      name: '16. User-Agent にメールアドレスを入れる',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/check.mjs', 'return `${PRODUCT_TOKEN}/1.0 (+${siteUrl}bot/)`;', 'return `${PRODUCT_TOKEN}/1.0 (+${siteUrl}bot/; ${["bot", "example.com"].join("@")})`;'),
    },
    {
      name: '17. 観測が古いかの判断を外す（2時間 → 1年）',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', 'export const STALE_MS = 2 * 60 * 60 * 1000;', 'export const STALE_MS = 365 * 24 * 60 * 60 * 1000;'),
    },
    {
      name: '18. 1回の ng で「応答がありませんでした」を出す',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', 'export const NG_DISPLAY_MIN = 2;', 'export const NG_DISPLAY_MIN = 1;'),
    },
    {
      name: '19. 観測の全滅のときも各社の「応答なし」を出す',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', "if (isObserverFailure(status, now)) return { kind: 'observer_failure', entry: e };", ''),
    },
    {
      name: '20. robots.txt が読めないとき、7日より古いキャッシュにも従う',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/check.mjs', "if (!(age < ROBOTS_KEEP_MS)) return 'unreachable';", "if (!(age < Infinity)) return 'unreachable';"),
    },
    {
      name: '21. robots.txt が読めないとき、7日以内のキャッシュがあっても観測しない（変更前の動き）',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/check.mjs', "if (!(age < ROBOTS_KEEP_MS)) return 'unreachable';", "return 'unreachable';"),
    },
    {
      name: '22. ECONNRESET を ng に分類する',
      expect: 'fail',
      apply: (d) => replaceOnce(d, 'scripts/lib/status.mjs', "const REFUSED_CODES = new Set(['ECONNREFUSED']);", "const REFUSED_CODES = new Set(['ECONNREFUSED', 'ECONNRESET']);"),
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
