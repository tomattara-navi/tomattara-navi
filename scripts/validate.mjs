// データの検査（docs/PLAN.md §6）。CI で必ず通す。
//   node scripts/validate.mjs
// 誤りがあれば一覧を出して終了コード 1。警告（確認日が古い等）は出すだけで失敗にしない。
import { pathToFileURL } from 'node:url';
import { loadData } from './lib/data.mjs';
import { parseHttpsUrl, isAllowedUrl, isValidAllowEntry, matchesAllowEntry } from './lib/url.mjs';
import { isValidDate, isValidDateTime, daysBetween, jstDate } from './lib/time.mjs';

export const UNVERIFIED = 'unverified';
export const STALE_DAYS = 180;

const SERVICE_KEYS = [
  'id', 'name', 'operator', 'category', 'mostly_unverified', 'official_domains', 'official_top',
  'official_notices', 'official_x', 'phone_desk', 'official_alternatives', 'general_alternatives',
  'not_official', 'monitor', 'notes', 'verified_at', 'verified_by',
];
const INCIDENT_KEYS = [
  'id', 'service_id', 'title', 'status', 'started_at', 'resolved_at', 'summary', 'what_you_can_do',
  'sources', 'updated_at',
];
const INCIDENT_STATUSES = ['ongoing', 'partially_restored', 'resolved'];
const PHONE_DESK = ['listed', 'none', UNVERIFIED];

// 電話番号: 0 から始まりハイフンで区切った8〜11桁（0120- 0570- 03- 等）、3桁の短縮番号（151 等）、#4桁。
// 全角の数字・空白・括弧は失敗にする。
export const PHONE_RE = /^(?:0\d{1,4}(?:-\d{1,6}){1,3}|1\d{2}|#\d{4})$/;

export function isValidPhone(value) {
  if (typeof value !== 'string' || !PHONE_RE.test(value)) return false;
  if (!value.startsWith('0')) return true;
  const digits = value.replace(/-/g, '').length;
  return digits >= 8 && digits <= 11;
}

// 「公式」が単独で使われていないか（§6-6）。
// 「公式発表」「公式サイト」「公式の〜」のような言い回しと「非公式」は可。
// 「【公式】」「〇〇公式」「公式ナビ」のように、このサイト自体が公式であるかのように読めるものは不可。
const OFFICIAL_OK_NEXT = [
  '発表', 'サイト', '情報', 'ページ', 'ドメイン', 'の', 'X', ' X', 'アカウント', 'お知らせ', '窓口', 'トップ',
  'アプリ', 'では', 'に', 'で',
];

export function hasStandaloneOfficial(text) {
  const s = String(text);
  let i = s.indexOf('公式');
  while (i >= 0) {
    const prev = s[i - 1];
    const rest = s.slice(i + 2);
    if (prev !== '非' && !OFFICIAL_OK_NEXT.some((w) => rest.startsWith(w))) return true;
    i = s.indexOf('公式', i + 2);
  }
  return false;
}

class Checker {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  error(where, msg) {
    this.errors.push(`${where}: ${msg}`);
  }
  warn(where, msg) {
    this.warnings.push(`${where}: ${msg}`);
  }
  isObject(where, v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      this.error(where, 'オブジェクトではありません');
      return false;
    }
    return true;
  }
  keys(where, obj, expected) {
    for (const k of expected) if (!(k in obj)) this.error(where, `必須の項目 "${k}" がありません`);
    for (const k of Object.keys(obj)) if (!expected.includes(k)) this.error(where, `知らない項目 "${k}" があります`);
  }
  string(where, v, { nullable = false } = {}) {
    if (nullable && v === null) return true;
    if (typeof v !== 'string' || v.trim() === '') {
      this.error(where, nullable ? '空でない文字列か null にしてください' : '空でない文字列にしてください');
      return false;
    }
    return true;
  }
  stringArray(where, v) {
    if (!Array.isArray(v)) return this.error(where, '配列にしてください');
    v.forEach((s, i) => this.string(`${where}[${i}]`, s));
  }
  boolean(where, v) {
    if (typeof v !== 'boolean') this.error(where, 'true か false にしてください');
  }
  oneOf(where, v, list) {
    if (!list.includes(v)) this.error(where, `${JSON.stringify(v)} は使えません（${list.join(' / ')}）`);
  }
  date(where, v) {
    if (!isValidDate(v)) this.error(where, `日付は YYYY-MM-DD にしてください（${JSON.stringify(v)}）`);
  }
  dateTime(where, v) {
    if (!isValidDateTime(v)) this.error(where, `日時は 2026-10-15T11:35+09:00 の形にしてください（${JSON.stringify(v)}）`);
  }
  // https: で、許可の一覧に一致する URL か
  url(where, v, allow, { label = 'official_domains' } = {}) {
    if (!parseHttpsUrl(v)) return this.error(where, `https: の URL にしてください（${JSON.stringify(v)}）`);
    if (allow === UNVERIFIED) return this.error(where, `公式ドメインが未確認なので URL を載せられません（${v}）`);
    if (!isAllowedUrl(v, allow)) this.error(where, `${v} は ${label}（${allow.join(', ')}）に一致しません`);
  }
  phone(where, v) {
    if (!isValidPhone(v)) this.error(where, `電話番号の形が違います（${JSON.stringify(v)}。半角数字とハイフンで 0120-123-456 のように）`);
  }
  officialWord(where, v) {
    if (hasStandaloneOfficial(v)) this.error(where, `「公式」を単独で使わないでください（${JSON.stringify(v)}）`);
  }
  uniqueIds(where, list) {
    const seen = new Set();
    for (const item of list) {
      if (item && typeof item.id === 'string') {
        if (seen.has(item.id)) this.error(where, `id "${item.id}" が重複しています`);
        seen.add(item.id);
      }
    }
    return seen;
  }
  id(where, v) {
    if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(v)) this.error(where, `id は半角英小文字・数字・ハイフンにしてください（${JSON.stringify(v)}）`);
  }
}

function checkLink(c, where, link, allow) {
  if (!c.isObject(where, link)) return;
  c.keys(where, link, ['url', 'label', 'verified', 'note']);
  c.url(`${where}.url`, link.url, allow);
  c.string(`${where}.label`, link.label, { nullable: true });
  c.boolean(`${where}.verified`, link.verified);
  c.string(`${where}.note`, link.note, { nullable: true });
  if (link.label) c.officialWord(`${where}.label`, link.label);
}

function checkService(c, s, ctx) {
  const w = `services[${s?.id ?? '?'}]`;
  if (!c.isObject(w, s)) return;
  c.keys(w, s, SERVICE_KEYS);
  c.id(`${w}.id`, s.id);
  if (c.string(`${w}.name`, s.name)) c.officialWord(`${w}.name`, s.name);
  c.string(`${w}.operator`, s.operator);
  if (!ctx.categoryIds.has(s.category)) c.error(`${w}.category`, `知らないカテゴリ "${s.category}"`);
  c.boolean(`${w}.mostly_unverified`, s.mostly_unverified);

  // 公式ドメイン
  let allow = UNVERIFIED;
  if (s.official_domains !== UNVERIFIED) {
    if (!Array.isArray(s.official_domains) || s.official_domains.length === 0) {
      c.error(`${w}.official_domains`, '1つ以上の配列か "unverified" にしてください');
    } else {
      s.official_domains.forEach((d, i) => {
        if (!isValidAllowEntry(d)) c.error(`${w}.official_domains[${i}]`, `ドメインの形が違います（${JSON.stringify(d)}）`);
      });
      allow = s.official_domains;
    }
  }

  // 公式トップ
  if (s.official_top !== UNVERIFIED) checkLink(c, `${w}.official_top`, s.official_top, allow);

  // 公式のお知らせ
  if (s.official_notices !== UNVERIFIED && s.official_notices !== null) {
    if (!Array.isArray(s.official_notices) || s.official_notices.length === 0) {
      c.error(`${w}.official_notices`, '1つ以上の配列か null（無い）か "unverified"（未確認）にしてください');
    } else {
      s.official_notices.forEach((l, i) => checkLink(c, `${w}.official_notices[${i}]`, l, allow));
    }
  }

  // 公式 X（リンクにはせず、アカウント名を文字で出す）
  if (s.official_x !== UNVERIFIED && s.official_x !== null) {
    const xw = `${w}.official_x`;
    if (c.isObject(xw, s.official_x)) {
      c.keys(xw, s.official_x, ['handle', 'note', 'source_url']);
      const { handle, note, source_url: src } = s.official_x;
      if (handle !== null && !(typeof handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(handle))) {
        c.error(`${xw}.handle`, `X のアカウント名の形が違います（${JSON.stringify(handle)}。@ は付けない）`);
      }
      c.string(`${xw}.note`, note, { nullable: true });
      if (src !== null) c.url(`${xw}.source_url`, src, allow);
      if (handle === null && src === null) c.error(xw, 'handle が null のときは source_url（一覧のページ）が要ります');
    }
  }

  // 公式の代替窓口
  c.oneOf(`${w}.phone_desk`, s.phone_desk, PHONE_DESK);
  let phoneCount = 0;
  if (s.official_alternatives !== UNVERIFIED) {
    if (!Array.isArray(s.official_alternatives)) {
      c.error(`${w}.official_alternatives`, '配列か "unverified" にしてください');
    } else {
      s.official_alternatives.forEach((a, i) => {
        const aw = `${w}.official_alternatives[${i}]`;
        if (!c.isObject(aw, a)) return;
        c.keys(aw, a, ['label', 'detail', 'url', 'phones', 'hours']);
        if (c.string(`${aw}.label`, a.label)) c.officialWord(`${aw}.label`, a.label);
        c.string(`${aw}.detail`, a.detail, { nullable: true });
        if (a.url !== null) c.url(`${aw}.url`, a.url, allow);
        if (!Array.isArray(a.phones)) {
          c.error(`${aw}.phones`, '配列にしてください（無ければ []）');
        } else {
          a.phones.forEach((p, j) => {
            const pw = `${aw}.phones[${j}]`;
            if (!c.isObject(pw, p)) return;
            c.keys(pw, p, ['number', 'note']);
            c.phone(`${pw}.number`, p.number);
            c.string(`${pw}.note`, p.note, { nullable: true });
            phoneCount++;
          });
          if (a.phones.length > 0) {
            // 電話番号には根拠のページと受付時間（または "unverified"）を付ける
            if (a.url === null) c.error(`${aw}.url`, '電話番号には根拠のページの URL が要ります');
            c.string(`${aw}.hours`, a.hours);
          } else if (a.hours !== null) {
            c.error(`${aw}.hours`, '電話番号が無いときは null にしてください');
          }
        }
      });
    }
  }
  if (s.phone_desk === 'listed' && phoneCount === 0) c.error(`${w}.phone_desk`, '"listed" なのに電話番号がありません');
  if (s.phone_desk !== 'listed' && phoneCount > 0) c.error(`${w}.phone_desk`, `"${s.phone_desk}" なのに電話番号があります`);

  // 同じ用事ができる別の手段（一般論）
  if (!Array.isArray(s.general_alternatives)) {
    c.error(`${w}.general_alternatives`, '配列にしてください');
  } else {
    s.general_alternatives.forEach((g, i) => {
      const gw = `${w}.general_alternatives[${i}]`;
      if (!c.isObject(gw, g)) return;
      c.keys(gw, g, ['text', 'link']);
      c.string(`${gw}.text`, g.text);
      if (g.link !== null && !ctx.linkIds.has(g.link)) c.error(`${gw}.link`, `data/links.json に無い id "${g.link}"`);
    });
  }

  // 公式ではないと案内されているドメイン
  if (!Array.isArray(s.not_official)) {
    c.error(`${w}.not_official`, '配列にしてください（無ければ []）');
  } else {
    s.not_official.forEach((n, i) => {
      const nw = `${w}.not_official[${i}]`;
      if (!c.isObject(nw, n)) return;
      c.keys(nw, n, ['domain', 'note']);
      if (!isValidAllowEntry(n.domain)) c.error(`${nw}.domain`, `ドメインの形が違います（${JSON.stringify(n.domain)}）`);
      else if (allow !== UNVERIFIED && allow.some((d) => matchesAllowEntry(`https://${n.domain}/`, d))) {
        c.error(`${nw}.domain`, `${n.domain} が official_domains と重なっています`);
      }
      c.string(`${nw}.note`, n.note);
    });
  }

  // 観測の設定（フェーズ2で使う）
  const mw = `${w}.monitor`;
  if (c.isObject(mw, s.monitor)) {
    c.keys(mw, s.monitor, ['url', 'method', 'enabled', 'statuspage_api']);
    c.boolean(`${mw}.enabled`, s.monitor.enabled);
    c.oneOf(`${mw}.method`, s.monitor.method, ['HEAD', 'GET']);
    if (s.monitor.url !== null) c.url(`${mw}.url`, s.monitor.url, allow);
    else if (s.monitor.enabled) c.error(`${mw}.url`, 'enabled が true なら URL が要ります');
    if (s.monitor.statuspage_api !== null) c.url(`${mw}.statuspage_api`, s.monitor.statuspage_api, allow);
  }

  c.stringArray(`${w}.notes`, s.notes);
  c.date(`${w}.verified_at`, s.verified_at);
  c.string(`${w}.verified_by`, s.verified_by);
  if (isValidDate(s.verified_at) && daysBetween(s.verified_at, ctx.today) > STALE_DAYS) {
    c.warn(`${w}.verified_at`, `確認日 ${s.verified_at} から${STALE_DAYS}日を過ぎています（画面では「要再確認」）`);
  }
}

function checkSources(c, w, sources, { serviceAllow, allowedServiceIds, requireOfficial }) {
  if (!Array.isArray(sources) || sources.length === 0) {
    c.error(`${w}.sources`, '出典を1つ以上入れてください');
    return;
  }
  let official = 0;
  sources.forEach((src, i) => {
    const sw = `${w}.sources[${i}]`;
    if (!c.isObject(sw, src)) return;
    if (src.type === 'official') {
      official++;
      if (serviceAllow) {
        c.keys(sw, src, ['url', 'type']);
        c.url(`${sw}.url`, src.url, serviceAllow);
      } else {
        // 過去の事例: どのサービスの公式発表かを service_id で示す
        c.keys(sw, src, ['url', 'type', 'service_id']);
        const target = allowedServiceIds.get(src.service_id);
        if (!target) c.error(`${sw}.service_id`, `この事例の service_ids に無い id "${src.service_id}"`);
        else c.url(`${sw}.url`, src.url, target);
      }
    } else if (src.type === 'press') {
      // 報道の URL は出典（type: "press"）としてだけ許す。https: であることだけを見る。
      c.keys(sw, src, ['url', 'type']);
      if (!parseHttpsUrl(src.url)) c.error(`${sw}.url`, `https: の URL にしてください（${JSON.stringify(src.url)}）`);
    } else {
      c.error(`${sw}.type`, `"official" か "press" にしてください（${JSON.stringify(src.type)}）`);
    }
  });
  if (requireOfficial && official === 0) {
    c.error(`${w}.sources`, '公式発表の出典（type: "official"）が1つもありません。報道だけでは登録できません');
  }
}

function checkIncident(c, inc, ctx) {
  const w = `incidents[${inc?.id ?? '?'}]`;
  if (!c.isObject(w, inc)) return;
  c.keys(w, inc, INCIDENT_KEYS);
  c.id(`${w}.id`, inc.id);
  const service = ctx.services.get(inc.service_id);
  if (!service) c.error(`${w}.service_id`, `services に無い id "${inc.service_id}"`);
  if (c.string(`${w}.title`, inc.title)) c.officialWord(`${w}.title`, inc.title);
  c.oneOf(`${w}.status`, inc.status, INCIDENT_STATUSES);
  c.dateTime(`${w}.started_at`, inc.started_at);
  if (inc.status === 'resolved') c.dateTime(`${w}.resolved_at`, inc.resolved_at);
  else if (inc.resolved_at !== null) c.error(`${w}.resolved_at`, '"resolved" 以外のときは null にしてください');
  c.string(`${w}.summary`, inc.summary);
  c.stringArray(`${w}.what_you_can_do`, inc.what_you_can_do);
  checkSources(c, w, inc.sources, {
    serviceAllow: service ? service.official_domains : UNVERIFIED,
    requireOfficial: true,
  });
  c.date(`${w}.updated_at`, inc.updated_at);
}

function checkPastCase(c, pc, ctx) {
  const w = `past_cases[${pc?.id ?? '?'}]`;
  if (!c.isObject(w, pc)) return;
  c.keys(w, pc, ['id', 'service_ids', 'name', 'period', 'cause', 'summary', 'alternatives_used', 'sources']);
  c.id(`${w}.id`, pc.id);
  const allowed = new Map();
  if (!Array.isArray(pc.service_ids)) c.error(`${w}.service_ids`, '配列にしてください（無ければ []）');
  else {
    for (const id of pc.service_ids) {
      const s = ctx.services.get(id);
      if (!s) c.error(`${w}.service_ids`, `services に無い id "${id}"`);
      else allowed.set(id, s.official_domains);
    }
  }
  for (const k of ['name', 'period', 'cause', 'summary']) c.string(`${w}.${k}`, pc[k]);
  c.officialWord(`${w}.name`, pc.name ?? '');
  c.stringArray(`${w}.alternatives_used`, pc.alternatives_used);
  checkSources(c, w, pc.sources, { allowedServiceIds: allowed, requireOfficial: false });
}

export function validate(data, { today = jstDate(new Date()) } = {}) {
  const c = new Checker();

  // site
  if (c.isObject('site', data.site)) {
    c.keys('site', data.site, ['name', 'url', 'description']);
    if (c.string('site.name', data.site.name)) c.officialWord('site.name', data.site.name);
    if (!parseHttpsUrl(data.site.url) || !data.site.url.endsWith('/')) c.error('site.url', 'https: で始まり / で終わる URL にしてください');
    c.string('site.description', data.site.description);
  }

  // content（固定ページ）
  const guideIds = new Set();
  for (const page of data.content) {
    const w = `content/${page.file}`;
    if (c.string(`${w} の title`, page.meta.title)) c.officialWord(`${w} の title`, page.meta.title);
    c.string(`${w} の description`, page.meta.description);
    if (page.file.startsWith('guide-')) guideIds.add(page.file.slice(6, -5));
  }

  // categories
  if (!Array.isArray(data.categories)) c.error('categories', '配列にしてください');
  const categoryIds = c.uniqueIds('categories', data.categories);
  for (const cat of data.categories) {
    const w = `categories[${cat?.id ?? '?'}]`;
    if (!c.isObject(w, cat)) continue;
    c.keys(w, cat, ['id', 'name', 'guide']);
    c.id(`${w}.id`, cat.id);
    if (c.string(`${w}.name`, cat.name)) c.officialWord(`${w}.name`, cat.name);
    if (cat.guide !== null && !guideIds.has(cat.guide)) c.error(`${w}.guide`, `content/guide-${cat.guide}.html がありません`);
  }

  // links
  const linkIds = c.uniqueIds('links', data.links);
  for (const l of data.links) {
    const w = `links[${l?.id ?? '?'}]`;
    if (!c.isObject(w, l)) continue;
    c.keys(w, l, ['id', 'name', 'url', 'domains', 'basis']);
    c.id(`${w}.id`, l.id);
    c.string(`${w}.name`, l.name);
    c.string(`${w}.basis`, l.basis);
    if (!Array.isArray(l.domains) || l.domains.length === 0 || !l.domains.every(isValidAllowEntry)) {
      c.error(`${w}.domains`, 'ドメインの配列にしてください');
    } else {
      c.url(`${w}.url`, l.url, l.domains, { label: 'domains' });
    }
  }

  // consultation（相談先）
  c.uniqueIds('consultation', data.consultation);
  for (const p of data.consultation) {
    const w = `consultation[${p?.id ?? '?'}]`;
    if (!c.isObject(w, p)) continue;
    c.keys(w, p, ['id', 'name', 'phone', 'detail', 'verified_at']);
    c.id(`${w}.id`, p.id);
    c.string(`${w}.name`, p.name);
    c.string(`${w}.detail`, p.detail);
    if (p.phone !== null) c.phone(`${w}.phone`, p.phone);
    if (p.verified_at !== UNVERIFIED) c.date(`${w}.verified_at`, p.verified_at);
  }

  // services
  if (!Array.isArray(data.services)) c.error('services', '配列にしてください');
  c.uniqueIds('services', data.services);
  const services = new Map(data.services.filter((s) => s && s.id).map((s) => [s.id, s]));
  const ctx = { today, categoryIds, linkIds, services };
  for (const s of data.services) checkService(c, s, ctx);

  // incidents
  if (!Array.isArray(data.incidents)) c.error('incidents', '配列にしてください（無ければ []）');
  c.uniqueIds('incidents', data.incidents);
  for (const inc of data.incidents) checkIncident(c, inc, ctx);

  // past_cases
  c.uniqueIds('past_cases', data.past_cases);
  for (const pc of data.past_cases) checkPastCase(c, pc, ctx);

  return { errors: c.errors, warnings: c.warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { errors, warnings } = validate(loadData());
  for (const w of warnings) console.warn(`警告: ${w}`);
  for (const e of errors) console.error(`誤り: ${e}`);
  if (errors.length > 0) {
    console.error(`\n誤りが ${errors.length} 件あります。`);
    process.exit(1);
  }
  console.log(`データの検査: 誤り 0 件・警告 ${warnings.length} 件`);
}
