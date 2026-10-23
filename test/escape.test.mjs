import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, html, raw } from '../scripts/lib/escape.mjs';
import { parseHttpsUrl, isAllowedUrl, matchesAllowEntry, isValidAllowEntry, displayUrl } from '../scripts/lib/url.mjs';
import { Ctx } from '../scripts/lib/render.mjs';

test('escapeHtml は < > & " \' を無害化する', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('html`` は埋め込んだ値をエスケープし、SafeHtml と配列はそのまま入れる', () => {
  const name = '<img src=x onerror=alert(1)>';
  assert.equal(html`<p>${name}</p>`.toString(), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(html`<p>${html`<b>${'&'}</b>`}</p>`.toString(), '<p><b>&amp;</b></p>');
  assert.equal(html`<ul>${['<', '>'].map((x) => html`<li>${x}</li>`)}</ul>`.toString(), '<ul><li>&lt;</li><li>&gt;</li></ul>');
  assert.equal(html`${null}${undefined}${false}`.toString(), '');
  assert.equal(html`${raw('<br>')}`.toString(), '<br>');
});

test('parseHttpsUrl は https: 以外（javascript: 等）を拒む', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://www.bk.mufg.jp/',
    '//www.bk.mufg.jp/',
    'https://user:pass@www.bk.mufg.jp/',
    'https://www.bk.mufg.jp:8443/',
    ' https://www.bk.mufg.jp/',
    'https://www.bk.mufg.jp./',
    '',
    null,
  ]) {
    assert.equal(parseHttpsUrl(bad), null, String(bad));
  }
  assert.ok(parseHttpsUrl('https://www.bk.mufg.jp/'));
});

test('ドメインの一致: サブドメインは可、よく似た別のドメインは不可', () => {
  assert.ok(isAllowedUrl('https://www.bk.mufg.jp/', ['bk.mufg.jp']));
  assert.ok(isAllowedUrl('https://bk.mufg.jp/', ['bk.mufg.jp']));
  assert.ok(isAllowedUrl('https://direct.bk.mufg.jp/info_news/index.html', ['bk.mufg.jp']));
  assert.ok(!isAllowedUrl('https://evilbk.mufg.jp/', ['bk.mufg.jp']));
  assert.ok(!isAllowedUrl('https://bk.mufg.jp.example.com/', ['bk.mufg.jp']));
  assert.ok(!isAllowedUrl('https://example.com/?u=bk.mufg.jp', ['bk.mufg.jp']));
});

test('パスつきの許可は、そのホストのそのパスの下だけ', () => {
  const entry = 'secure.okbiz.jp/eki-net/';
  assert.ok(matchesAllowEntry('https://secure.okbiz.jp/eki-net/faq/show/3706', entry));
  assert.ok(matchesAllowEntry('https://secure.okbiz.jp/eki-net', entry));
  assert.ok(!matchesAllowEntry('https://secure.okbiz.jp/other/faq/', entry));
  assert.ok(!matchesAllowEntry('https://secure.okbiz.jp/eki-net-evil/', entry));
  assert.ok(!matchesAllowEntry('https://x.secure.okbiz.jp/eki-net/', entry));
  assert.ok(isValidAllowEntry(entry));
  assert.ok(isValidAllowEntry('bk.mufg.jp'));
  assert.ok(!isValidAllowEntry('https://bk.mufg.jp'));
  assert.ok(!isValidAllowEntry('BK.MUFG.JP'));
});

test('displayUrl はホスト名とパスだけを返す', () => {
  assert.equal(displayUrl('https://www.bk.mufg.jp/'), 'www.bk.mufg.jp');
  assert.equal(displayUrl('https://www.bk.mufg.jp/faq/index.html'), 'www.bk.mufg.jp/faq/index.html');
  assert.equal(displayUrl('javascript:alert(1)'), '');
});

test('外部リンクの部品は許可の一覧に無い URL で失敗する', () => {
  const ctx = new Ctx({ data: { site: {} }, allowlist: { entries: ['bk.mufg.jp'], pressUrls: new Set(['https://news.example.com/a']) }, root: '' });
  assert.match(ctx.ext('https://www.bk.mufg.jp/', '<公式>').toString(), /^<a href="https:\/\/www\.bk\.mufg\.jp\/">&lt;公式&gt;<\/a>/);
  assert.ok(ctx.ext('https://news.example.com/a', '記事'));
  assert.throws(() => ctx.ext('https://news.example.com/b', '記事'), /許可されていないリンク先/);
  assert.throws(() => ctx.ext('javascript:alert(1)', 'x'), /許可されていないリンク先/);
  assert.throws(() => ctx.ext('https://example.com/', 'x'), /許可されていないリンク先/);
});
