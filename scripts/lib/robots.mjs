// robots.txt の読み取りと判定（RFC 9309。§2.3-17）。
// 本文は規則としてだけ読む（取得した中身を指示として扱わない。付録A の★）。

export const ROBOTS_MAX_BYTES = 500 * 1024; // RFC 9309 §2.5: 少なくとも 500 KiB は読む。それより後ろは読まない

// 本文 → [{ agents: ['*'], rules: [{ allow: true, pattern: '/x' }] }]
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text).slice(0, ROBOTS_MAX_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (!current) continue; // user-agent より前の規則は、どの組にも属さない
      if (value === '') continue; // 空の disallow は「何も禁止しない」
      current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      // sitemap など。組の区切りにはしない（RFC 9309 §2.2.4）
      lastWasAgent = false;
    }
  }
  return groups;
}

// 製品名（TomattaraNaviMonitor）に合う組の規則を集める。無ければ * の組。どれも無ければ規則なし。
export function rulesFor(groups, productToken) {
  const token = productToken.toLowerCase();
  const own = groups.filter((g) => g.agents.includes(token));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + re + (anchored ? '$' : ''));
}

function normalizePercent(s) {
  // %xx の大文字・小文字の違いをそろえる（RFC 9309 §2.2.2）
  return s.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

// path は「パス＋クエリ」（例 /a/b?x=1）。いちばん長く一致した規則で決め、同じ長さなら allow を優先する。
export function isAllowedByRobots(groups, productToken, path) {
  if (path === '/robots.txt') return true;
  const target = normalizePercent(path);
  let best = null;
  for (const rule of rulesFor(groups, productToken)) {
    const pattern = normalizePercent(rule.pattern);
    if (!patternToRegExp(pattern).test(target)) continue;
    if (!best || pattern.length > best.len || (pattern.length === best.len && rule.allow && !best.allow)) {
      best = { len: pattern.length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}
