// 画面の「当サイトからの観測」欄（docs/PLAN.md §2.2-10〜13・§7・§8 フェーズ2）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../scripts/build.mjs';
import { loadData } from '../scripts/lib/data.mjs';
import { jstIso } from '../scripts/lib/time.mjs';
import { observationView } from '../scripts/lib/status.mjs';
import { OBS_TEXT } from '../scripts/lib/render.mjs';

const NOW = new Date('2026-10-23T07:00:00Z');
const MIN = 60 * 1000;
const NG_TEXT = '当サイトからの観測: 応答がありませんでした（公式発表ではありません）';

// 有効なサービスすべてに、checkedAt の時点の観測の結果を入れる（既定は ok。overrides で個別に変える）
function makeStatus(data, { checkedAt = NOW, overrides = {}, historyLen = 48 } = {}) {
  const services = {};
  for (const s of data.services.filter((x) => x.monitor.enabled)) {
    const o = { state: 'ok', consecutive_ng: 0, reason: 'http_2xx', http_status: 200, ...overrides[s.id] };
    const history = Array.from({ length: historyLen }, (_, i) => ({ t: jstIso(new Date(checkedAt.getTime() - (historyLen - 1 - i) * 30 * MIN)), s: 'ok' }));
    if (o.history) history.splice(history.length - o.history.length, o.history.length, ...o.history.map((st, i) => ({ ...history[history.length - o.history.length + i], s: st })));
    services[s.id] = { ...o, checked_at: jstIso(checkedAt), last_ok_at: jstIso(new Date(checkedAt.getTime() - 60 * MIN)), history };
  }
  return { generated_at: jstIso(checkedAt), services };
}

function buildWith(status, { now = NOW } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'tomattara-obs-'));
  const data = loadData();
  data.incidents = [];
  build({ outDir, now, data, status, siteUrl: 'https://tomattara-navi.github.io/tomattara-navi/' });
  const page = (p) => readFileSync(join(outDir, p, 'index.html'), 'utf8');
  return { outDir, page, data };
}

const data = loadData();

test('ok: 「応答がありました」と最終観測の時刻（日本時間）を出す', () => {
  const { page } = buildWith(makeStatus(data));
  const text = page('s/mufg');
  assert.ok(text.includes('<h2 id="obs">当サイトからの観測</h2>'));
  assert.ok(text.includes(OBS_TEXT.ok));
  assert.ok(text.includes('最終観測: 2026-10-23 16:00（日本時間）'));
  assert.ok(!text.includes(NG_TEXT));
});

test('ng は2回続けたときだけ「応答がありませんでした（公式発表ではありません）」。1回だけなら保留', () => {
  const one = buildWith(makeStatus(data, { overrides: { mufg: { state: 'ng', consecutive_ng: 1, reason: 'http_5xx', http_status: 503, history: ['ng'] } } }));
  const t1 = one.page('s/mufg');
  assert.ok(!t1.includes(NG_TEXT), '1回だけでは出さない');
  assert.ok(t1.includes(OBS_TEXT.retrying));
  assert.ok(!t1.includes(OBS_TEXT.ok), '保留を ok と出さない');
  assert.ok(!one.page('').includes('obs-mark'), 'トップの一覧にも出さない');
  assert.ok(t1.includes('<li class="b-retrying">'), '帯でも1回だけの ng は「保留」');
  assert.ok(!t1.includes('<li class="b-ng">'));

  const two = buildWith(makeStatus(data, { overrides: { mufg: { state: 'ng', consecutive_ng: 2, reason: 'http_5xx', http_status: 503, history: ['ng', 'ng'] } } }));
  const t2 = two.page('s/mufg');
  assert.ok(t2.includes(NG_TEXT));
  assert.ok(t2.includes('最後に応答があった観測: '));
  assert.equal(t2.split('<li class="b-ng">').length - 1, 2, '帯の2つが「応答なし」');
  const top = two.page('');
  assert.match(top, /三菱UFJ銀行<\/a> <span class="obs-mark">当サイトからの観測: 応答なし<\/span>/);
  assert.ok(top.includes('2回続けて応答が無かったもの（公式発表ではありません）'));
  assert.ok(!t2.includes('障害中'), '観測だけで「障害」と書かない');
  assert.ok(!top.includes('<span class="badge">'), '公式発表のバッジは出さない');
});

test('unknown: 「判定できませんでした」と理由。ok にも ng にも寄せない', () => {
  const { page } = buildWith(makeStatus(data, { overrides: { mufg: { state: 'unknown', reason: 'http_403', http_status: 403, history: ['unknown'] } } }));
  const text = page('s/mufg');
  assert.ok(text.includes(`${OBS_TEXT.unknown}（アクセスが制限されていました（403））`));
  assert.ok(!text.includes(OBS_TEXT.ok) && !text.includes(NG_TEXT));
  assert.ok(text.includes('<li class="b-unknown">'));
});

test('観測が2時間以上古いと「観測が止まっています」になり、古い ok を出さない', () => {
  // ちょうど2時間前 → 止まっている
  const stale = buildWith(makeStatus(data, { checkedAt: new Date(NOW.getTime() - 120 * MIN) }));
  for (const p of ['s/mufg', 's/smbc', '']) {
    const text = stale.page(p);
    assert.ok(text.includes(OBS_TEXT.stale), p);
    assert.ok(!text.includes(OBS_TEXT.ok), `${p}: 古い ok を出さない`);
    assert.ok(!text.includes('class="band"'), `${p}: 帯も出さない`);
  }
  assert.ok(stale.page('s/mufg').includes('最後の観測（2026-10-23 14:00（日本時間））'));
  // 古い ng も出さない
  const staleNg = buildWith(makeStatus(data, { checkedAt: new Date(NOW.getTime() - 3 * 60 * MIN), overrides: { mufg: { state: 'ng', consecutive_ng: 3, history: ['ng', 'ng', 'ng'] } } }));
  assert.ok(!staleNg.page('s/mufg').includes(NG_TEXT));
  // 1時間59分前 → まだ止まっていない
  const fresh = buildWith(makeStatus(data, { checkedAt: new Date(NOW.getTime() - 119 * MIN) }));
  assert.ok(!fresh.page('s/mufg').includes(OBS_TEXT.stale));
  assert.ok(fresh.page('s/mufg').includes(OBS_TEXT.ok));
});

test('観測が全滅（すべて unknown/ng）なら「観測側の不調の可能性」を出し、各社の障害と言わない', () => {
  const overrides = {};
  for (const s of data.services.filter((x) => x.monitor.enabled)) overrides[s.id] = { state: s.id === 'mufg' ? 'unknown' : 'ng', consecutive_ng: 2, reason: 'timeout', http_status: null, history: ['ng', 'ng'] };
  const { page } = buildWith(makeStatus(data, { overrides }));
  for (const p of ['', 's/mufg', 's/smbc', 's/docomo']) {
    const text = page(p);
    assert.ok(text.includes(OBS_TEXT.observer_failure), p);
    assert.ok(!text.includes(NG_TEXT), `${p}: 「応答がありませんでした」を出さない`);
    assert.ok(!text.includes('obs-mark'), p);
  }
});

test('観測の結果が無い・観測していないサービスは、そのように出す', () => {
  const none = buildWith(null);
  assert.ok(none.page('s/mufg').includes(OBS_TEXT.none));
  assert.ok(!none.page('').includes('id="observed"'), 'トップの観測の欄は出さない');
  assert.ok(!existsSync(join(none.outDir, 'status.json')), '結果が無ければ status.json を置かない');
  const withStatus = buildWith(makeStatus(data));
  const disabled = data.services.find((s) => !s.monitor.enabled);
  assert.ok(withStatus.page(`s/${disabled.id}`).includes(OBS_TEXT.disabled));
});

test('dist/status.json を置く（次の観測の前回値）。壊れた結果は捨てる', () => {
  const status = makeStatus(data);
  status.services.nosuch = status.services.mufg;
  status.services.mufg = { ...status.services.mufg, state: 'maybe' };
  const { outDir } = buildWith(status);
  const out = JSON.parse(readFileSync(join(outDir, 'status.json'), 'utf8'));
  assert.equal(out.generated_at, status.generated_at);
  assert.ok(!('nosuch' in out.services) && !('mufg' in out.services));
  assert.equal(out.services.smbc.state, 'ok');
  // sitemap の URL は new URL() で取り出してパスで比べる
  const locs = [...readFileSync(join(outDir, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]));
  assert.ok(locs.length > 0 && !locs.some((u) => u.pathname.endsWith('/status.json')));
});

test('帯は直近24時間・最大48件。24時間より古いものは出さない', () => {
  const st = makeStatus(data, { historyLen: 48 });
  st.services.mufg.history = [{ t: jstIso(new Date(NOW.getTime() - 25 * 60 * MIN)), s: 'ng' }, ...st.services.mufg.history.slice(1)];
  const { page } = buildWith(st);
  const text = page('s/mufg');
  const cells = text.match(/<li class="b-[a-z]+">/g);
  assert.equal(cells.length, 47);
  assert.ok(text.includes('直近24時間の観測（47回: 応答あり 47回）'));
});

test('観測の欄があっても1ページ 60KB 以下（48件の帯・CSS 込み）', () => {
  const { outDir, page } = buildWith(makeStatus(data));
  const extra = statSync(join(outDir, 'assets', 'site.css')).size + statSync(join(outDir, 'assets', 'favicon.svg')).size;
  for (const s of data.services) {
    const bytes = Buffer.byteLength(page(`s/${s.id}`)) + extra;
    assert.ok(bytes <= 60 * 1024, `${s.id}: ${bytes}`);
  }
});

test('bot のページに観測しているページの一覧を出す', () => {
  const { page } = buildWith(null);
  const text = page('bot');
  for (const s of data.services.filter((x) => x.monitor.enabled)) assert.ok(text.includes(`<code>${s.monitor.url}</code>`), s.id);
  assert.ok(text.includes('いまは観測していないサービス'));
  assert.ok(!text.includes('いまは、各社のサイトへの自動のアクセス（観測）はしていません'));
  assert.ok(text.includes('<code>TomattaraNaviMonitor/1.0 (+https://tomattara-navi.github.io/tomattara-navi/bot/)</code>'));
});

test('observationView の判断（表の形で）', () => {
  const s = { id: 'x', monitor: { enabled: true } };
  const st = (e, gen = NOW) => ({ generated_at: jstIso(gen), services: { x: { history: [], ...e }, y: { state: 'ok', checked_at: jstIso(gen), history: [] } } });
  const at = jstIso(NOW);
  assert.equal(observationView({ ...s, monitor: { enabled: false } }, null, NOW).kind, 'disabled');
  assert.equal(observationView(s, null, NOW).kind, 'none');
  assert.equal(observationView(s, st({ state: 'ok', checked_at: at }), NOW).kind, 'ok');
  assert.equal(observationView(s, st({ state: 'ng', consecutive_ng: 1, checked_at: at }), NOW).kind, 'retrying');
  assert.equal(observationView(s, st({ state: 'ng', consecutive_ng: 2, checked_at: at }), NOW).kind, 'ng');
  assert.equal(observationView(s, st({ state: 'unknown', checked_at: at }), NOW).kind, 'unknown');
  assert.equal(observationView(s, st({ state: 'ok', checked_at: jstIso(new Date(NOW - 2 * 60 * MIN)) }), NOW).kind, 'stale');
});
