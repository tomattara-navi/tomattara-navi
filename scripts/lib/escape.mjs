// HTML の値のエスケープ（§2.4-24）。
// 生成する HTML はすべて `html` タグ付きテンプレートで組み立てる。
// 埋め込んだ値は SafeHtml でない限り必ずエスケープされる。

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export class SafeHtml {
  constructor(value) {
    this.value = String(value);
  }
  toString() {
    return this.value;
  }
}

// 信頼できる HTML 断片（content/ の本文など）にだけ使う。
export function raw(value) {
  return new SafeHtml(value);
}

function interpolate(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += interpolate(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}
