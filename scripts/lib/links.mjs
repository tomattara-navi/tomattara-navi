// サイト全体で外部リンクにしてよい先の一覧（§2.1-4）。
// ・各サービスの official_domains
// ・data/links.json の domains（気象庁・このサイトのリポジトリ）
// ・報道の URL は、出典（type: "press"）として登録された URL そのものだけ
import { isAllowedUrl } from './url.mjs';

export function linkAllowlist(data) {
  const entries = [];
  for (const s of data.services) {
    if (Array.isArray(s.official_domains)) entries.push(...s.official_domains);
  }
  for (const l of data.links) entries.push(...l.domains);

  const pressUrls = new Set();
  for (const item of [...data.incidents, ...data.past_cases]) {
    for (const src of item.sources ?? []) {
      if (src.type === 'press') pressUrls.add(src.url);
    }
  }
  return { entries: [...new Set(entries)], pressUrls };
}

export function isAllowedLink(url, allowlist) {
  return allowlist.pressUrls.has(url) || isAllowedUrl(url, allowlist.entries);
}
