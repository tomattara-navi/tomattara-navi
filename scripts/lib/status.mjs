// 自動観測の判定と、観測の結果（status.json）の扱い（§5.3・§7・§2.2）。
// 判定は三状態: ok（応答あり）／ng（応答なし）／unknown（判定できない）。
// ★分類できないものはすべて unknown（ok にも ng にも寄せない）。
import { isAllowedUrl, parseHttpsUrl } from './url.mjs';
import { isValidDateTime } from './time.mjs';

export const STATES = ['ok', 'ng', 'unknown'];
export const HISTORY_MAX = 48; // 直近48件（30分ごとで24時間分）
export const STALE_MS = 2 * 60 * 60 * 1000; // 観測が2時間以上古ければ「観測が止まっています」
export const NG_DISPLAY_MIN = 2; // 2回続けて ng のときだけ「応答がありませんでした」

export function result(state, reason, httpStatus = null) {
  return { state, reason, http_status: httpStatus };
}

// ---- 挑戦ページ（WAF・ボット対策の確認画面）の目印 ----
// 見るのは目印の有無だけ。本文の意味は解釈しない。
const CHALLENGE_BODY_MARKERS = [
  '<title>just a moment...</title>', // Cloudflare
  'cf-chl-', // Cloudflare の挑戦ページの部品
  '/cdn-cgi/challenge-platform/', // Cloudflare
  'attention required! | cloudflare',
  '_incapsula_resource', // Imperva
  'errors.edgesuite.net', // Akamai の拒否ページ
  'ak_bmsc', // Akamai Bot Manager
];

export function isChallenge(headers, bodyText) {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') return true;
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return CHALLENGE_BODY_MARKERS.some((m) => lower.includes(m));
}

// ---- HTTP の応答の分類 ----
// response: { status, headers }、bodyText: GET で読んだ先頭（HEAD なら null）
// requestUrl: 送った URL（相対の Location を解決するため）、allow: そのサービスの official_domains
export function classifyResponse({ status, headers, bodyText = null, requestUrl, allow }) {
  // 挑戦ページは状態コード（200・403・503 など）にかかわらず unknown
  if (isChallenge(headers, bodyText)) return result('unknown', 'challenge', status);
  if (status >= 200 && status < 300) return result('ok', 'http_2xx', status);
  if (status >= 300 && status < 400) {
    const location = headers.get('location');
    if (!location) return result('unknown', 'redirect_without_location', status);
    let target;
    try {
      target = new URL(location, requestUrl).href;
    } catch {
      return result('unknown', 'redirect_invalid', status);
    }
    if (!parseHttpsUrl(target) || !isAllowedUrl(target, allow)) return result('unknown', 'redirect_offsite', status);
    return result('ok', 'http_3xx', status);
  }
  if (status === 403) return result('unknown', 'http_403', status);
  if (status === 429) return result('unknown', 'http_429', status);
  if (status >= 400 && status < 500) return result('unknown', 'http_4xx', status);
  if (status >= 500 && status < 600) return result('ng', 'http_5xx', status);
  return result('unknown', 'http_other', status);
}

// ---- 例外（つながらなかった）の分類 ----
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA', 'EAI_FAIL']);
const REFUSED_CODES = new Set(['ECONNREFUSED']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_UNTRUSTED', 'CERT_REJECTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO',
]);

export function classifyError(err) {
  // fetch の TypeError('fetch failed') の cause をたどる
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return result('ng', 'timeout');
    const code = typeof e.code === 'string' ? e.code : '';
    if (DNS_CODES.has(code)) return result('ng', 'dns');
    if (REFUSED_CODES.has(code)) return result('ng', 'refused');
    if (TIMEOUT_CODES.has(code)) return result('ng', 'timeout');
    if (TLS_CODES.has(code) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) return result('ng', 'tls');
  }
  return result('unknown', 'exception');
}

// ---- 公式のステータス API（Atlassian Statuspage の /api/v2/status.json） ----
export function classifyStatuspage(json) {
  const indicator = json?.status?.indicator;
  if (indicator === 'none') return result('ok', 'statuspage_none', 200);
  if (typeof indicator === 'string' && /^[a-z_]{1,32}$/.test(indicator)) return result('ng', `statuspage_${indicator}`, 200);
  return result('unknown', 'statuspage_unreadable', 200);
}

// Retry-After（秒か HTTP の日付）→ ミリ秒。読めなければ null
export function parseRetryAfter(value, now) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now.getTime());
}

// ---- status.json の読み取り（前回値・生成のとき） ----
// 形の合わないものは捨てる（壊れた前回値で表示を誤らないため）。
export function sanitizeStatus(json, serviceIds = null) {
  if (!json || typeof json !== 'object' || !isValidDateTime(json.generated_at) || !json.services || typeof json.services !== 'object') return null;
  const services = {};
  for (const [id, e] of Object.entries(json.services)) {
    if (serviceIds && !serviceIds.includes(id)) continue;
    if (!e || !STATES.includes(e.state) || !isValidDateTime(e.checked_at)) continue;
    const history = Array.isArray(e.history)
      ? e.history.filter((h) => h && STATES.includes(h.s) && isValidDateTime(h.t)).slice(-HISTORY_MAX).map((h) => ({ t: h.t, s: h.s }))
      : [];
    services[id] = {
      state: e.state,
      consecutive_ng: Number.isInteger(e.consecutive_ng) && e.consecutive_ng >= 0 ? e.consecutive_ng : 0,
      http_status: Number.isInteger(e.http_status) ? e.http_status : null,
      reason: typeof e.reason === 'string' && /^[a-z0-9_]{1,40}$/.test(e.reason) ? e.reason : 'unknown',
      checked_at: e.checked_at,
      last_ok_at: isValidDateTime(e.last_ok_at) ? e.last_ok_at : null,
      retry_after_until: isValidDateTime(e.retry_after_until) ? e.retry_after_until : null,
      history,
    };
  }
  return { generated_at: json.generated_at, services };
}

// ---- 表示のしかたの判断（§2.2-10〜13、§7） ----

// 観測が全滅（観測したサービスがすべて unknown か ng）なら、観測側の不調を疑う
export function isObserverFailure(status, now) {
  if (!status) return false;
  const fresh = Object.values(status.services).filter((e) => !isStale(e.checked_at, now));
  return fresh.length > 0 && fresh.every((e) => e.state !== 'ok');
}

export function isStale(checkedAt, now) {
  return now.getTime() - Date.parse(checkedAt) >= STALE_MS;
}

// 1サービスの欄に何を出すか
//   none: 観測の結果がまだ無い ／ disabled: 観測していない ／ stale: 観測が止まっている
//   observer_failure: 観測側の不調の可能性 ／ ok ／ ng（2回続けて）／ retrying（1回だけ ng）／ unknown
export function observationView(service, status, now) {
  if (!service.monitor.enabled) return { kind: 'disabled' };
  const e = status?.services[service.id];
  if (!e) return { kind: 'none' };
  if (isStale(e.checked_at, now)) return { kind: 'stale', entry: e };
  if (isObserverFailure(status, now)) return { kind: 'observer_failure', entry: e };
  if (e.state === 'ok') return { kind: 'ok', entry: e };
  if (e.state === 'ng') return { kind: e.consecutive_ng >= NG_DISPLAY_MIN ? 'ng' : 'retrying', entry: e };
  return { kind: 'unknown', entry: e };
}

// 帯に出す1件ごとの表示。ng は前後どちらかも ng のとき（2回続いたもの）だけ「応答なし」、1回だけなら「確かめ直し」
export function historyCells(history, now) {
  const recent = history.filter((h) => now.getTime() - Date.parse(h.t) < 24 * 60 * 60 * 1000);
  return recent.map((h, i) => {
    if (h.s !== 'ng') return { t: h.t, kind: h.s };
    const paired = recent[i - 1]?.s === 'ng' || recent[i + 1]?.s === 'ng';
    return { t: h.t, kind: paired ? 'ng' : 'retrying' };
  });
}

export const REASON_LABEL = {
  http_2xx: '応答がありました',
  http_3xx: '公式ドメインの中への転送の応答がありました',
  http_403: 'アクセスが制限されていました（403）',
  http_429: 'アクセスの回数を制限されていました（429）',
  http_4xx: 'ページの応答が想定と違いました（4xx）',
  http_5xx: 'サーバの誤りの応答でした（5xx）',
  http_other: '想定していない応答でした',
  challenge: 'ボット対策の確認画面が出ました',
  robots_disallow: 'robots.txt で観測を断られています',
  robots_unreachable: 'robots.txt を読めませんでした',
  redirect_offsite: '公式ドメインの外へ転送されました',
  redirect_without_location: '転送先が示されませんでした',
  redirect_invalid: '転送先を読めませんでした',
  timeout: '10秒以内に応答がありませんでした',
  dns: 'ドメイン名を引けませんでした（DNS）',
  refused: '接続を拒否されました',
  tls: '暗号化の接続（TLS）を確立できませんでした',
  exception: '観測側で想定していない誤りが起きました',
  retry_after: 'サイトから間隔を空けるよう求められているため、観測を控えています',
  host_budget: '1回の観測で同じサイトへ送るリクエストの上限に達しました',
  statuspage_none: '公式の状態ページに障害の表示はありません',
  statuspage_unreadable: '公式の状態ページを読めませんでした',
};

export function reasonLabel(reason) {
  if (REASON_LABEL[reason]) return REASON_LABEL[reason];
  if (reason.startsWith('statuspage_')) return '公式の状態ページに障害などの表示がありました';
  return '理由を分類できませんでした';
}
