// 生成した全 HTML を、docs/PLAN.md §8 フェーズ1 の受け入れ基準で機械的に検査する
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, posix, basename } from 'node:path';
import { build } from '../scripts/build.mjs';
import { loadData } from '../scripts/lib/data.mjs';
import { linkAllowlist, isAllowedLink } from '../scripts/lib/links.mjs';
import { hasStandaloneOfficial } from '../scripts/validate.mjs';
import { BANNER_TEXT, CSP } from '../scripts/lib/render.mjs';

const NOW = new Date('2026-10-23T07:00:00Z');
const MAX_PAGE_BYTES = 60 * 1024;
const FORBIDDEN_TAGS = ['form', 'input', 'textarea', 'select', 'button', 'script', 'iframe', 'frame', 'object', 'embed', 'style', 'base'];
const SAMPLE_INCIDENTS = JSON.parse(readFileSync(new URL('./fixtures/incidents.sample.json', import.meta.url), 'utf8'));

// ---- 素朴な HTML の読み取り（依存なし） ----
function decode(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function tags(htmlText) {
  const out = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(htmlText))) {
    const attrs = {};
    const are = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = are.exec(m[2]))) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    out.push({ name: m[1].toLowerCase(), attrs, index: m.index });
  }
  return out;
}
function textOf(htmlText, tag) {
  return [...htmlText.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => decode(m[1].replace(/<[^>]+>/g, '')));
}
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function buildInto(edit) {
  const outDir = mkdtempSync(join(tmpdir(), 'tomattara-build-'));
  const data = loadData();
  edit?.(data);
  build({ outDir, now: NOW, data, siteUrl: 'https://tomattara-navi.github.io/tomattara-navi/' });
  const files = walk(outDir);
  const htmlFiles = files.filter((f) => f.endsWith('.html')).map((f) => ({ file: relative(outDir, f), text: readFileSync(f, 'utf8') }));
  return { outDir, files, htmlFiles, data };
}

let site; // いまのデータ（障害の登録は空にする）で生成したもの
let withIncidents; // 試験用の障害を入れて生成したもの
before(() => {
  site = buildInto((d) => { d.incidents = []; });
  withIncidents = buildInto((d) => { d.incidents = structuredClone(SAMPLE_INCIDENTS); });
});

for (const variant of ['site', 'withIncidents']) {
  const get = () => (variant === 'site' ? site : withIncidents);

  test(`[${variant}] 全ページに「非公式」バナーがあり、本文より前にある`, () => {
    for (const { file, text } of get().htmlFiles) {
      const i = text.indexOf(`<div class="banner" role="note"><p>${BANNER_TEXT}</p></div>`);
      assert.ok(i >= 0, `${file} にバナーがありません`);
      assert.ok(i < text.indexOf('<main'), `${file} のバナーが本文より後ろにあります`);
    }
  });

  test(`[${variant}] 全ページの <title> の末尾が「（非公式）」`, () => {
    for (const { file, text } of get().htmlFiles) {
      const titles = textOf(text, 'title');
      assert.equal(titles.length, 1, file);
      assert.ok(titles[0].endsWith('（非公式）'), `${file}: ${titles[0]}`);
    }
  });

  test(`[${variant}] <form> <input> <script> <iframe> などが1つも無い`, () => {
    for (const { file, text } of get().htmlFiles) {
      for (const t of tags(text)) {
        assert.ok(!FORBIDDEN_TAGS.includes(t.name), `${file} に <${t.name}> があります`);
        for (const attr of Object.keys(t.attrs)) {
          assert.ok(!attr.startsWith('on'), `${file} の <${t.name}> にイベント属性 ${attr} があります`);
          assert.notEqual(attr, 'style', `${file} の <${t.name}> に style 属性があります（CSP で効かない）`);
        }
      }
    }
  });

  test(`[${variant}] 外部リンクはすべて許可ドメイン、サイト内のリンクはすべて実在する`, () => {
    const { htmlFiles, outDir, data } = get();
    const allow = linkAllowlist(data);
    const basePath = '/tomattara-navi/';
    let external = 0;
    for (const { file, text } of htmlFiles) {
      for (const t of tags(text).filter((x) => x.name === 'a')) {
        const href = t.attrs.href;
        assert.ok(href !== undefined && href !== '', `${file}: href の無い <a>`);
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
          external++;
          assert.ok(isAllowedLink(href, allow), `${file}: 許可されていないリンク先 ${href}`);
          continue;
        }
        if (href.startsWith('#')) {
          assert.ok(text.includes(`id="${href.slice(1)}"`), `${file}: ページ内の ${href} がありません`);
          continue;
        }
        // サイト内のリンク（404 だけはサイトの根からの絶対パス）
        let target;
        if (href.startsWith('/')) {
          assert.ok(href.startsWith(basePath), `${file}: ${href}`);
          target = href.slice(basePath.length);
        } else {
          target = posix.normalize(posix.join(posix.dirname(file.split('\\').join('/')), href));
          assert.ok(!target.startsWith('..'), `${file}: サイトの外を指す ${href}`);
        }
        const path = join(outDir, target === '.' ? '' : target);
        const exists = existsSync(path) && (statSync(path).isFile() || existsSync(join(path, 'index.html')));
        assert.ok(exists, `${file}: リンク切れ ${href}`);
      }
    }
    assert.ok(external > 30, '外部リンクの検査が実際に行われていること');
  });

  test(`[${variant}] 外部への読み込みが 0（src・stylesheet・icon はすべてサイト内）`, () => {
    for (const { file, text } of get().htmlFiles) {
      for (const t of tags(text)) {
        if ('src' in t.attrs || 'srcset' in t.attrs) assert.fail(`${file}: <${t.name}> に src があります`);
        if (t.name === 'link' && /stylesheet|icon|preload|prefetch|modulepreload|manifest|dns-prefetch|preconnect/.test(t.attrs.rel ?? '')) {
          const href = t.attrs.href;
          assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//'), `${file}: 外部の読み込み ${href}`);
        }
      }
      const csp = tags(text).find((t) => t.name === 'meta' && t.attrs['http-equiv'] === 'Content-Security-Policy');
      assert.equal(csp?.attrs.content, CSP, `${file}: CSP`);
    }
    const css = readFileSync(join(get().outDir, 'assets', 'site.css'), 'utf8');
    assert.ok(!/@import|url\(/i.test(css), 'CSS から外部を読み込まない');
  });

  test(`[${variant}] 1ページ 60KB 以下（CSS・アイコン込み）`, () => {
    const { htmlFiles, outDir } = get();
    const extra = statSync(join(outDir, 'assets', 'site.css')).size + statSync(join(outDir, 'assets', 'favicon.svg')).size;
    for (const { file, text } of htmlFiles) {
      const bytes = Buffer.byteLength(text) + extra;
      assert.ok(bytes <= MAX_PAGE_BYTES, `${file}: ${bytes} バイト`);
    }
  });

  test(`[${variant}] 見出しの形: h1 は1つ、見出しとタイトルに「公式」を単独で使わない`, () => {
    for (const { file, text } of get().htmlFiles) {
      const h1 = textOf(text, 'h1');
      assert.equal(h1.length, 1, `${file}: h1 が ${h1.length} 個`);
      for (const s of [...textOf(text, 'title'), ...h1, ...textOf(text, 'h2'), ...textOf(text, 'h3')]) {
        assert.ok(!hasStandaloneOfficial(s), `${file}: 「${s}」`);
      }
      assert.match(text, /<html lang="ja">/);
      assert.ok(text.includes('<a class="skip" href="#main">') && text.includes('<main id="main">'), `${file}: 本文へ移動のリンク`);
      assert.ok(!/tabindex="-/.test(text), `${file}: キーボードで届かないリンク`);
    }
  });

  test(`[${variant}] サービスのページの見出しは「〇〇が使えないときの公式情報と代わりの手段」`, () => {
    const { htmlFiles, data } = get();
    for (const s of data.services) {
      const page = htmlFiles.find((f) => f.file === join('s', s.id, 'index.html'));
      assert.ok(page, s.id);
      assert.deepEqual(textOf(page.text, 'h1'), [`${s.name}が使えないときの公式情報と代わりの手段`]);
    }
  });
}

test('障害の登録が無いときは、どのページにも障害の表示を出さない', () => {
  for (const { file, text } of site.htmlFiles) {
    assert.ok(!text.includes('<span class="badge">'), file);
    assert.ok(!text.includes('<article class="incident'), file);
  }
  assert.match(site.htmlFiles.find((f) => f.file === 'index.html').text, /当サイトに登録している公式発表は、いまはありません/);
});

test('公式発表の出典つきの登録があると、トップとサービスのページに「障害中（公式発表）」と出典を出す', () => {
  const top = withIncidents.htmlFiles.find((f) => f.file === 'index.html').text;
  const sagawa = withIncidents.htmlFiles.find((f) => f.file === join('s', 'sagawa', 'index.html')).text;
  for (const text of [top, sagawa]) {
    assert.match(text, /障害中（公式発表）/);
    assert.ok(text.includes('href="https://www2.sagawa-exp.co.jp/information/list/"'));
  }
  const pages = withIncidents.htmlFiles.filter((f) => f.text.includes('<span class="badge">障害中（公式発表）</span>')).map((f) => f.file).sort();
  assert.deepEqual(pages, ['index.html', join('s', 'sagawa', 'index.html')]);
});

test('復旧から30日を過ぎた登録はトップから外れ、過去の事例のページへ', () => {
  const top = withIncidents.htmlFiles.find((f) => f.file === 'index.html').text;
  const past = withIncidents.htmlFiles.find((f) => f.file === join('past', 'index.html')).text;
  assert.ok(!top.includes('ポータルがつながりにくい'));
  assert.ok(past.includes('ポータルがつながりにくい'));
});

test('「未確認」と「無い」を区別して表示する', () => {
  const page = (id) => site.htmlFiles.find((f) => f.file === join('s', id, 'index.html')).text;
  assert.match(page('ana'), /電話の窓口: <span class="unverified">未確認<\/span>/);
  assert.match(page('sagawa'), /電話の窓口は無い（公式のページで確認）/);
  assert.match(page('smbc'), /受付時間は公式ページで確かめてください/);
  assert.match(page('jal'), /大部分を確かめていません/);
  assert.ok(!page('jal').includes('空港'), 'JAL のページは公式トップと「未確認」の表示だけ');
});

test('確認から180日を過ぎると「要再確認」と出す', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'tomattara-build-'));
  const data = loadData();
  data.incidents = [];
  build({ outDir, now: new Date('2027-05-01T00:00:00Z'), data });
  assert.match(readFileSync(join(outDir, 's', 'mufg', 'index.html'), 'utf8'), /<span class="stale">要再確認/);
  assert.ok(!site.htmlFiles.some((f) => f.text.includes('class="stale"')));
});

test('値はエスケープされる', () => {
  const { htmlFiles } = buildInto((d) => { d.services.find((s) => s.id === 'mufg').notes.push('<img src=x onerror=alert(1)>'); });
  const text = htmlFiles.find((f) => f.file === join('s', 'mufg', 'index.html')).text;
  assert.ok(text.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!text.includes('<img'));
});

test('偽サイトのページに公式ドメインの一覧と相談先を出す', () => {
  const text = site.htmlFiles.find((f) => f.file === join('phishing', 'index.html')).text;
  for (const d of ['bk.mufg.jp', 'kuronekoyamato.co.jp', 'secure.okbiz.jp/eki-net/', 'myna.go.jp', 'vb2.jp', 'mynaportal.go.jp']) assert.ok(text.includes(`<code>${d}</code>`), d);
  assert.ok(!text.includes('<code>amazon.co.jp</code>'), '大部分が未確認のサービスのドメインは載せない');
  for (const s of ['#9110', '188', 'フィッシング対策協議会']) assert.ok(text.includes(s), s);
});

test('sitemap.xml・robots.txt・404.html を出す', () => {
  const sitemap = readFileSync(join(site.outDir, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.length, site.htmlFiles.length - 1);
  assert.ok(locs.every((l) => l.startsWith('https://tomattara-navi.github.io/tomattara-navi/')));
  assert.ok(locs.includes('https://tomattara-navi.github.io/tomattara-navi/s/mufg/'));
  assert.match(readFileSync(join(site.outDir, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/tomattara-navi\.github\.io\/tomattara-navi\/sitemap\.xml/);
  const notFound = site.htmlFiles.find((f) => f.file === '404.html').text;
  assert.match(notFound, /<meta name="robots" content="noindex">/);
  assert.match(notFound, /href="\/tomattara-navi\/assets\/site\.css"/);
});

test('Search Console の確認用 meta はトップの <head> にだけ出し、確認用の HTML ファイルは置かない', () => {
  const meta = `<meta name="google-site-verification" content="${site.data.site.google_site_verification}">`;
  const top = site.htmlFiles.find((f) => f.file === 'index.html').text;
  assert.equal(top.split(meta).length - 1, 1);
  assert.ok(top.indexOf(meta) < top.indexOf('</head>'));
  assert.deepEqual(site.htmlFiles.filter((f) => f.text.includes('name="google-site-verification"')).map((f) => f.file), ['index.html']);
  assert.ok(!site.files.some((f) => /^google.*\.html$/i.test(basename(f))), 'google*.html を dist に置かない');
  const noCode = buildInto((d) => { d.incidents = []; d.site.google_site_verification = null; });
  assert.ok(!noCode.htmlFiles.some((f) => f.text.includes('name="google-site-verification"')), 'null なら出さない');
});

test('OGP の画像はサイト内のファイルを指す', () => {
  const text = site.htmlFiles.find((f) => f.file === 'index.html').text;
  assert.match(text, /<meta property="og:image" content="https:\/\/tomattara-navi\.github\.io\/tomattara-navi\/assets\/og\.png">/);
  assert.ok(existsSync(join(site.outDir, 'assets', 'og.png')));
});
