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
import { jstIso } from '../scripts/lib/time.mjs';

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
// ページの <a href> を new URL() で取り出し、完全一致で比べる（URL を文字列の部分一致で調べない）
function linkHrefs(htmlText) {
  return tags(htmlText).filter((t) => t.name === 'a' && t.attrs.href).flatMap((t) => {
    try {
      return [new URL(t.attrs.href).href];
    } catch {
      return []; // サイト内の相対リンク
    }
  });
}
function hasLink(htmlText, url) {
  const target = new URL(url).href;
  return linkHrefs(htmlText).some((h) => h === target);
}
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function buildInto(edit, { status = null } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'tomattara-build-'));
  const data = loadData();
  edit?.(data);
  build({ outDir, now: NOW, data, status: typeof status === 'function' ? status(data) : status, siteUrl: 'https://tomattara-navi.github.io/tomattara-navi/' });
  const files = walk(outDir);
  const htmlFiles = files.filter((f) => f.endsWith('.html')).map((f) => ({ file: relative(outDir, f), text: readFileSync(f, 'utf8') }));
  return { outDir, files, htmlFiles, data };
}

let site; // いまのデータ（障害の登録は空にする）で生成したもの
let withIncidents; // 試験用の障害を入れて生成したもの
let withStatus; // 観測の結果（ok・ng・unknown・保留が混ざったもの）を入れて生成したもの
// 有効なサービスに、順に ok・ng（2回）・unknown・ng（1回）を割り当てた観測の結果（48件の帯つき）
function mixedStatus(data) {
  const kinds = [['ok', 0], ['ng', 2], ['unknown', 0], ['ng', 1]];
  const services = {};
  data.services.filter((s) => s.monitor.enabled).forEach((s, i) => {
    const [state, n] = kinds[i % kinds.length];
    const history = Array.from({ length: 48 }, (_, j) => ({ t: jstIso(new Date(NOW.getTime() - (47 - j) * 1800 * 1000)), s: j % 5 === 0 ? 'unknown' : j % 7 < 2 ? 'ng' : 'ok' }));
    services[s.id] = { state, consecutive_ng: n, http_status: 200, reason: state === 'unknown' ? 'http_403' : 'http_2xx', checked_at: jstIso(NOW), last_ok_at: jstIso(NOW), history };
  });
  return { generated_at: jstIso(NOW), services };
}
before(() => {
  site = buildInto((d) => { d.incidents = []; });
  withIncidents = buildInto((d) => { d.incidents = structuredClone(SAMPLE_INCIDENTS); });
  withStatus = buildInto((d) => { d.incidents = structuredClone(SAMPLE_INCIDENTS); }, { status: mixedStatus });
});

for (const variant of ['site', 'withIncidents', 'withStatus']) {
  const get = () => ({ site, withIncidents, withStatus })[variant];

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

test('[withStatus] の検査は、観測の欄（帯・応答なし・判定できない）を実際に含むページに当たっている', () => {
  const pages = withStatus.htmlFiles.map((f) => f.text).join('\n');
  for (const s of ['<ol class="band">', 'class="b-ng"', 'class="b-unknown"', '応答がありませんでした（公式発表ではありません）', '判定できませんでした', 'obs-mark']) assert.ok(pages.includes(s), s);
  assert.ok(existsSync(join(withStatus.outDir, 'status.json')));
});

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
    assert.ok(hasLink(text, 'https://www2.sagawa-exp.co.jp/information/list/'));
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

test('未確認（"unverified"）の項目は行ごと出さず、「無い」は出す（店主決定 2026-10-23）', () => {
  const page = (id) => site.htmlFiles.find((f) => f.file === join('s', id, 'index.html')).text;
  const svc = (id) => site.data.services.find((s) => s.id === id);
  // ANA: お知らせ・代わりの窓口・電話がすべて未確認 → その欄ごと出さない。公式トップ・公式ドメインは出す
  assert.ok(!page('ana').includes('id="notices"') && !page('ana').includes('id="alts"') && !page('ana').includes('電話の窓口'));
  assert.ok(hasLink(page('ana'), 'https://www.ana.co.jp/') && page('ana').includes('<code>ana.co.jp</code>'));
  // 三井住友: 電話番号は出し、未確認の受付時間は出さない
  assert.equal(svc('smbc').official_alternatives[0].hours, 'unverified');
  assert.ok(page('smbc').includes('<span class="phone">0120-324-310</span>') && !page('smbc').includes('受付時間'));
  // 運営会社名・公式 X が未確認なら、その行を出さない
  assert.equal(svc('jal').operator, 'unverified');
  assert.ok(!page('jal').includes('運営会社の正式な名称'));
  assert.ok(page('mufg').includes('運営会社の正式な名称: 株式会社三菱UFJ銀行'));
  assert.equal(svc('sagawa').official_x, 'unverified');
  assert.ok(!page('sagawa').includes('公式 X（'));
  // 開けなかったページ（verified: false）は出さない。公式トップだけは出す
  assert.ok(!hasLink(page('mizuho'), 'https://www.mizuhobank.co.jp/retail/products/direct/'));
  assert.ok(hasLink(page('mizuho'), 'https://www.mizuhobank.co.jp/'));
  // 「無い」と確かめたものは出す
  assert.match(page('sagawa'), /電話の窓口は無い（公式のページで確認）/);
  assert.match(page('amazon'), /まとめたお知らせのページは無い（当サイトの確認）/);
});

test('公開ページに「未確認」や、確認できなかったことを示す注記が出ない', () => {
  const unverifiedAll = buildInto((d) => {
    d.services.find((s) => s.id === 'jal').mostly_unverified = true;
    d.consultation[0].verified_at = 'unverified';
  });
  for (const { files, outDir } of [site, withIncidents, buildInto(), unverifiedAll]) {
    for (const f of files.filter((p) => /\.(html|xml|txt|json)$/.test(p))) {
      const text = readFileSync(f, 'utf8');
      assert.ok(!text.includes('未確認'), `${relative(outDir, f)} に「未確認」があります`);
      assert.ok(!text.includes('受付時間は公式ページで確かめてください'), relative(outDir, f));
      assert.ok(!text.includes('開けなかった'), `${relative(outDir, f)} に確認できなかったことを示す注記があります`);
      assert.ok(!text.includes('class="unverified"'), relative(outDir, f));
    }
  }
});

test('「大部分が未確認」のサービスのページは、公式トップへのリンクだけ', () => {
  const { htmlFiles } = buildInto((d) => { d.incidents = []; d.services.find((s) => s.id === 'jal').mostly_unverified = true; });
  const text = htmlFiles.find((f) => f.file === join('s', 'jal', 'index.html')).text;
  assert.match(text, /大部分を確かめていません/);
  assert.ok(!text.includes('空港') && !text.includes('0570-025-022'));
  const phishing = htmlFiles.find((f) => f.file === join('phishing', 'index.html')).text;
  assert.ok(!phishing.includes('<code>jal.co.jp</code>'), '大部分が未確認のサービスのドメインは載せない');
});

test('JAL・Amazon・楽天市場のページ（2026-10-23 の確認）', () => {
  const page = (id) => site.htmlFiles.find((f) => f.file === join('s', id, 'index.html')).text;
  assert.match(page('jal'), /<span class="phone">0570-025-022<\/span>/);
  assert.match(page('jal'), /<span class="handle">@JAL_flight_info<\/span>（運航情報）/);
  assert.ok(hasLink(page('amazon'), 'https://www.amazon.co.jp/gp/help/customer/display.html?nodeId=G4YFYCCNUSENA23B'), '詐欺の見分け方');
  assert.ok(hasLink(page('rakutenichiba'), 'https://www.rakuten.co.jp/aboutus/am/notice.html'));
  for (const id of ['jal', 'amazon', 'rakutenichiba']) assert.ok(!page(id).includes('大部分を確かめていません'), id);
});

test('いまのデータの障害の登録（佐川急便・コミックシーモア）を出す', () => {
  const real = buildInto();
  const top = real.htmlFiles.find((f) => f.file === 'index.html').text;
  assert.match(top, /<span class="badge">一部復旧（公式発表）<\/span> 佐川急便: /);
  assert.match(top, /<span class="badge">障害中（公式発表）<\/span> コミックシーモア: /);
  assert.match(top, /佐川急便<\/a> <span class="badge">一部復旧（公式発表）<\/span>/, '一覧のバッジも状態どおり');
  assert.match(top, /<dt>始まり<\/dt><dd>2026-09-30<\/dd>/, '時刻が公表されていなければ日付だけ');
  const cmoa = real.htmlFiles.find((f) => f.file === join('s', 'cmoa', 'index.html')).text;
  assert.ok(cmoa.includes('info@nttsolmare.com') && !cmoa.includes('mailto:'), 'メールアドレスは文字だけ');
  assert.ok(hasLink(cmoa, 'https://www.cmoa.jp/'), 'コミックシーモアの公式トップ');
});

test('公式の登録がある同じ件の報道の事例は、サービスのページに出さず「過去の事例」のページには残す', () => {
  const real = buildInto();
  const page = (file) => real.htmlFiles.find((f) => f.file === file).text;
  for (const id of ['sagawa', 'cmoa']) {
    const text = page(join('s', id, 'index.html'));
    assert.ok(!text.includes('報道で伝えられた事例'), `${id}: 報道の事例を出さない`);
    assert.match(text, /<span class="badge">/, `${id}: 公式の登録は出す`);
  }
  const past = page(join('past', 'index.html'));
  for (const name of real.data.past_cases.filter((pc) => pc.incident_id).map((pc) => pc.name)) assert.ok(past.includes(`<h3>${name}</h3>`), name);
  // 公式の登録が無ければ、サービスのページに報道の事例が戻る
  assert.ok(site.htmlFiles.find((f) => f.file === join('s', 'sagawa', 'index.html')).text.includes('報道で伝えられた事例'));
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
  for (const s of ['#9110', '188', 'フィッシング対策協議会']) assert.ok(text.includes(s), s);
  for (const u of ['https://www.npa.go.jp/bureau/safetylife/sos47/manga/dial/', 'https://www.caa.go.jp/policies/policy/local_cooperation/local_consumer_administration/hotline/', 'https://www.antiphishing.jp/']) {
    assert.ok(hasLink(text, u), u);
  }
  assert.ok(!text.includes('連絡先は当サイトでは未確認'));
});

test('sitemap.xml・robots.txt・404.html を出す', () => {
  const sitemap = readFileSync(join(site.outDir, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]));
  assert.equal(locs.length, site.htmlFiles.length - 1);
  assert.ok(locs.every((u) => u.origin === 'https://tomattara-navi.github.io' && u.pathname.startsWith('/tomattara-navi/')));
  assert.ok(locs.some((u) => u.href === 'https://tomattara-navi.github.io/tomattara-navi/s/mufg/'));
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
