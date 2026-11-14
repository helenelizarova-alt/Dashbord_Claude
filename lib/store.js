// Хранилище в одном JSON-файле data/db.json. Токены лежат только здесь и никогда не уходят во фронт.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DIR, 'db.json');

export const DEFAULT_SETTINGS = {
  taxMode: 'income',        // 'income' — УСН доходы (% от выручки), 'profit' — УСН доходы−расходы (% от прибыли)
  taxPct: 6,
  fixedMonthly: 150000,     // постоянные расходы в месяц, ₽ (делятся по доле выручки каналов)
  targetMarginPct: 25,      // целевая маржа, %
  planMonth: 3000000,       // план выручки на месяц, ₽
  // Оценки на дни, за которые ещё нет финансового отчёта (WB отдаёт реализацию с задержкой ~неделю)
  wbCommissionPct: 25, wbLogisticsPerUnit: 85, wbBuyoutPct: 80,
  ozCommissionPct: 22, ozLogisticsPerUnit: 95, ozBuyoutPct: 90,
  leadTimeDays: 21,         // срок производства + доставки до склада МП
  safetyDays: 14,           // страховой запас
  overstockDays: 120,       // больше — затоварка
  drrMaxPct: 15,            // ДРР выше — кампания в «Требуют внимания»
  kizDeadlineDays: 3,       // рабочих дней на вывод КИЗ из оборота после выкупа (сверьте с текущими правилами ГИС МТ)
};

const EMPTY = {
  settings: DEFAULT_SETTINGS,
  tokens: {},               // wb, wbAdv, ozClientId, ozApiKey, ozPerfClientId, ozPerfSecret
  data: { wb: null, ozon: null },   // нормализованные данные из API
  manual: { wbFin: [], ozFin: [], wbPrices: null, costs: null, kiz: [] },
  kizDone: {},              // КИЗ → дата отметки «выведен»
  supplies: [],             // плановые поставки (вручную)
  tasks: [],
  sync: {},                 // источник → {status, msg, at}
};

let db;
export function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = structuredClone(EMPTY); }
  for (const [k, v] of Object.entries(EMPTY)) if (db[k] == null) db[k] = structuredClone(v);
  db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
  db.manual = { ...EMPTY.manual, ...db.manual };
  return db;
}

let timer;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 200);
}

export function setSync(key, status, msg = '') {
  load().sync[key] = { status, msg, at: new Date().toISOString() };
  save();
}
