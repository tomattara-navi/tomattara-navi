// 生成: data/ と content/ → dist/（静的な HTML）
//   node scripts/build.mjs
// 環境変数 SITE_URL でサイトの URL（末尾 /）を上書きできる（既定は data/site.json の url）。
import { mkdirSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadData, ROOT } from './lib/data.mjs';
import { validate } from './validate.mjs';
import { linkAllowlist } from './lib/links.mjs';
import { jstDate, jstDateTime } from './lib/time.mjs';
import { Ctx, layout, topPage, servicePage, pastPage, contentPage, notFoundPage } from './lib/render.mjs';

function relRoot(path) {
  const depth = path.split('/').length - 1;
  return '../'.repeat(depth);
}

export function build({ root = ROOT, outDir = join(root, 'dist'), now = new Date(), siteUrl = process.env.SITE_URL, data = loadData(root) } = {}) {
  if (siteUrl) data = { ...data, site: { ...data.site, url: siteUrl } };
  const today = jstDate(now);
  const { errors } = validate(data, { today });
  if (errors.length) throw new Error(`データに誤りがあります（node scripts/validate.mjs で確かめてください）:\n${errors.join('\n')}`);

  const allowlist = linkAllowlist(data);
  const generatedAt = jstDateTime(now);
  // [出力先のパス, ページを作る関数]
  const pages = [
    ['', (ctx) => topPage(ctx)],
    ...data.services.map((s) => [`s/${s.id}/`, (ctx) => servicePage(ctx, s)]),
    ...data.content.map((c) => [c.path, (ctx) => contentPage(ctx, c)]),
    ['past/', (ctx) => pastPage(ctx)],
  ];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const written = [];
  const writePage = (page, ctx) => {
    const file = page.path.endsWith('/') || page.path === '' ? join(page.path, 'index.html') : page.path;
    mkdirSync(join(outDir, dirname(file)), { recursive: true });
    writeFileSync(join(outDir, file), layout(ctx, page));
    written.push(page.path);
  };

  for (const [path, make] of pages) {
    const ctx = new Ctx({ data, allowlist, root: relRoot(path), today, generatedAt });
    const page = make(ctx);
    if (page.path !== path) throw new Error(`ページのパスが合いません: ${page.path} / ${path}`);
    writePage(page, ctx);
  }

  // 404 はどの深さの URL でも出るので、サイトの根からの絶対パスで書く
  const base = new URL(data.site.url).pathname;
  writePage(notFoundPage(), new Ctx({ data, allowlist, root: base, today, generatedAt }));

  // assets
  mkdirSync(join(outDir, 'assets'), { recursive: true });
  for (const f of readdirSync(join(root, 'assets'))) copyFileSync(join(root, 'assets', f), join(outDir, 'assets', f));

  // sitemap.xml / robots.txt
  const urls = written.filter((p) => p !== '404.html').map((p) => `  <url><loc>${data.site.url}${p}</loc></url>`);
  writeFileSync(join(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  writeFileSync(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${data.site.url}sitemap.xml\n`);

  return { outDir, pages: written };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outDir, pages } = build();
  console.log(`生成: ${pages.length} ページ → ${outDir}`);
}
