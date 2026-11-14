// Общие помощники: даты, числа, HTTP с повторами при 429, поиск заголовков в Excel.

export const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => iso(new Date());
export const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
export const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 864e5) + 1; // включительно
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Приводит дату из API/Excel к YYYY-MM-DD. Понимает ISO, "дд.мм.гггг" и серийные даты Excel.
export function toIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { // серийная дата Excel
    const d = new Date(Math.round((v - 25569) * 864e5));
    return iso(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) return `${m[3].length == 2 ? '20' + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}`;
  const d = new Date(s);
  return isNaN(d) ? null : iso(d);
}

// "1 234,56" → 1234.56
export function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (v == null) return 0;
  const s = String(v).replace(/\s| /g, '').replace(',', '.').replace(/[^\d.\-eE]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);
export const round = (n, k = 0) => { const p = 10 ** k; return Math.round((n || 0) * p) / p; };
export const groupBy = (arr, key) => {
  const m = new Map();
  for (const x of arr) { const k = typeof key === 'function' ? key(x) : x[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
};

// Делит период на куски не длиннее maxDays (у Ozon финансы — не больше месяца за запрос).
export function chunks(from, to, maxDays) {
  const out = [];
  let a = from;
  while (a <= to) { let b = addDays(a, maxDays - 1); if (b > to) b = to; out.push([a, b]); a = addDays(b, 1); }
  return out;
}

// HTTP-запрос с повтором при 429 / 5xx. Учитывает Retry-After и X-Ratelimit-Retry (WB).
export async function fetchJson(url, opts = {}, { retries = 4, label = '' } = {}) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
    } catch (e) {
      if (i >= retries) throw new Error(`${label || url}: сеть недоступна (${e.message})`);
      await sleep(2000 * (i + 1));
      continue;
    }
    if (res.ok) {
      const t = await res.text();
      return t ? JSON.parse(t) : null;
    }
    if ((res.status == 429 || res.status >= 500) && i < retries) {
      const ra = Number(res.headers.get('retry-after') || res.headers.get('x-ratelimit-retry')) || 0;
      await sleep(Math.min(65000, Math.max(ra * 1000, 3000 * 2 ** i)));
      continue;
    }
    const body = (await res.text()).slice(0, 300);
    const err = new Error(`${label || url}: HTTP ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
}

// Находит строку заголовков в таблице (массив массивов) и возвращает {idx, map}
// map: ключ → номер колонки. aliases: {ключ: [варианты названия, ...]} (сравнение по вхождению, без регистра).
export function findHeader(rows, aliases, required = []) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cells = (rows[r] || []).map(norm);
    const map = {};
    for (const [key, list] of Object.entries(aliases)) {
      // сначала точное совпадение, потом вхождение
      let c = cells.findIndex((x) => list.some((a) => x === norm(a)));
      if (c < 0) c = cells.findIndex((x) => x && list.some((a) => x.includes(norm(a))));
      if (c >= 0) map[key] = c;
    }
    if (required.every((k) => k in map)) return { idx: r, map };
  }
  return null;
}
