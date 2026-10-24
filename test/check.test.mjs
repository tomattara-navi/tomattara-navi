// 自動観測（scripts/check.mjs・docs/PLAN.md §7）の全分岐を、偽の fetch で確かめる（§8 フェーズ2 の受け入れ基準）。
// 本物のサイトへは1回もつながない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, fetchPrevious, userAgent, mergeEntry, PRODUCT_TOKEN, MAX_REQUESTS_PER_HOST, RETRY_WAIT_MS } from '../scripts/check.mjs';
import { loadData, ROOT } from '../scripts/lib/data.mjs';
import { parseRobots, isAllowedByRobots } from '../scripts/lib/robots.mjs';
import { classifyResponse, sanitizeStatus } from '../scripts/lib/status.mjs';

const SITE_URL = 'https://tomattara-navi.github.io/tomattara-navi/';
const UA = userAgent(SITE_URL);
const T0 = Date.parse('2026-10-23T01:07:00Z');

// ---- 偽の fetch ----
// routes: { 'https://host/path': handler | handler[] }。handler は (init) => Response、または例外を投げる。
// 配列なら呼ばれるたびに次の handler（最後のものを使い続ける）。robots.txt は既定で 404（制限なし）。
function fakeFetch(routes = {}) {
  const calls = [];
  const used = new Map();
  let inFlight = 0;
  const perHostInFlight = new Map();
  const stats = { maxInFlight: 0, maxPerHost: 0 };
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const host = u.hostname;
    calls.push({ url, method: init.method ?? 'GET', headers: { ...init.headers }, redirect: init.redirect, host, robots: u.pathname === '/robots.txt' });
    inFlight++;
    perHostInFlight.set(host, (perHostInFlight.get(host) ?? 0) + 1);
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    stats.maxPerHost = Math.max(stats.maxPerHost, perHostInFlight.get(host));
    try {
      await new Promise((r) => setTimeout(r, 2)); // 並びを確かめるため、少しだけ時間をかける
      let h = routes[url];
      if (h === undefined && u.pathname === '/robots.txt') h = () => new Response('not found', { status: 404 });
      if (h === undefined) throw new Error(`偽の fetch に無い URL: ${url}`);
      if (Array.isArray(h)) {
        const i = used.get(url) ?? 0;
        used.set(url, i + 1);
        h = h[Math.min(i, h.length - 1)];
      }
      return await h(init);
    } finally {
      inFlight--;
      perHostInFlight.set(host, perHostInFlight.get(host) - 1);
    }
  }
  return { fetch, calls, stats };
}

const res = (status, headers = {}, body = null) => () => new Response(body, { status, headers });
const throwsCode = (code) => () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
};

function svc(id, url, { method = 'HEAD', domains, statuspage = null, enabled = true } = {}) {
  return {
    id,
    official_domains: domains ?? [new URL(url).hostname.replace(/^www\./, '')],
    monitor: { url, method, enabled, statuspage_api: statuspage },
  };
}

function clock(start = T0) {
  let t = start;
  return {
    now: () => new Date(t),
    sleeps: [],
    sleep(ms) {
      this.sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance(ms) {
      t += ms;
    },
  };
}

async function run(services, routes, opts = {}) {
  const f = fakeFetch(routes);
  const c = opts.clock ?? clock();
  const out = await runChecks({ services, fetch: f.fetch, sleep: (ms) => c.sleep(ms), now: c.now, ua: UA, previous: opts.previous ?? null, robotsCache: opts.robotsCache ?? {}, timeoutMs: opts.timeoutMs });
  return { ...out, calls: f.calls, stats: f.stats, clock: c, nonRobots: f.calls.filter((x) => !x.robots) };
}

async function one(routes, s = svc('x', 'https://www.example.jp/'), opts) {
  const r = await run([s], routes, opts);
  return { ...r, e: r.status.services[s.id] };
}

// ---- 受け入れ基準: ok/ng/unknown の全分岐 ----

test('2xx → ok', async () => {
  const { e, nonRobots } = await one({ 'https://www.example.jp/': res(200) });
  assert.equal(e.state, 'ok');
  assert.equal(e.http_status, 200);
  assert.equal(nonRobots.length, 1);
  assert.equal(nonRobots[0].method, 'HEAD');
  assert.equal(nonRobots[0].redirect, 'manual', '転送は追わない');
});

test('3xx で転送先が公式ドメインの中 → ok（相対の Location も）', async () => {
  for (const loc of ['https://login.example.jp/top', '/ja/']) {
    const { e, nonRobots } = await one({ 'https://www.example.jp/': res(302, { location: loc }) });
    assert.equal(e.state, 'ok', loc);
    assert.equal(nonRobots.length, 1, '転送先へは行かない');
  }
});

test('公式ドメインの外への転送 → unknown（http: への転送も）', async () => {
  const hosts = { 'https://example-jp.evil.test/': 'example-jp.evil.test', 'https://example.jp.evil.test/': 'example.jp.evil.test', 'http://www.example.jp/': 'www.example.jp' };
  for (const [loc, host] of Object.entries(hosts)) {
    const { e } = await one({ 'https://www.example.jp/': res(301, { location: loc }) });
    assert.equal(e.state, 'unknown', loc);
    assert.equal(e.reason, 'redirect_offsite', loc);
    assert.equal(e.redirect_host, host, `${loc}: 転送先のホスト名を残す`);
  }
  const { e } = await one({ 'https://www.example.jp/': res(302) });
  assert.deepEqual([e.state, e.reason], ['unknown', 'redirect_without_location']);
});

test('redirect_offsite の転送先は、ホスト名だけを status.json に残す（パス・問い合わせ文字列は入れない）', async () => {
  const { e, status } = await one({ 'https://www.example.jp/': res(302, { location: 'https://Other.Example.NET:8443/path/to?q=secret#frag' }) });
  assert.equal(e.redirect_host, 'other.example.net');
  const json = JSON.stringify(status);
  for (const s of ['/path', 'q=secret', 'frag', '8443']) assert.ok(!json.includes(s), s);
  // 公式ドメインの中への転送や、転送でないときは残さない
  const inside = await one({ 'https://www.example.jp/': res(302, { location: '/ja/' }) });
  assert.ok(!('redirect_host' in inside.e));
  // 前回値・生成のときの読み取りでも、ホスト名の形のものを redirect_offsite のときだけ残す
  const base = { state: 'unknown', http_status: 302, checked_at: '2026-10-23T10:07:00+09:00', history: [] };
  const read = (e) => sanitizeStatus({ generated_at: '2026-10-23T10:07:00+09:00', services: { x: { ...base, ...e } } }).services.x;
  assert.equal(read({ reason: 'redirect_offsite', redirect_host: 'other.example.net' }).redirect_host, 'other.example.net');
  for (const bad of ['other.example.net/path', 'https://other.example.net', 'a b', '', 1]) {
    assert.ok(!('redirect_host' in read({ reason: 'redirect_offsite', redirect_host: bad })), String(bad));
  }
  assert.ok(!('redirect_host' in read({ reason: 'http_403', redirect_host: 'other.example.net' })));
});

test('403 → unknown（再試行しない）', async () => {
  const { e, nonRobots } = await one({ 'https://www.example.jp/': res(403) });
  assert.deepEqual([e.state, e.reason, e.http_status], ['unknown', 'http_403', 403]);
  assert.equal(nonRobots.length, 1);
});

test('429 → unknown、その他の 4xx → unknown', async () => {
  assert.deepEqual((await one({ 'https://www.example.jp/': res(429) })).e.reason, 'http_429');
  assert.equal((await one({ 'https://www.example.jp/': res(429) })).e.state, 'unknown');
  for (const st of [400, 404, 410, 451]) {
    const { e } = await one({ 'https://www.example.jp/': res(st) });
    assert.deepEqual([e.state, e.reason], ['unknown', 'http_4xx'], String(st));
  }
});

test('503 → ng（30秒後に1回だけ試し直して、それでも 5xx）', async () => {
  const { e, nonRobots, clock: c } = await one({ 'https://www.example.jp/': res(503) });
  assert.deepEqual([e.state, e.reason, e.http_status], ['ng', 'http_5xx', 503]);
  assert.equal(nonRobots.length, 2, '再試行込みで2回');
  assert.deepEqual(c.sleeps, [RETRY_WAIT_MS]);
  for (const st of [500, 502, 504, 520]) assert.equal((await one({ 'https://www.example.jp/': res(st) })).e.state, 'ng', String(st));
});

test('1回目が 503 でも、試し直しで 200 なら ok', async () => {
  const { e, nonRobots } = await one({ 'https://www.example.jp/': [res(503), res(200)] });
  assert.equal(e.state, 'ok');
  assert.equal(nonRobots.length, 2);
});

test('timeout → ng（10秒の打ち切りが実際に効く）', async () => {
  // signal が切れるまで応答しない偽物。timeoutMs を短くして、打ち切りの経路そのものを通す
  // （AbortSignal.timeout のタイマーはイベントループを保たないので、本物の接続の代わりにタイマーを1本持つ）
  const hang = (init) => new Promise((_, reject) => {
    const keep = setTimeout(() => reject(new Error('打ち切られなかった')), 5000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keep);
      reject(init.signal.reason);
    });
  });
  const { e, nonRobots } = await one({ 'https://www.example.jp/': hang }, undefined, { timeoutMs: 20 });
  assert.deepEqual([e.state, e.reason], ['ng', 'timeout']);
  assert.equal(nonRobots.length, 2);
  // fetch が投げる形の時間切れ（undici の接続の時間切れ）
  assert.deepEqual((await one({ 'https://www.example.jp/': throwsCode('UND_ERR_CONNECT_TIMEOUT') })).e.reason, 'timeout');
});

test('DNS 失敗・接続拒否・TLS 失敗 → ng', async () => {
  for (const [code, reason] of [['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ECONNREFUSED', 'refused'], ['CERT_HAS_EXPIRED', 'tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls']]) {
    const { e, nonRobots } = await one({ 'https://www.example.jp/': throwsCode(code) });
    assert.deepEqual([e.state, e.reason], ['ng', reason], code);
    assert.equal(nonRobots.length, 2, `${code}: 再試行は1回だけ`);
  }
});

test('ECONNRESET（接続を途中で切られた）→ unknown（データセンターからの接続を弾く WAF でも起きるため ng にしない）', async () => {
  const { e } = await one({ 'https://www.example.jp/': throwsCode('ECONNRESET') });
  assert.deepEqual([e.state, e.reason], ['unknown', 'exception']);
});

test('分類できない例外 → unknown（ok に倒さない）', async () => {
  for (const h of [throwsCode('ECONNRESET'), () => { throw new Error('何か'); }, () => ({ status: 'x' }), () => null]) {
    const { e } = await one({ 'https://www.example.jp/': h });
    assert.equal(e.state, 'unknown');
  }
});

test('挑戦ページ → unknown（Cloudflare の cf-mitigated・本文の目印。503 でも ng にしない）', async () => {
  for (const st of [403, 503, 200]) {
    const { e, nonRobots } = await one({ 'https://www.example.jp/': res(st, { 'cf-mitigated': 'challenge', server: 'cloudflare' }) });
    assert.deepEqual([e.state, e.reason], ['unknown', 'challenge'], String(st));
    assert.equal(nonRobots.length, 1, `${st}: 挑戦ページには試し直さない`);
  }
  const get = svc('x', 'https://www.example.jp/', { method: 'GET' });
  for (const body of ['<!DOCTYPE html><html><head><title>Just a moment...</title></head>', '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>', '<html>_Incapsula_Resource</html>']) {
    for (const st of [200, 503]) {
      const { e } = await one({ 'https://www.example.jp/': res(st, { 'content-type': 'text/html' }, body) }, get);
      assert.deepEqual([e.state, e.reason], ['unknown', 'challenge'], `${st} ${body}`);
    }
  }
  // 目印の無い普通のページは ok
  assert.equal((await one({ 'https://www.example.jp/': res(200, {}, '<html><title>トップ</title></html>') }, get)).e.state, 'ok');
});

test('HEAD が 405/501 なら GET に切り替える（本文は 64KB で読むのを打ち切る）', async () => {
  for (const st of [405, 501]) {
    let pulled = 0;
    const big = () => new Response(new ReadableStream({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new Uint8Array(16 * 1024).fill(0x61));
        if (pulled > 100) ctrl.close();
      },
    }), { status: 200 });
    const { e, nonRobots } = await one({ 'https://www.example.jp/': (init) => (init.method === 'HEAD' ? res(st)() : big()) });
    assert.equal(e.state, 'ok', String(st));
    assert.deepEqual(nonRobots.map((c) => c.method), ['HEAD', 'GET']);
    assert.ok(pulled <= 6, `本文を読みすぎない（${pulled} 回）`);
  }
  // GET でも 5xx なら ng。ただし3回目は送らない
  const { e, nonRobots } = await one({ 'https://www.example.jp/': (init) => (init.method === 'HEAD' ? res(405)() : res(503)()) });
  assert.equal(e.state, 'ng');
  assert.equal(nonRobots.length, 2);
});

test('robots.txt で断られている → unknown（観測先へは1回も送らない）', async () => {
  for (const body of [`User-agent: ${PRODUCT_TOKEN}\nDisallow: /`, 'User-agent: *\nDisallow: /', `user-agent: tomattaranavimonitor\ndisallow: /\n`]) {
    const { e, nonRobots, calls } = await one({ 'https://www.example.jp/robots.txt': res(200, {}, body), 'https://www.example.jp/': res(200) });
    assert.deepEqual([e.state, e.reason], ['unknown', 'robots_disallow'], body);
    assert.equal(nonRobots.length, 0);
    assert.equal(calls.length, 1);
  }
  // 全体は禁止でも、当サイトの名前の組で許していれば観測する（RFC 9309: 名前の合う組を使う）
  const { e } = await one({ 'https://www.example.jp/robots.txt': res(200, {}, `User-agent: *\nDisallow: /\n\nUser-agent: ${PRODUCT_TOKEN}\nAllow: /`), 'https://www.example.jp/': res(200) });
  assert.equal(e.state, 'ok');
});

test('robots.txt が 5xx・429・つながらない → unknown（観測しない）／ 404 → 制限なし', async () => {
  for (const h of [res(500), res(503), res(429), throwsCode('ENOTFOUND')]) {
    const { e, nonRobots } = await one({ 'https://www.example.jp/robots.txt': h, 'https://www.example.jp/': res(200) });
    assert.deepEqual([e.state, e.reason], ['unknown', 'robots_unreachable']);
    assert.equal(nonRobots.length, 0);
  }
  assert.equal((await one({ 'https://www.example.jp/robots.txt': res(404), 'https://www.example.jp/': res(200) })).e.state, 'ok');
});

test('robots.txt は24時間キャッシュする（その間は取り直さない）', async () => {
  const routes = { 'https://www.example.jp/robots.txt': res(200, {}, 'User-agent: *\nDisallow: /private/'), 'https://www.example.jp/': res(200) };
  const first = await one(routes);
  assert.equal(first.calls.filter((c) => c.robots).length, 1);
  const c = clock(T0 + 23 * 3600 * 1000);
  const second = await one(routes, undefined, { robotsCache: first.robotsCache, clock: c });
  assert.equal(second.calls.filter((x) => x.robots).length, 0, '24時間以内は取り直さない');
  const third = await one(routes, undefined, { robotsCache: first.robotsCache, clock: clock(T0 + 24 * 3600 * 1000) });
  assert.equal(third.calls.filter((x) => x.robots).length, 1, '24時間たったら取り直す');
});

test('robots.txt が 5xx・429・つながらないとき、7日以内のキャッシュがあればそれに従って観測を続ける（RFC 9309 §2.4）', async () => {
  const DAY = 24 * 3600 * 1000;
  const cacheAt = (ms, body) => ({ 'https://www.example.jp': { fetched_at: new Date(T0 - ms).toISOString(), kind: 'ok', body } });
  for (const robots of [res(500), res(503), res(429), throwsCode('ENOTFOUND'), throwsCode('ECONNREFUSED')]) {
    // 3日前のキャッシュ（制限なし）→ 観測を続ける。サイトも落ちていれば ng になる
    const down = await one({ 'https://www.example.jp/robots.txt': robots, 'https://www.example.jp/': res(503) }, undefined, { robotsCache: cacheAt(3 * DAY, 'User-agent: *\nDisallow: /private/') });
    assert.deepEqual([down.e.state, down.e.reason], ['ng', 'http_5xx']);
    assert.equal(down.calls.filter((c) => c.robots).length, 1, '取り直しは試みる');
    assert.equal(down.nonRobots.length, 2, 'リクエストの上限（robots を除き2回）は変わらない');
    assert.equal(down.robotsCache['https://www.example.jp'].fetched_at, new Date(T0 - 3 * DAY).toISOString(), '取得の時刻は更新しない');
    // 古いキャッシュの禁止にも従う
    const disallow = await one({ 'https://www.example.jp/robots.txt': robots, 'https://www.example.jp/': res(200) }, undefined, { robotsCache: cacheAt(3 * DAY, 'User-agent: *\nDisallow: /') });
    assert.deepEqual([disallow.e.state, disallow.e.reason], ['unknown', 'robots_disallow']);
    assert.equal(disallow.nonRobots.length, 0);
    // 7日ちょうど・8日前のキャッシュ → 使わずに unknown（観測しない）
    for (const age of [7 * DAY, 8 * DAY]) {
      const old = await one({ 'https://www.example.jp/robots.txt': robots, 'https://www.example.jp/': res(200) }, undefined, { robotsCache: cacheAt(age, '') });
      assert.deepEqual([old.e.state, old.e.reason], ['unknown', 'robots_unreachable'], `${age / DAY}日前`);
      assert.equal(old.nonRobots.length, 0);
    }
  }
  // 「robots.txt が無い（404）」と分かったキャッシュも7日以内なら使う
  const unavailable = await one({ 'https://www.example.jp/robots.txt': res(503), 'https://www.example.jp/': res(200) }, undefined, { robotsCache: { 'https://www.example.jp': { fetched_at: new Date(T0 - 6 * DAY).toISOString(), kind: 'unavailable' } } });
  assert.equal(unavailable.e.state, 'ok');
  // 形の壊れたキャッシュは、読めないときにも使わない
  const broken = await one({ 'https://www.example.jp/robots.txt': res(503), 'https://www.example.jp/': res(200) }, undefined, { robotsCache: { 'https://www.example.jp': { fetched_at: new Date(T0 - DAY * 2).toISOString(), kind: 'ok' } } });
  assert.equal(broken.e.reason, 'robots_unreachable');
});

test('robots.txt のキャッシュが壊れていれば取り直す', async () => {
  const routes = { 'https://www.example.jp/robots.txt': res(200, {}, 'User-agent: *\nDisallow: /'), 'https://www.example.jp/': res(200) };
  for (const bad of [{ fetched_at: 'x', kind: 'unavailable' }, { fetched_at: new Date(T0).toISOString(), kind: 'ok' }, { fetched_at: new Date(T0).toISOString(), kind: 'allow-all' }]) {
    const r = await one(routes, undefined, { robotsCache: { 'https://www.example.jp': bad } });
    assert.equal(r.calls.filter((c) => c.robots).length, 1, JSON.stringify(bad));
    assert.equal(r.e.reason, 'robots_disallow');
  }
});

test('robots.txt の規則の読み方（RFC 9309）', () => {
  const g = parseRobots('# c\nUser-agent: a\nUser-agent: *\nDisallow: /x\nAllow: /x/ok\nDisallow: /*.pdf$\nDisallow:\n');
  assert.equal(isAllowedByRobots(g, PRODUCT_TOKEN, '/'), true);
  assert.equal(isAllowedByRobots(g, PRODUCT_TOKEN, '/x/y'), false);
  assert.equal(isAllowedByRobots(g, PRODUCT_TOKEN, '/x/ok/1'), true, '長く一致した方が勝つ');
  assert.equal(isAllowedByRobots(g, PRODUCT_TOKEN, '/a/b.pdf'), false);
  assert.equal(isAllowedByRobots(g, PRODUCT_TOKEN, '/a/b.pdf?x'), true, '$ は末尾');
  assert.equal(isAllowedByRobots(parseRobots('User-agent: *\nDisallow: /p\nAllow: /p'), PRODUCT_TOKEN, '/p'), true, '同じ長さなら allow');
  assert.equal(isAllowedByRobots(parseRobots('User-agent: other\nDisallow: /'), PRODUCT_TOKEN, '/'), true, '合う組が無ければ制限なし');
  assert.equal(isAllowedByRobots(parseRobots('User-agent: *\nDisallow: /'), PRODUCT_TOKEN, '/robots.txt'), true);
});

test('Retry-After に従う（短ければその分待ち、長ければ試し直さず、その間の観測を控える）', async () => {
  const a = await one({ 'https://www.example.jp/': [res(503, { 'retry-after': '60' }), res(200)] });
  assert.deepEqual(a.clock.sleeps, [60_000]);
  assert.equal(a.e.state, 'ok');

  const b = await one({ 'https://www.example.jp/': res(503, { 'retry-after': '3600' }) });
  assert.equal(b.nonRobots.length, 1, '長く待つよう求められたら、この回は試し直さない');
  assert.ok(b.e.retry_after_until);
  // 次の回（30分後）は観測を控える: リクエスト 0 回・unknown
  const c = clock(T0 + 30 * 60 * 1000);
  const next = await one({ 'https://www.example.jp/': res(200) }, undefined, { previous: b.status, clock: c });
  assert.deepEqual([next.e.state, next.e.reason], ['unknown', 'retry_after']);
  assert.equal(next.calls.length, 0);
  // 期限を過ぎたら観測に戻る
  const later = await one({ 'https://www.example.jp/': res(200) }, undefined, { previous: next.status, clock: clock(T0 + 61 * 60 * 1000) });
  assert.equal(later.e.state, 'ok');

  const r429 = await one({ 'https://www.example.jp/': res(429, { 'retry-after': '7200' }) });
  assert.equal(r429.nonRobots.length, 1);
  assert.ok(r429.e.retry_after_until);
});

test('公式のステータス API があればそちらを読む（none → ok、それ以外 → ng、読めない → unknown）', async () => {
  const s = svc('x', 'https://www.example.jp/', { statuspage: 'https://status.example.jp/api/v2/status.json', domains: ['example.jp'] });
  const api = (body, st = 200) => ({ 'https://status.example.jp/api/v2/status.json': res(st, { 'content-type': 'application/json' }, body) });
  const r1 = await one(api(JSON.stringify({ status: { indicator: 'none' } })), s);
  assert.equal(r1.e.state, 'ok');
  assert.ok(!r1.calls.some((c) => c.url === 'https://www.example.jp/'), 'トップへは送らない');
  for (const ind of ['minor', 'major', 'critical']) assert.deepEqual([(await one(api(JSON.stringify({ status: { indicator: ind } })), s)).e.state], ['ng'], ind);
  for (const [body, st] of [['{', 200], ['{"status":{}}', 200], ['{}', 503], ['<html>', 200]]) {
    assert.equal((await one(api(body, st), s)).e.state, 'unknown', `${st} ${body}`);
  }
});

// ---- 受け入れ基準: 各ホストへのリクエストは robots を除き最大2回 ----

test('1回の実行で、各ホストへのリクエストは robots.txt を除き最大2回（再試行・GET への切り替え込み）', async () => {
  const hosts = {
    'a.example.jp': res(200), 'b.example.jp': res(503), 'c.example.jp': throwsCode('ENOTFOUND'), 'd.example.jp': res(403),
    'e.example.jp': (init) => (init.method === 'HEAD' ? res(405)() : res(503)()), 'f.example.jp': [res(503), res(200)],
    'g.example.jp': res(302, { location: 'https://evil.test/' }), 'h.example.jp': res(503, { 'retry-after': '5' }),
  };
  const routes = {};
  const services = [];
  for (const [host, h] of Object.entries(hosts)) {
    routes[`https://${host}/`] = h;
    services.push(svc(host[0], `https://${host}/`, { domains: ['example.jp'] }));
  }
  // 同じホストの2つめのサービス（b と同じホスト）は、上限に達していれば送らずに unknown
  routes['https://b.example.jp/other/'] = res(200);
  services.push(svc('b2', 'https://b.example.jp/other/', { domains: ['example.jp'] }));
  const { status, nonRobots, requestCounts } = await run(services, routes);
  const byHost = {};
  for (const c of nonRobots) byHost[c.host] = (byHost[c.host] ?? 0) + 1;
  for (const [host, n] of Object.entries(byHost)) assert.ok(n <= MAX_REQUESTS_PER_HOST, `${host}: ${n} 回`);
  assert.equal(MAX_REQUESTS_PER_HOST, 2);
  assert.equal(byHost['b.example.jp'], 2);
  assert.deepEqual([status.services.b2.state, status.services.b2.reason], ['unknown', 'host_budget']);
  assert.deepEqual(Object.fromEntries(requestCounts), byHost, '数え方が偽の fetch の記録と合う');
});

test('同時接続は1ホスト1本、全体で4本まで', async () => {
  const routes = {};
  const services = [];
  for (let i = 0; i < 12; i++) {
    routes[`https://h${i}.example.jp/`] = res(200);
    services.push(svc(`s${i}`, `https://h${i}.example.jp/`, { domains: ['example.jp'] }));
    routes[`https://h${i}.example.jp/sub/`] = res(200);
    services.push(svc(`t${i}`, `https://h${i}.example.jp/sub/`, { domains: ['example.jp'] }));
  }
  const { stats, status } = await run(services, routes);
  assert.ok(stats.maxInFlight <= 4 && stats.maxInFlight >= 2, `全体 ${stats.maxInFlight} 本`);
  assert.equal(stats.maxPerHost, 1);
  assert.equal(Object.keys(status.services).length, 24);
});

test('monitor.enabled が false のサービスは観測しない', async () => {
  const { status, calls } = await run([svc('x', 'https://www.example.jp/', { enabled: false })], {});
  assert.deepEqual(status.services, {});
  assert.equal(calls.length, 0);
});

// ---- 前回値と連続回数 ----

test('consecutive_ng: ng が続くと数え、ok・unknown で 0 に戻る。前回が4時間以上古ければ 1 から', () => {
  const now = new Date(T0);
  const at = (ms) => new Date(T0 - ms).toISOString();
  const ng = { state: 'ng', reason: 'http_5xx', http_status: 503 };
  const e1 = mergeEntry(null, ng, now.toISOString(), now);
  assert.equal(e1.consecutive_ng, 1);
  const prev = { ...e1, checked_at: at(30 * 60 * 1000) };
  assert.equal(mergeEntry(prev, ng, now.toISOString(), now).consecutive_ng, 2);
  assert.equal(mergeEntry({ ...prev, checked_at: at(3 * 3600 * 1000) }, ng, now.toISOString(), now).consecutive_ng, 2, '3時間前（いまの実際の間隔）は続きとみなす');
  assert.equal(mergeEntry({ ...prev, checked_at: at(4 * 3600 * 1000) }, ng, now.toISOString(), now).consecutive_ng, 1);
  assert.equal(mergeEntry(prev, { state: 'unknown', reason: 'http_403' }, now.toISOString(), now).consecutive_ng, 0);
  const ok = mergeEntry(prev, { state: 'ok', reason: 'http_2xx', http_status: 200 }, now.toISOString(), now);
  assert.equal(ok.consecutive_ng, 0);
  assert.equal(ok.last_ok_at, now.toISOString());
  const long = { ...prev, history: Array.from({ length: 48 }, (_, i) => ({ t: at((49 - i) * 1800 * 1000), s: 'ok' })) };
  assert.equal(mergeEntry(long, ng, now.toISOString(), now).history.length, 48, '直近48件だけ');
});

test('2回の実行で ng が続くと consecutive_ng が 2 になる（前回値は status.json から）', async () => {
  const first = await one({ 'https://www.example.jp/': res(503) });
  const second = await one({ 'https://www.example.jp/': res(503) }, undefined, { previous: first.status, clock: clock(T0 + 30 * 60 * 1000) });
  assert.equal(second.e.consecutive_ng, 2);
  assert.equal(second.e.history.length, 2);
});

test('前回値（公開中の status.json）が取れなければ null', async () => {
  const ids = ['x'];
  const prevUrl = (h) => async (url, init) => {
    assert.ok(url.startsWith(`${SITE_URL}status.json?t=`));
    assert.equal(init.headers['user-agent'], UA);
    return h();
  };
  assert.equal(await fetchPrevious({ siteUrl: SITE_URL, ua: UA, serviceIds: ids, fetch: prevUrl(res(404)) }), null);
  assert.equal(await fetchPrevious({ siteUrl: SITE_URL, ua: UA, serviceIds: ids, fetch: prevUrl(res(200, {}, '{broken')) }), null);
  assert.equal(await fetchPrevious({ siteUrl: SITE_URL, ua: UA, serviceIds: ids, fetch: prevUrl(throwsCode('ENOTFOUND')) }), null);
  const good = { generated_at: '2026-10-23T10:07:00+09:00', services: { x: { state: 'ng', consecutive_ng: 1, http_status: 503, reason: 'http_5xx', checked_at: '2026-10-23T10:07:00+09:00', last_ok_at: null, history: [{ t: '2026-10-23T10:07:00+09:00', s: 'ng' }] }, gone: { state: 'ok', checked_at: '2026-10-23T10:07:00+09:00' }, bad: { state: 'yes' } } };
  const got = await fetchPrevious({ siteUrl: SITE_URL, ua: UA, serviceIds: ['x', 'bad'], fetch: prevUrl(res(200, {}, JSON.stringify(good))) });
  assert.deepEqual(Object.keys(got.services), ['x'], '知らない id と形の違うものは捨てる');
  assert.equal(got.services.x.consecutive_ng, 1);
});

// ---- 受け入れ基準: User-Agent に個人情報が無い ----

test('User-Agent は決めた形で、個人情報（@）を含まない。すべてのリクエストに付く', async () => {
  const data = loadData();
  const ua = userAgent(data.site.url);
  assert.equal(ua, 'TomattaraNaviMonitor/1.0 (+https://tomattara-navi.github.io/tomattara-navi/bot/)');
  assert.ok(!ua.includes('@'));
  assert.match(ua, /^[\x20-\x7e]+$/, '半角の文字だけ');
  const { calls } = await one({ 'https://www.example.jp/': res(503), 'https://www.example.jp/robots.txt': res(200, {}, '') });
  assert.ok(calls.length >= 3);
  for (const c of calls) {
    assert.equal(c.headers['user-agent'], UA);
    for (const [k, v] of Object.entries(c.headers)) assert.ok(!String(v).includes('@'), `${k}: ${v}`);
    assert.ok(!('cookie' in c.headers) && !('from' in c.headers));
  }
  // bot のページに載せている User-Agent と同じ
  assert.ok(readFileSync(join(ROOT, 'content', 'bot.html'), 'utf8').includes('<code>TomattaraNaviMonitor/1.0 (+{{site_url}}bot/)</code>'));
});

test('scripts/ に個人のメールアドレスの形の文字列が無い', () => {
  for (const f of ['check.mjs', 'lib/status.mjs', 'lib/robots.mjs']) {
    const text = readFileSync(join(ROOT, 'scripts', f), 'utf8');
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), f);
  }
});

test('いまのデータの観測先はすべて https: で公式ドメインの中（判定の関数で確かめる）', () => {
  const data = loadData();
  const enabled = data.services.filter((s) => s.monitor.enabled);
  assert.ok(enabled.length >= 20);
  for (const s of enabled) {
    const r = classifyResponse({ status: 301, headers: new Headers({ location: s.monitor.url }), requestUrl: s.monitor.url, allow: s.official_domains });
    assert.equal(r.state, 'ok', `${s.id}: ${s.monitor.url}`);
  }
});
