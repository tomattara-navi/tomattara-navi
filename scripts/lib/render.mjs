// HTML の組み立て。値はすべて html`` でエスケープし、外部リンクは許可の一覧で検査してから出す。
import { html, raw, SafeHtml } from './escape.mjs';
import { displayUrl, isPathEntry } from './url.mjs';
import { isAllowedLink } from './links.mjs';
import { daysBetween, formatWhen, jstDate, jstDateTime } from './time.mjs';
import { observationView, historyCells, isObserverFailure, isStale, reasonLabel } from './status.mjs';

export const BANNER_TEXT = 'このサイトは各社とは無関係の非公式の案内です。最新・正確な情報は必ず各社の公式発表で確かめてください。';
export const TITLE_SUFFIX = '（非公式）';
export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
export const UNVERIFIED = 'unverified';
export const STALE_DAYS = 180;
export const RESOLVED_TOP_DAYS = 30;

const STATUS_LABEL = {
  ongoing: '障害中（公式発表）',
  partially_restored: '一部復旧（公式発表）',
  resolved: '復旧（公式発表）',
};

// ---- 部品 ----

export class Ctx {
  constructor({ data, allowlist, root, today, generatedAt, now = new Date(), status = null }) {
    this.data = data;
    this.site = data.site;
    this.allowlist = allowlist;
    this.root = root; // ページから見たサイトの根（'' や '../../'、404 では '/tomattara-navi/'）
    this.today = today;
    this.generatedAt = generatedAt;
    this.now = now; // 生成の時刻（観測が古いかの判断に使う）
    this.status = status; // 観測の結果（status.json）。無ければ null
  }
  // サイト内のリンク先
  href(path) {
    return this.root + path || './';
  }
  // 外部リンク。許可の一覧に無い URL はここで止める（生成の失敗にする）
  ext(url, label) {
    if (!isAllowedLink(url, this.allowlist)) throw new Error(`許可されていないリンク先です: ${url}`);
    return html`<a href="${url}">${label}</a><span class="url">${displayUrl(url)}</span>`;
  }
  service(id) {
    return this.data.services.find((s) => s.id === id);
  }
}

function unverified(text = '未確認') {
  return html`<span class="unverified">${text}</span>`;
}

function verifiedDate(ctx, date) {
  if (date === UNVERIFIED) return html`確認日: ${unverified()}`;
  const stale = daysBetween(date, ctx.today) > STALE_DAYS;
  return html`確認日: ${date}${stale ? html` <span class="stale">要再確認（確認から${STALE_DAYS}日を過ぎています）</span>` : ''}`;
}

function linkItem(ctx, link, fallbackLabel) {
  const notes = [];
  if (!link.verified) notes.push(html`${unverified('このページは未確認')}`);
  if (link.note) notes.push(link.note);
  return html`<li>${ctx.ext(link.url, link.label ?? fallbackLabel)}${notes.length ? html`<span class="note">${notes.map((n, i) => html`${i ? '。' : ''}${n}`)}</span>` : ''}</li>`;
}

function domainText(entry) {
  return isPathEntry(entry)
    ? html`<code>${entry}</code>（委託先のページ。この URL の下だけ）`
    : html`<code>${entry}</code>`;
}

export function activeIncidents(data) {
  return data.incidents.filter((i) => i.status === 'ongoing' || i.status === 'partially_restored');
}

export function recentlyResolved(data, today) {
  return data.incidents.filter((i) => i.status === 'resolved' && daysBetween(jstDate(new Date(i.resolved_at)), today) <= RESOLVED_TOP_DAYS);
}

export function oldResolved(data, today) {
  return data.incidents.filter((i) => i.status === 'resolved' && daysBetween(jstDate(new Date(i.resolved_at)), today) > RESOLVED_TOP_DAYS);
}

function sourceList(ctx, sources) {
  return html`<ul class="sources">${sources.map((s) => html`<li>${s.type === 'official' ? '公式発表' : '報道'}: ${ctx.ext(s.url, s.type === 'official' ? '公式発表を開く' : '記事を開く')}</li>`)}</ul>`;
}

function incidentCard(ctx, inc, { headingLevel = 3, showService = true } = {}) {
  const s = ctx.service(inc.service_id);
  const H = headingLevel === 2 ? ['<h2>', '</h2>'] : ['<h3>', '</h3>'];
  return html`<article class="incident incident-${inc.status}">
${raw(H[0])}<span class="badge">${STATUS_LABEL[inc.status]}</span> ${showService ? html`${s.name}: ` : ''}${inc.title}${raw(H[1])}
<p>${inc.summary}</p>
${inc.what_you_can_do.length ? html`<p class="sub">会社が案内している代わりの手段</p><ul>${inc.what_you_can_do.map((t) => html`<li>${t}</li>`)}</ul>` : ''}
<dl class="facts"><dt>始まり</dt><dd>${formatWhen(inc.started_at)}</dd>${inc.resolved_at ? html`<dt>復旧</dt><dd>${formatWhen(inc.resolved_at)}</dd>` : ''}<dt>当サイトの更新</dt><dd>${inc.updated_at}</dd></dl>
<p class="sub">出典</p>
${sourceList(ctx, inc.sources)}
${showService ? html`<p><a href="${ctx.href(`s/${s.id}/`)}">${s.name}の公式情報と代わりの手段</a></p>` : ''}
</article>`;
}

// ---- 全体の枠 ----

export function layout(ctx, page) {
  const { site } = ctx;
  const title = page.path === '' ? `${site.name}: ${page.h1}${TITLE_SUFFIX}` : `${page.h1} | ${site.name}${TITLE_SUFFIX}`;
  const canonical = site.url + page.path;
  const nav = [
    ['', 'トップ'],
    ['phishing/', '偽サイトに注意'],
    ['past/', '過去の事例'],
    ['about/', 'このサイトについて'],
  ];
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
${page.noindex ? raw('<meta name="robots" content="noindex">\n') : ''}<title>${title}</title>
<meta name="description" content="${page.description}">
${page.path === '' && site.google_site_verification ? html`<meta name="google-site-verification" content="${site.google_site_verification}">\n` : ''}<link rel="canonical" href="${canonical}">
<link rel="stylesheet" href="${ctx.root}assets/site.css">
<link rel="icon" href="${ctx.root}assets/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:locale" content="ja_JP">
<meta property="og:site_name" content="${site.name}${TITLE_SUFFIX}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${page.description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${site.url}assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
</head>
<body>
<a class="skip" href="#main">本文へ移動</a>
<div class="banner" role="note"><p>${BANNER_TEXT}</p></div>
<header class="site-header">
<p class="site-name"><a href="${ctx.href('')}">${site.name}</a><span class="tag">非公式の案内</span></p>
<nav aria-label="サイト内"><ul>${nav.map(([p, label]) => html`<li><a href="${ctx.href(p)}"${p === page.path ? raw(' aria-current="page"') : ''}>${label}</a></li>`)}</ul></nav>
</header>
<main id="main">
${page.breadcrumbs ? html`<nav class="breadcrumbs" aria-label="現在の位置"><ol>${page.breadcrumbs.map(([p, label]) => html`<li><a href="${ctx.href(p)}">${label}</a></li>`)}<li aria-current="page">${page.h1}</li></ol></nav>` : ''}
<h1>${page.h1}</h1>
${page.body}
</main>
<footer class="site-footer">
<ul>
<li><a href="${ctx.href('about/')}">このサイトについて</a></li>
<li><a href="${ctx.href('disclaimer/')}">免責事項</a></li>
<li><a href="${ctx.href('privacy/')}">プライバシー</a></li>
<li><a href="${ctx.href('bot/')}">自動の観測について</a></li>
<li><a href="${ctx.href('phishing/')}">偽サイトに注意</a></li>
<li><a href="${ctx.href('past/')}">過去の事例</a></li>
</ul>
<p>${site.name}は各社とは無関係の非公式の案内です。コードは MIT、データは CC BY 4.0 で公開しています。</p>
<p>このページの生成: ${ctx.generatedAt}（日本時間）</p>
</footer>
</body>
</html>
`.toString();
}

// ---- トップ ----

export function topPage(ctx) {
  const { data } = ctx;
  const active = activeIncidents(data);
  const recent = recentlyResolved(data, ctx.today);
  const guides = data.content.filter((c) => c.file.startsWith('guide-'));
  const body = html`<p class="lead">いま何が止まっていて、代わりにどこで何ができるかをまとめた非公式の案内です。各社の公式のお知らせ・公式の代わりの窓口へのリンクと、偽サイトへの注意を載せています。</p>

<section aria-labelledby="now">
<h2 id="now">いま公式に発表されている障害</h2>
${active.length
    ? active.map((i) => incidentCard(ctx, i))
    : html`<p>当サイトに登録している公式発表は、いまはありません。</p>
<p>止まっているように見えるときは、下の一覧から各社のページを開き、公式のお知らせを確かめてください。当サイトは、自動の観測で障害を判定していません。</p>`}
</section>
${recent.length ? html`<section aria-labelledby="recent"><h2 id="recent">最近、復旧が発表されたもの</h2>${recent.map((i) => incidentCard(ctx, i))}</section>` : ''}

${observationSummary(ctx)}

<section aria-labelledby="guides">
<h2 id="guides">止まったときにまずすること</h2>
<ul class="cards">${guides.map((g) => html`<li><a href="${ctx.href(g.path)}">${g.meta.title}</a></li>`)}</ul>
</section>

<aside class="caution" aria-labelledby="phishing">
<h2 id="phishing">偽サイト・偽 SMS に注意</h2>
<p>障害のときには「代わりのサイトはこちら」という偽の SMS・メールが増えます。リンクから ID・パスワード・カード番号を入力しないでください。</p>
<p><a href="${ctx.href('phishing/')}">手口と、当サイトが確認した公式ドメインの一覧</a></p>
</aside>

<section aria-labelledby="services">
<h2 id="services">サービスの一覧</h2>
${data.categories.map((cat) => {
    const list = data.services.filter((s) => s.category === cat.id);
    if (!list.length) return '';
    return html`<h3>${cat.name}</h3>
<ul class="services">${list.map((s) => html`<li><a href="${ctx.href(`s/${s.id}/`)}">${s.name}</a>${active.filter((i) => i.service_id === s.id).slice(0, 1).map((i) => html` <span class="badge">${STATUS_LABEL[i.status]}</span>`)}${observationView(s, ctx.status, ctx.now).kind === 'ng' ? html` <span class="obs-mark">当サイトからの観測: 応答なし</span>` : ''}</li>`)}</ul>`;
  })}
</section>`;
  return { path: '', h1: 'サービスが止まったときの公式情報と代わりの手段', description: ctx.site.description, body };
}

// ---- 当サイトからの観測（§2.2-10〜13、§7） ----

export const OBS_TEXT = {
  ok: '当サイトからの観測: 応答がありました',
  ng: '当サイトからの観測: 応答がありませんでした（公式発表ではありません）',
  retrying: '当サイトからの観測: 判定を保留しています（次の観測で確かめます）',
  unknown: '当サイトからの観測: 判定できませんでした',
  stale: '観測が止まっています',
  observer_failure: '観測側の不調の可能性があります',
  none: '当サイトからの観測: 結果はまだありません',
  disabled: '当サイトからの観測: このサービスは、いまは自動の観測をしていません',
};
const OBSERVER_FAILURE_TEXT = '観測したすべてのサービスで応答を確かめられませんでした。当サイトの観測の側の不調の可能性があり、各社の障害を示すものではありません。';
const CELL_LABEL = { ok: '応答あり', ng: '応答なし', retrying: '判定を保留', unknown: '判定できない' };

function when(iso) {
  return `${jstDateTime(new Date(iso))}（日本時間）`;
}

function band(ctx, entry) {
  const cells = historyCells(entry.history, ctx.now);
  if (!cells.length) return '';
  const count = (k) => cells.filter((c) => c.kind === k).length;
  const summary = ['ok', 'unknown', 'retrying', 'ng'].filter((k) => count(k)).map((k) => `${CELL_LABEL[k]} ${count(k)}回`).join('・');
  return html`<p class="sub">直近24時間の観測（${cells.length}回: ${summary}）。左が古く右が新しい。高い棒が応答あり、中くらいの棒が判定できない・保留、低い棒が応答なし（2回続いたもの）。</p>
<ol class="band">${cells.map((c) => html`<li class="b-${c.kind}"><span class="vh">${jstDateTime(new Date(c.t)).slice(11)} ${CELL_LABEL[c.kind]}</span></li>`)}</ol>`;
}

export function observationSection(ctx, s) {
  const v = observationView(s, ctx.status, ctx.now);
  const e = v.entry;
  let inner;
  if (v.kind === 'disabled' || v.kind === 'none') {
    inner = html`<p class="obs obs-none">${OBS_TEXT[v.kind]}。</p>`;
  } else if (v.kind === 'stale') {
    inner = html`<p class="obs obs-stale">${OBS_TEXT.stale}。最後の観測（${when(e.checked_at)}）から2時間以上たっているため、結果を表示していません。</p>`;
  } else if (v.kind === 'observer_failure') {
    inner = html`<p class="obs obs-stale">${OBS_TEXT.observer_failure}。</p><p>${OBSERVER_FAILURE_TEXT}</p><p class="sub">最終観測: ${when(e.checked_at)}</p>`;
  } else {
    inner = html`<p class="obs obs-${v.kind}">${OBS_TEXT[v.kind]}${v.kind === 'unknown' ? html`（${reasonLabel(e.reason)}）` : ''}</p>
<p class="sub">最終観測: ${when(e.checked_at)}${v.kind !== 'ok' && e.last_ok_at ? html` ／ 最後に応答があった観測: ${when(e.last_ok_at)}` : ''}</p>
${band(ctx, e)}`;
  }
  return html`<section aria-labelledby="obs"><h2 id="obs">当サイトからの観測</h2>
${inner}
<p class="sub">当サイトが外から応答を調べた結果で、公式発表ではありません。止まっているかどうかは公式のお知らせで確かめてください。海外からの接続を制限しているサイトは「判定できない」になります（<a href="${ctx.href('bot/')}">観測のしかた</a>）。</p>
</section>`;
}

function observationSummary(ctx) {
  const { status } = ctx;
  if (!status) return '';
  let inner;
  if (isStale(status.generated_at, ctx.now)) {
    inner = html`<p class="obs obs-stale">${OBS_TEXT.stale}。最後の観測（${when(status.generated_at)}）から2時間以上たっているため、結果を表示していません。</p>`;
  } else if (isObserverFailure(status, ctx.now)) {
    inner = html`<p class="obs obs-stale">${OBS_TEXT.observer_failure}。</p><p>${OBSERVER_FAILURE_TEXT}</p>`;
  } else {
    const ng = ctx.data.services.filter((s) => observationView(s, status, ctx.now).kind === 'ng');
    inner = ng.length
      ? html`<p>当サイトからの観測で、2回続けて応答が無かったもの（公式発表ではありません）:</p><ul>${ng.map((s) => html`<li><a href="${ctx.href(`s/${s.id}/`)}">${s.name}</a></li>`)}</ul>`
      : html`<p>当サイトからの観測で、2回続けて応答が無かったものはありません。</p>`;
  }
  return html`<section aria-labelledby="observed">
<h2 id="observed">当サイトからの観測</h2>
${inner}
<p class="sub">最終観測: ${when(status.generated_at)}。当サイトが外から応答を調べた結果で、公式発表ではありません（<a href="${ctx.href('bot/')}">観測のしかた</a>）。</p>
</section>`;
}

// ---- サービスごとのページ ----

function noticesSection(ctx, s) {
  let inner;
  if (s.official_notices === UNVERIFIED) inner = html`<p>${unverified()}</p>`;
  else if (s.official_notices === null) inner = html`<p>まとめたお知らせのページは無い（当サイトの確認）。</p>`;
  else inner = html`<ul class="links">${s.official_notices.map((l) => linkItem(ctx, l, '公式のお知らせ'))}</ul>`;
  return html`<section aria-labelledby="notices"><h2 id="notices">まず見る: 公式のお知らせ</h2>${inner}</section>`;
}

function phoneDeskText(s) {
  if (s.phone_desk === 'none') return html`<p>電話の窓口は無い（公式のページで確認）。</p>`;
  if (s.phone_desk === UNVERIFIED) return html`<p>電話の窓口: ${unverified()}</p>`;
  return '';
}

function alternativesSection(ctx, s) {
  let inner;
  if (s.official_alternatives === UNVERIFIED) {
    inner = html`<p>${unverified()}</p>`;
  } else {
    inner = html`${s.official_alternatives.length ? html`<ul class="alts">${s.official_alternatives.map((a) => html`<li>
<p class="alt-label">${a.label}</p>
${a.detail ? html`<p>${a.detail}</p>` : ''}
${a.phones.length ? html`<ul class="phones">${a.phones.map((p) => html`<li><span class="phone">${p.number}</span>${p.note ? html`（${p.note}）` : ''}</li>`)}</ul>
<p class="sub">${a.hours === UNVERIFIED ? '受付時間は公式ページで確かめてください' : `受付時間: ${a.hours}`}</p>` : ''}
${a.url ? html`<p class="sub">${a.phones.length ? '根拠のページ: ' : ''}${ctx.ext(a.url, a.phones.length ? '公式のページを開く' : `${a.label}の公式のページ`)}</p>` : ''}
</li>`)}</ul>` : ''}`;
  }
  return html`<section aria-labelledby="alts"><h2 id="alts">公式の代わりの窓口</h2>
<p class="sub">会社が公表している代わりの手段だけを載せています。</p>
${inner}
${phoneDeskText(s)}
</section>`;
}

function generalSection(ctx, s) {
  return html`<section aria-labelledby="general"><h2 id="general">同じ用事ができる別の手段（一般論）</h2>
<ul>${s.general_alternatives.map((g) => {
    if (!g.link) return html`<li>${g.text}</li>`;
    const l = ctx.data.links.find((x) => x.id === g.link);
    return html`<li>${g.text}: ${ctx.ext(l.url, l.name)}</li>`;
  })}</ul>
</section>`;
}

function siteSection(ctx, s) {
  const top = s.official_top === UNVERIFIED ? html`<p>公式トップ: ${unverified()}</p>` : html`<ul class="links">${linkItem(ctx, s.official_top, `${s.name}の公式トップ`)}</ul>`;
  let x;
  if (s.official_x === UNVERIFIED) x = html`${unverified()}`;
  else if (s.official_x === null) x = html`無い（当サイトの確認）`;
  else {
    const { handle, note, source_url: src } = s.official_x;
    x = html`${handle ? html`<span class="handle">@${handle}</span>` : ''}${note ? html`${handle ? '（' : ''}${note}${handle ? '）' : ''}` : ''}${src ? html`<span class="note">${ctx.ext(src, '公式サイトのアカウントの一覧')}</span>` : ''}`;
  }
  return html`<section aria-labelledby="site"><h2 id="site">公式のサイトと公式 X</h2>
${top}
<p>公式 X（告知に使われるとは限りません）: ${x}</p>
${s.official_x && s.official_x !== UNVERIFIED ? html`<p class="sub">公式サイトに貼られたリンクで確かめたアカウントです。X へのリンクは張っていません。</p>` : ''}
</section>`;
}

function domainsSection(ctx, s) {
  const domains = s.official_domains === UNVERIFIED || s.mostly_unverified
    ? html`<p>当サイトが確認した公式ドメイン: ${unverified()}</p>`
    : html`<p>当サイトが確認した公式ドメイン（${verifiedDate(ctx, s.verified_at)}）</p><ul>${s.official_domains.map((d) => html`<li>${domainText(d)}</li>`)}</ul>`;
  return html`<aside class="caution" aria-labelledby="fake"><h2 id="fake">偽サイトに注意</h2>
<p>障害に便乗した「代わりのサイト」の SMS・メールのリンクは開かないでください。アドレスが公式ドメインで終わっているかを確かめてください。</p>
${domains}
${s.not_official.length ? html`<p>公式ではないと案内されているもの</p><ul>${s.not_official.map((n) => html`<li><code>${n.domain}</code>: ${n.note}</li>`)}</ul>` : ''}
${s.phishing_guide ? html`<p>会社が案内している見分け方</p><ul class="links">${linkItem(ctx, s.phishing_guide, `${s.name}の偽メール・詐欺の見分け方`)}</ul>` : ''}
<p><a href="${ctx.href('phishing/')}">偽サイト・偽 SMS の手口と相談先</a></p>
</aside>`;
}

function pastCasesSection(ctx, s) {
  // 同じ件を公式発表で登録しているもの（incident_id）は、ここでは出さない（「過去の事例」のページには残す）
  const cases = ctx.data.past_cases.filter((pc) => pc.service_ids.includes(s.id) && !ctx.data.incidents.some((i) => i.id === pc.incident_id));
  if (!cases.length) return '';
  return html`<section aria-labelledby="past"><h2 id="past">報道で伝えられた事例</h2>
<p class="sub">当サイトが公式発表を確かめて登録した障害ではありません。</p>
<ul>${cases.map((pc) => html`<li>${pc.period}: ${pc.name}（${pc.cause}）</li>`)}</ul>
<p><a href="${ctx.href('past/')}">過去の事例と出典</a></p>
</section>`;
}

export function servicePage(ctx, s) {
  const cat = ctx.data.categories.find((c) => c.id === s.category);
  const guide = cat.guide ? ctx.data.content.find((c) => c.file === `guide-${cat.guide}.html`) : null;
  const incidents = ctx.data.incidents.filter((i) => i.service_id === s.id && (activeIncidents(ctx.data).includes(i) || recentlyResolved(ctx.data, ctx.today).includes(i)));
  const h1 = `${s.name}が使えないときの公式情報と代わりの手段`;
  const intro = html`<p class="sub">カテゴリ: ${cat.name}${guide ? html` ／ <a href="${ctx.href(guide.path)}">${guide.meta.title}</a>` : ''}</p>
${incidents.map((i) => incidentCard(ctx, i, { headingLevel: 2, showService: false }))}`;
  const checked = html`<section aria-labelledby="checked"><h2 id="checked">このページの情報の確認</h2>
<p>${verifiedDate(ctx, s.verified_at)}</p>
<p class="sub">確かめ方: ${s.verified_by}</p>
<p>運営会社の正式な名称: ${s.operator === UNVERIFIED ? unverified() : s.operator}</p>
<p>誤り・古い情報は「<a href="${ctx.href('about/')}">このサイトについて</a>」の連絡先からお知らせください。</p>
</section>`;

  let body;
  if (s.mostly_unverified) {
    const top = s.official_top === UNVERIFIED ? html`<p>公式トップ: ${unverified()}</p>` : html`<ul class="links">${linkItem(ctx, s.official_top, `${s.name}の公式トップ`)}</ul>`;
    body = html`${intro}
<div class="caution"><p>このサービスの情報は、まだ大部分を確かめていません。確かめるまでは、公式トップへのリンクと「未確認」の表示だけを載せています。</p></div>
<section aria-labelledby="site"><h2 id="site">公式のサイト</h2>${top}
<p>公式のお知らせ・公式の代わりの窓口・電話の窓口・公式ドメイン: ${unverified()}</p></section>
${observationSection(ctx, s)}
<p><a href="${ctx.href('phishing/')}">偽サイト・偽 SMS に注意</a></p>
${checked}`;
  } else {
    body = html`${intro}
${noticesSection(ctx, s)}
${observationSection(ctx, s)}
${alternativesSection(ctx, s)}
${generalSection(ctx, s)}
${siteSection(ctx, s)}
${domainsSection(ctx, s)}
${s.notes.length ? html`<section aria-labelledby="notes"><h2 id="notes">備考</h2><ul>${s.notes.map((n) => html`<li>${n}</li>`)}</ul></section>` : ''}
${pastCasesSection(ctx, s)}
${checked}`;
  }
  return {
    path: `s/${s.id}/`,
    h1,
    description: `${s.name}が使えないときに確かめる公式のお知らせ、公式の代わりの窓口、同じ用事ができる別の手段、偽サイトへの注意（非公式の案内）。`,
    breadcrumbs: [['', 'トップ']],
    body,
  };
}

// ---- 過去の事例 ----

export function pastPage(ctx) {
  const old = oldResolved(ctx.data, ctx.today);
  const body = html`<p>報道などで伝えられた、日本で多くの人が困ったサービスの停止の事例です。止まったときに実際に役立ったのは、どの事例でも会社が案内した代わりの手段でした。</p>
<p class="sub">このページの事例は、当サイトが公式発表を確かめて登録した障害ではありません。いまも続いているものがあります。最新の状況は各社の公式発表で確かめてください。</p>
${old.length ? html`<section aria-labelledby="registered"><h2 id="registered">当サイトに登録した公式発表（復旧から${RESOLVED_TOP_DAYS}日を過ぎたもの）</h2>${old.map((i) => incidentCard(ctx, i))}</section>` : ''}
<section aria-labelledby="cases"><h2 id="cases">報道で伝えられた事例（2024〜2026年）</h2>
${ctx.data.past_cases.map((pc) => html`<article class="case">
<h3>${pc.name}</h3>
<dl class="facts">
<dt>時期</dt><dd>${pc.period}</dd>
<dt>原因（報道による）</dt><dd>${pc.cause}</dd>
<dt>あらまし</dt><dd>${pc.summary}</dd>
<dt>利用者が頼った代わり</dt><dd>${pc.alternatives_used.length ? pc.alternatives_used.join('、') : '—'}</dd>
</dl>
<p class="sub">出典</p>
${sourceList(ctx, pc.sources)}
${pc.service_ids.filter((id) => !ctx.service(id).mostly_unverified).length ? html`<p class="sub">このサイトのページ: ${pc.service_ids.filter((id) => !ctx.service(id).mostly_unverified).map((id, i) => html`${i ? '、' : ''}<a href="${ctx.href(`s/${id}/`)}">${ctx.service(id).name}</a>`)}</p>` : ''}
</article>`)}
</section>`;
  return { path: 'past/', h1: '過去の事例', description: '2024〜2026年に日本で多くの人が困ったサービスの停止の事例と、利用者が頼った代わりの手段（出典つき）。', breadcrumbs: [['', 'トップ']], body };
}

// ---- 固定ページ（content/） ----

function generated(ctx, name, page) {
  const { data } = ctx;
  switch (name) {
    case 'official-domains':
      return html`<p class="sub">各社のページで公式ドメインの一覧が公表されていれば、そちらが正です。サブドメイン（<code>www.</code> などが前に付いたもの）も公式です。</p>
${data.categories.map((cat) => {
        const list = data.services.filter((s) => s.category === cat.id);
        if (!list.length) return '';
        return html`<h3>${cat.name}</h3><ul class="domains">${list.map((s) => html`<li><a href="${ctx.href(`s/${s.id}/`)}">${s.name}</a>: ${s.official_domains === UNVERIFIED || s.mostly_unverified
          ? unverified()
          : html`${s.official_domains.map((d, i) => html`${i ? '、' : ''}${domainText(d)}`)}<span class="note">${verifiedDate(ctx, s.verified_at)}</span>`}</li>`)}</ul>`;
      })}`;
    case 'not-official': {
      const items = data.services.flatMap((s) => s.not_official.map((n) => ({ s, n })));
      if (!items.length) return html`<p>いまはありません。</p>`;
      return html`<ul>${items.map(({ s, n }) => html`<li><code>${n.domain}</code>（${s.name}）: ${n.note}<span class="note">${verifiedDate(ctx, s.verified_at)}</span></li>`)}</ul>`;
    }
    case 'consultation':
      return html`<ul class="alts">${data.consultation.map((p) => html`<li>
<p class="alt-label">${p.name}${p.phone ? html` <span class="phone">${p.phone}</span>` : ''}</p>
<p>${p.detail}</p>
${p.url ? html`<p class="sub">${p.phone ? '根拠のページ: ' : ''}${ctx.ext(p.url, p.phone ? '案内のページを開く' : `${p.name}のサイト`)}</p>` : ''}
<p class="sub">${p.phone || p.url ? '' : '連絡先は当サイトでは未確認のため載せていません。'}${verifiedDate(ctx, p.verified_at)}</p>
</li>`)}</ul>`;
    case 'monitored': {
      const list = data.services.filter((s) => s.monitor.enabled);
      const off = data.services.filter((s) => !s.monitor.enabled);
      return html`<ul>${list.map((s) => html`<li><a href="${ctx.href(`s/${s.id}/`)}">${s.name}</a>: <code>${s.monitor.statuspage_api ?? s.monitor.url}</code>（${s.monitor.statuspage_api ? '状態の API を GET' : s.monitor.method}）</li>`)}</ul>
${off.length ? html`<p>いまは観測していないサービス: ${off.map((s, i) => html`${i ? '、' : ''}<a href="${ctx.href(`s/${s.id}/`)}">${s.name}</a>`)}</p>` : ''}`;
    }
    case 'category-services': {
      const list = data.services.filter((s) => s.category === page.meta.category);
      if (!list.length) throw new Error(`content/${page.file}: category "${page.meta.category}" のサービスがありません`);
      return html`<ul class="services">${list.map((s) => html`<li><a href="${ctx.href(`s/${s.id}/`)}">${s.name}</a></li>`)}</ul>`;
    }
    default:
      throw new Error(`content/${page.file}: 知らない generate "${name}"`);
  }
}

export function contentPage(ctx, page) {
  let text = page.body
    .replace(/<!-- generate:([a-z-]+) -->/g, (_, name) => generated(ctx, name, page).toString())
    .replace(/\{\{root\}\}/g, ctx.root)
    .replace(/\{\{site_url\}\}/g, ctx.site.url.replace(/&/g, '&amp;'))
    .replace(/\{\{link:([a-z0-9-]+)\}\}/g, (_, id) => {
      const l = ctx.data.links.find((x) => x.id === id);
      if (!l) throw new Error(`content/${page.file}: data/links.json に無い id "${id}"`);
      if (!isAllowedLink(l.url, ctx.allowlist)) throw new Error(`許可されていないリンク先です: ${l.url}`);
      return html`<a href="${l.url}">${l.name}</a>`.toString();
    });
  if (/\{\{|<!-- generate:/.test(text)) throw new Error(`content/${page.file}: 置き換えられていない記号があります`);
  return {
    path: page.path,
    h1: page.meta.title,
    description: page.meta.description,
    breadcrumbs: [['', 'トップ']],
    body: raw(text),
  };
}

export function notFoundPage() {
  return {
    path: '404.html',
    noindex: true,
    h1: 'ページが見つかりません',
    description: 'お探しのページは見つかりませんでした。',
    body: html`<p>お探しのページは見つかりませんでした。上の「トップ」から探してください。</p>`,
  };
}

export { SafeHtml };
