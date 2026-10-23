// 日付・時刻の扱い。表示はすべて日本時間（+09:00）。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isValidDate(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isValidDateTime(value) {
  return typeof value === 'string' && DATETIME_RE.test(value) && isValidDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));
}

// 日本時間での日付（YYYY-MM-DD）
export function jstDate(date) {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// 日本時間での「YYYY-MM-DD HH:MM」
export function jstDateTime(date) {
  const iso = new Date(date.getTime() + JST_OFFSET_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// 日付（YYYY-MM-DD）どうしの日数の差（b − a）
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// 日付または日時の文字列を表示用にする
export function formatWhen(value) {
  if (isValidDate(value)) return value;
  if (isValidDateTime(value)) return jstDateTime(new Date(value)) + '（日本時間）';
  return String(value);
}
