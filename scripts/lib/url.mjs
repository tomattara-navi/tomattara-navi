// URL の検査（§2.1-4、§2.4-24）。
// 許可の書き方は2通り:
//   "bk.mufg.jp"                  … そのドメインとサブドメイン
//   "secure.okbiz.jp/eki-net/"    … そのホストだけ・そのパスの下だけ（委託先のページ用）

// https: で、ユーザー名・パスワード・ポート番号を含まない URL だけを URL オブジェクトにして返す。
// それ以外（javascript: や http:、壊れた文字列）は null。
export function parseHttpsUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  if (!url.hostname || url.hostname.endsWith('.')) return null;
  return url;
}

export function isPathEntry(entry) {
  return entry.includes('/');
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// 許可の書き方として正しいか。
export function isValidAllowEntry(entry) {
  if (typeof entry !== 'string') return false;
  if (!isPathEntry(entry)) return HOST_RE.test(entry);
  const slash = entry.indexOf('/');
  const host = entry.slice(0, slash);
  const path = entry.slice(slash);
  return HOST_RE.test(host) && /^\/[A-Za-z0-9._~\-/]*$/.test(path) && path.length > 1;
}

export function matchesAllowEntry(url, entry) {
  const u = typeof url === 'string' ? parseHttpsUrl(url) : url;
  if (!u) return false;
  const host = u.hostname;
  if (!isPathEntry(entry)) {
    return host === entry || host.endsWith('.' + entry);
  }
  const slash = entry.indexOf('/');
  const entryHost = entry.slice(0, slash);
  const prefix = entry.slice(slash).replace(/\/+$/, '');
  if (host !== entryHost) return false;
  return u.pathname === prefix || u.pathname.startsWith(prefix + '/');
}

export function isAllowedUrl(url, entries) {
  const u = parseHttpsUrl(url);
  if (!u) return false;
  return entries.some((entry) => matchesAllowEntry(u, entry));
}

// 表示用: 「ホスト名＋パス」（https:// と末尾の / を省く）。
export function displayUrl(url) {
  const u = parseHttpsUrl(url);
  if (!u) return '';
  const path = u.pathname === '/' ? '' : u.pathname;
  return u.hostname + path + u.search;
}
