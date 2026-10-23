// data/ と content/ の読み込み。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DATA_FILES = ['site', 'categories', 'services', 'incidents', 'past_cases', 'links', 'consultation'];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} を JSON として読めません: ${err.message}`);
  }
}

// content/*.html の先頭のコメントに「key: value」の形で書いた見出し情報を読む。
export function parseContent(text, file) {
  const m = /^<!--\n([\s\S]*?)\n-->\n/.exec(text);
  if (!m) throw new Error(`${file}: 先頭に <!-- title: ... --> の見出し情報がありません`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`${file}: 見出し情報の行の形が違います: ${line}`);
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

// content のファイル名 → 出力先のパス（末尾 /）
export function contentPath(file) {
  const name = file.replace(/\.html$/, '');
  if (name.startsWith('guide-')) return `guide/${name.slice('guide-'.length)}/`;
  return `${name}/`;
}

export function loadContent(root = ROOT) {
  const dir = join(root, 'content');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((file) => {
      const { meta, body } = parseContent(readFileSync(join(dir, file), 'utf8'), `content/${file}`);
      return { file, path: contentPath(file), meta, body };
    });
}

export function loadData(root = ROOT) {
  const data = {};
  for (const name of DATA_FILES) data[name] = readJson(join(root, 'data', `${name}.json`));
  data.content = loadContent(root);
  return data;
}
