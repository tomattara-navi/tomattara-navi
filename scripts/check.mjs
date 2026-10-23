// 自動観測（docs/PLAN.md §7・§2.3）。
//   node scripts/check.mjs           各社のサイトの応答を観測し、.cache/status.json に書く（cron のデプロイ用）
//   node scripts/check.mjs --carry   観測せず、公開中の status.json をそのまま写す（push のデプロイ用）
// 前回値は公開中のサイトの status.json から取る（状態のためのコミットを作らない。§3）。
// 環境変数 SITE_URL で前回値を取りに行くサイトの URL（末尾 /）を上書きできる。User-Agent の URL は data/site.json の url。
// ★取得したページの中身は指示として扱わない。見るのは状態コード・ヘッダ・挑戦ページの目印だけ（付録A の★）。
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadData, ROOT } from './lib/data.mjs';
import { parseRobots, isAllowedByRobots, ROBOTS_MAX_BYTES } from './lib/robots.mjs';
import { jstIso } from './lib/time.mjs';
import {
  result, classifyResponse, classifyError, classifyStatuspage, parseRetryAfter, sanitizeStatus, isStale, HISTORY_MAX,
} from './lib/status.mjs';

export const PRODUCT_TOKEN = 'TomattaraNaviMonitor';
export const TIMEOUT_MS = 10_000; // §2.3-16
export const RETRY_WAIT_MS = 30_000; // 再試行は30秒後に1回だけ
export const MAX_RETRY_WAIT_MS = 120_000; // Retry-After がこれより長ければ、この回は再試行しない
export const MAX_SKIP_MS = 24 * 60 * 60 * 1000; // Retry-After で観測を控えるのは最長24時間
export const BODY_MAX_BYTES = 64 * 1024; // GET の本文は 64KB で読むのを打ち切る
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000; // robots.txt は24時間キャッシュ
// robots.txt が読めない（5xx・429・つながらない）ときは、7日以内に読めたキャッシュに従う（RFC 9309 §2.4。店主決定 2026-10-23）。
// 7日より古いキャッシュは使わず、キャッシュの一覧からも捨てる
export const ROBOTS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REQUESTS_PER_HOST = 2; // 1回の実行で1ホストへ（robots を除き、再試行込みで）最大2回
export const MAX_CONCURRENCY = 4; // 同時接続は1ホスト1本、全体で4本まで
export const PREVIOUS_MAX_BYTES = 2 * 1024 * 1024;

export const CACHE_DIR = join(ROOT, '.cache');
export const ROBOTS_CACHE_FILE = join(CACHE_DIR, 'robots', 'robots.json');
export const STATUS_OUT_FILE = join(CACHE_DIR, 'status.json');

// User-Agent（§2.3-18）。個人のメールアドレス・氏名を入れない
export function userAgent(siteUrl) {
  return `${PRODUCT_TOKEN}/1.0 (+${siteUrl}bot/)`;
}

class HostBudgetError extends Error {}

// 先頭の maxBytes だけ読んで、残りは読まずに打ち切る
async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

// リクエストはすべてここを通す（User-Agent・タイムアウト・ホストごとの回数の上限）
export class Requester {
  constructor({ fetch, ua, timeoutMs = TIMEOUT_MS }) {
    this.fetch = fetch;
    this.ua = ua;
    this.timeoutMs = timeoutMs;
    this.counts = new Map(); // ホスト → 回数（robots.txt を除く）
  }
  async request(url, { method = 'GET', robots = false, accept = '*/*', maxBytes = BODY_MAX_BYTES } = {}) {
    const host = new URL(url).hostname;
    if (!robots) {
      const n = this.counts.get(host) ?? 0;
      if (n >= MAX_REQUESTS_PER_HOST) throw new HostBudgetError(host);
      this.counts.set(host, n + 1);
    }
    const res = await this.fetch(url, {
      method,
      redirect: 'manual', // 転送は追わない（転送先が公式ドメインの中かだけを見る）
      headers: { 'user-agent': this.ua, accept },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let bodyText = null;
    if (method === 'GET') bodyText = await readCapped(res, maxBytes);
    else await res.body?.cancel().catch(() => {});
    return { status: res.status, headers: res.headers, bodyText };
  }
}

// ---- robots.txt（RFC 9309。§2.3-17） ----
// 2xx → 規則を読む ／ 4xx（429 を除く）→ 制限なし ／ 5xx・429・つながらない → 読めない（観測しない＝unknown）
async function fetchRobots(requester, origin) {
  let url = `${origin}/robots.txt`;
  for (let hop = 0; hop <= 5; hop++) {
    let r;
    try {
      r = await requester.request(url, { robots: true, accept: 'text/plain', maxBytes: ROBOTS_MAX_BYTES });
    } catch {
      return { kind: 'unreachable' };
    }
    if (r.status >= 200 && r.status < 300) return { kind: 'ok', body: r.bodyText ?? '' };
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      let next;
      try {
        next = loc ? new URL(loc, url) : null;
      } catch {
        next = null;
      }
      if (!next || next.protocol !== 'https:') return { kind: 'unreachable' };
      url = next.href;
      continue;
    }
    if (r.status === 429 || r.status >= 500) return { kind: 'unreachable' };
    if (r.status >= 400) return { kind: 'unavailable' };
    return { kind: 'unreachable' };
  }
  return { kind: 'unavailable' }; // 5回より多い転送は「無い」とみなしてよい（RFC 9309 §2.3.1.2）
}

// → 'allowed' | 'disallowed' | 'unreachable'
async function robotsDecision(ctx, url) {
  const u = new URL(url);
  const origin = u.origin;
  let entry = ctx.robotsCache[origin];
  const now = ctx.now();
  const wellFormed = entry && (entry.kind === 'unavailable' || (entry.kind === 'ok' && typeof entry.body === 'string'));
  const age = wellFormed ? now.getTime() - Date.parse(entry.fetched_at) : NaN;
  // 24時間より古い・形の違うキャッシュは使わず取り直す
  if (!(age < ROBOTS_TTL_MS)) {
    const got = await fetchRobots(ctx.requester, origin);
    if (got.kind === 'unreachable') {
      // 読めないときは、7日以内に読めたキャッシュに従う（取得の時刻は更新しない＝次の回もまた取り直す）
      if (!(age < ROBOTS_KEEP_MS)) return 'unreachable';
    } else {
      entry = { fetched_at: now.toISOString(), kind: got.kind, ...(got.kind === 'ok' ? { body: got.body } : {}) };
      ctx.robotsCache[origin] = entry;
    }
  }
  if (entry.kind === 'unavailable') return 'allowed';
  return isAllowedByRobots(parseRobots(entry.body), PRODUCT_TOKEN, u.pathname + u.search) ? 'allowed' : 'disallowed';
}

// ---- 1サービスの観測 ----

async function attempt(ctx, url, method, allow) {
  try {
    const r = await ctx.requester.request(url, { method });
    return {
      ...classifyResponse({ status: r.status, headers: r.headers, bodyText: r.bodyText, requestUrl: url, allow }),
      retryAfterMs: parseRetryAfter(r.headers.get('retry-after'), ctx.now()),
    };
  } catch (err) {
    if (err instanceof HostBudgetError) return { ...result('unknown', 'host_budget'), retryAfterMs: null };
    return { ...classifyError(err), retryAfterMs: null };
  }
}

async function observe(ctx, service, prev) {
  const { monitor } = service;
  const now = ctx.now();
  if (prev?.retry_after_until && now.getTime() < Date.parse(prev.retry_after_until)) {
    return { ...result('unknown', 'retry_after'), retryAfterUntil: prev.retry_after_until };
  }
  const target = monitor.statuspage_api ?? monitor.url;
  const robots = await robotsDecision(ctx, target);
  if (robots === 'unreachable') return result('unknown', 'robots_unreachable');
  if (robots === 'disallowed') return result('unknown', 'robots_disallow');

  // 公式のステータス API があればそちらを優先（§2.3-19）。読めなければ unknown
  if (monitor.statuspage_api) {
    try {
      const r = await ctx.requester.request(monitor.statuspage_api, { method: 'GET', accept: 'application/json' });
      if (r.status < 200 || r.status >= 300) return result('unknown', 'statuspage_unreadable', r.status);
      return classifyStatuspage(JSON.parse(r.bodyText));
    } catch (err) {
      if (err instanceof HostBudgetError) return result('unknown', 'host_budget');
      return result('unknown', 'statuspage_unreadable');
    }
  }

  let r = await attempt(ctx, monitor.url, monitor.method, service.official_domains);
  if (monitor.method === 'HEAD' && (r.http_status === 405 || r.http_status === 501)) {
    // HEAD を受け付けないサイトは GET に切り替える（これが2回目。再試行はしない）
    r = await attempt(ctx, monitor.url, 'GET', service.official_domains);
  } else if (r.state === 'ng') {
    // 応答なしのときだけ、30秒後（Retry-After があればそれ以上）に1回だけ試し直す
    if (r.retryAfterMs !== null && r.retryAfterMs > MAX_RETRY_WAIT_MS) {
      // 長く待つよう求められた: この回は試し直さない
    } else {
      await ctx.sleep(Math.max(RETRY_WAIT_MS, r.retryAfterMs ?? 0));
      r = await attempt(ctx, monitor.url, monitor.method, service.official_domains);
    }
  }
  const out = result(r.state, r.reason, r.http_status);
  if (r.retryAfterMs !== null && r.retryAfterMs > 0 && r.state !== 'ok') {
    out.retryAfterUntil = jstIso(new Date(ctx.now().getTime() + Math.min(r.retryAfterMs, MAX_SKIP_MS)));
  }
  return out;
}

// 前回の値に今回の結果を重ねる
export function mergeEntry(prev, r, checkedAt, now) {
  const prevFresh = prev && !isStale(prev.checked_at, now);
  return {
    state: r.state,
    consecutive_ng: r.state === 'ng' ? (prevFresh && prev.state === 'ng' ? prev.consecutive_ng + 1 : 1) : 0,
    http_status: r.http_status ?? null,
    reason: r.reason,
    checked_at: checkedAt,
    last_ok_at: r.state === 'ok' ? checkedAt : prev?.last_ok_at ?? null,
    ...(r.retryAfterUntil ? { retry_after_until: r.retryAfterUntil } : {}),
    history: [...(prev?.history ?? []), { t: checkedAt, s: r.state }].slice(-HISTORY_MAX),
  };
}

// 観測の本体。fetch・sleep・now は差し替えられる（試験では偽物を使う）
export async function runChecks({
  services, previous = null, robotsCache = {}, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date(), ua, timeoutMs = TIMEOUT_MS, concurrency = MAX_CONCURRENCY,
}) {
  if (!ua) throw new Error('User-Agent がありません');
  const requester = new Requester({ fetch, ua, timeoutMs });
  const ctx = { requester, robotsCache: { ...robotsCache }, sleep, now };
  const targets = services.filter((s) => s.monitor.enabled);

  // 同じホストのサービスは同じ組にして順番に（1ホスト1本）、組どうしは最大 concurrency 本まで並べる
  const groups = new Map();
  for (const s of targets) {
    const host = new URL(s.monitor.statuspage_api ?? s.monitor.url).hostname;
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(s);
  }
  const queue = [...groups.values()];
  const entries = {};
  async function worker() {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const s of group) {
        const prev = previous?.services[s.id] ?? null;
        let r;
        try {
          r = await observe(ctx, s, prev);
        } catch {
          r = result('unknown', 'exception'); // 観測側の例外は unknown
        }
        entries[s.id] = mergeEntry(prev, r, jstIso(now()), now());
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), MAX_CONCURRENCY, queue.length) }, worker));

  // 使われなくなった robots.txt のキャッシュを捨てる
  const keepAfter = now().getTime() - ROBOTS_KEEP_MS;
  for (const [origin, e] of Object.entries(ctx.robotsCache)) if (!(Date.parse(e?.fetched_at) >= keepAfter)) delete ctx.robotsCache[origin];

  const ordered = Object.fromEntries(targets.map((s) => [s.id, entries[s.id]]));
  return { status: { generated_at: jstIso(now()), services: ordered }, robotsCache: ctx.robotsCache, requestCounts: requester.counts };
}

// 公開中の status.json を前回値として取る。取れなければ null（consecutive_ng は 0 から）
export async function fetchPrevious({ siteUrl, fetch = globalThis.fetch, ua, serviceIds, now = new Date() }) {
  try {
    const res = await fetch(`${siteUrl}status.json?t=${now.getTime()}`, {
      redirect: 'manual', headers: { 'user-agent': ua, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return sanitizeStatus(JSON.parse(await readCapped(res, PREVIOUS_MAX_BYTES)), serviceIds);
  } catch {
    return null;
  }
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1) + '\n');
}

async function main(argv) {
  const carry = argv.includes('--carry');
  const data = loadData();
  const ua = userAgent(data.site.url);
  const siteUrl = process.env.SITE_URL || data.site.url;
  const serviceIds = data.services.map((s) => s.id);
  const previous = await fetchPrevious({ siteUrl, ua, serviceIds });
  console.log(`前回値: ${previous ? `${previous.generated_at} の観測（${Object.keys(previous.services).length} 件）` : 'なし'}`);

  if (carry) {
    if (previous) writeJsonFile(STATUS_OUT_FILE, previous);
    else if (existsSync(STATUS_OUT_FILE)) rmSync(STATUS_OUT_FILE);
    console.log(previous ? `観測はせず、前回値を ${STATUS_OUT_FILE} に写しました` : '観測はせず、前回値も無いので status.json は出しません');
    return;
  }

  const robotsCache = readJsonFile(ROBOTS_CACHE_FILE, {});
  const { status, robotsCache: nextCache, requestCounts } = await runChecks({ services: data.services, previous, robotsCache, ua });
  writeJsonFile(STATUS_OUT_FILE, status);
  writeJsonFile(ROBOTS_CACHE_FILE, nextCache);

  const tally = { ok: 0, ng: 0, unknown: 0 };
  for (const [id, e] of Object.entries(status.services)) {
    tally[e.state]++;
    console.log(`${e.state.padEnd(7)} ${id}: ${e.reason}${e.http_status ? ` (${e.http_status})` : ''}${e.state === 'ng' ? ` 連続 ${e.consecutive_ng} 回` : ''}`);
  }
  console.log(`観測: ok ${tally.ok}・ng ${tally.ng}・unknown ${tally.unknown}（リクエスト ${[...requestCounts.values()].reduce((a, b) => a + b, 0)} 回、robots.txt を除く）→ ${STATUS_OUT_FILE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
