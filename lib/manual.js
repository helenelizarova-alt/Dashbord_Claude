// Разбор файлов, загруженных вручную. Фронт читает Excel через SheetJS и присылает массив строк (массив массивов).
// Колонки ищутся по названию, поэтому порядок колонок не важен. Если кабинет переименует колонку — добавьте вариант в aliases.
import { findHeader, toIso, num } from './util.js';
import { wbRealizationRow } from './wb.js';
import { ozKind } from './ozon.js';

const cell = (row, map, k) => (k in map ? row[map[k]] : undefined);

// WB: Финансы → Отчёты → еженедельный детализированный отчёт → Скачать Excel
export function parseWbRealization(rows) {
  const h = findHeader(rows, {
    sku: ['Артикул поставщика'], nmId: ['Код номенклатуры'], name: ['Предмет', 'Название'],
    doc: ['Тип документа'], oper: ['Обоснование для оплаты'], date: ['Дата продажи'], date2: ['Дата заказа покупателем'],
    qty: ['Кол-во'], retail: ['Вайлдберриз реализовал Товар (Пр)'], forPay: ['К перечислению Продавцу за реализованный Товар'],
    delivery: ['Услуги по доставке товара покупателю'], penalty: ['Общая сумма штрафов'], storage: ['Хранение'],
    deduction: ['Удержания'], acceptance: ['Платная приемка', 'Платная приёмка'],
  }, ['oper', 'retail', 'forPay']);
  if (!h) throw new Error('Не нашёл колонки отчёта о реализации («Обоснование для оплаты», «Вайлдберриз реализовал Товар (Пр)», «К перечислению Продавцу…»)');
  const fin = [];
  for (const r of rows.slice(h.idx + 1)) {
    const d = toIso(cell(r, h.map, 'date')) || toIso(cell(r, h.map, 'date2'));
    if (!d) continue;
    fin.push(...wbRealizationRow({
      d, sku: String(cell(r, h.map, 'sku') ?? '').trim(), name: cell(r, h.map, 'name'), nmId: cell(r, h.map, 'nmId'),
      doc: cell(r, h.map, 'doc'), oper: cell(r, h.map, 'oper'), qty: num(cell(r, h.map, 'qty')),
      retail: num(cell(r, h.map, 'retail')), forPay: num(cell(r, h.map, 'forPay')), delivery: num(cell(r, h.map, 'delivery')),
      penalty: num(cell(r, h.map, 'penalty')), storage: num(cell(r, h.map, 'storage')),
      other: num(cell(r, h.map, 'deduction')) + num(cell(r, h.map, 'acceptance')),
    }));
  }
  return withPeriod(fin);
}

// Ozon: Финансы → Начисления (или «Отчёт о начислениях») → Скачать Excel
export function parseOzAccruals(rows) {
  const h = findHeader(rows, {
    date: ['Дата начисления', 'Дата'], type: ['Тип начисления', 'Название услуги', 'Тип'], group: ['Группа услуг'],
    sku: ['Артикул'], ozSku: ['SKU'], name: ['Название товара'], qty: ['Количество'],
    amount: ['Сумма итого, руб', 'Сумма итого', 'Итого, руб', 'Сумма'],
  }, ['date', 'type', 'amount']);
  if (!h) throw new Error('Не нашёл колонки «Дата начисления», «Тип начисления», «Сумма итого»');
  const fin = [];
  for (const r of rows.slice(h.idx + 1)) {
    const d = toIso(cell(r, h.map, 'date')); if (!d) continue;
    const type = `${cell(r, h.map, 'group') ?? ''} ${cell(r, h.map, 'type') ?? ''}`.toLowerCase();
    const amount = num(cell(r, h.map, 'amount'));
    const qty = num(cell(r, h.map, 'qty'));
    const sku = String(cell(r, h.map, 'sku') || cell(r, h.map, 'ozSku') || '—').trim();
    if (!amount) continue;
    let kind;
    if (/возврат/.test(type) && /выручк|продаж|реализац|товар/.test(type)) kind = 'return';
    else if (/выручк|продаж|реализац|за товар/.test(type) && amount > 0) kind = 'revenue';
    else kind = ozKind(type);
    if (kind === 'revenue' || kind === 'return') fin.push({ d, sku, kind, qty, amount: Math.abs(amount) });
    else fin.push({ d, sku, kind, qty: 0, amount: -amount }); // расходы в отчёте со знаком «−»
  }
  return withPeriod(fin);
}

// WB: Цены и скидки → Скачать Excel
export function parseWbPrices(rows) {
  const h = findHeader(rows, { sku: ['Артикул продавца', 'Артикул поставщика'], price: ['Текущая цена'], disc: ['Текущая скидка'], after: ['Цена со скидкой'] }, ['sku', 'price']);
  if (!h) throw new Error('Не нашёл колонки «Артикул продавца» и «Текущая цена»');
  const prices = {};
  for (const r of rows.slice(h.idx + 1)) {
    const sku = String(cell(r, h.map, 'sku') ?? '').trim(); if (!sku) continue;
    const after = num(cell(r, h.map, 'after'));
    prices[sku] = after || Math.round(num(cell(r, h.map, 'price')) * (1 - num(cell(r, h.map, 'disc')) / 100));
  }
  return prices;
}

// Себестоимость: «Артикул» (или «Штрихкод»/«Название») + «Себестоимость»
export function parseCosts(rows) {
  const h = findHeader(rows, { sku: ['Артикул', 'Артикул продавца', 'offer_id'], barcode: ['Штрихкод', 'Баркод'], name: ['Название', 'Наименование'], cost: ['Себестоимость', 'Себест'] }, ['cost']);
  if (!h || !('sku' in h.map || 'barcode' in h.map || 'name' in h.map)) throw new Error('Нужны колонки «Себестоимость» и «Артикул» (или «Штрихкод» / «Название»)');
  const out = { bySku: {}, byBarcode: {}, byName: {} };
  for (const r of rows.slice(h.idx + 1)) {
    const c = num(cell(r, h.map, 'cost')); if (!c) continue;
    const s = String(cell(r, h.map, 'sku') ?? '').trim(), b = String(cell(r, h.map, 'barcode') ?? '').trim(), n = String(cell(r, h.map, 'name') ?? '').trim().toLowerCase();
    if (s) out.bySku[s] = c; if (b) out.byBarcode[b] = c; if (n) out.byName[n] = c;
  }
  return out;
}

// Честный знак: список выкупленных FBS-заказов с кодами маркировки.
// Колонки: КИЗ, Канал (WB/Ozon), № заказа, Артикул, Товар, Дата выкупа.
export function parseKiz(rows) {
  const h = findHeader(rows, { kiz: ['КИЗ', 'Код маркировки', 'sgtin', 'Маркировка'], ch: ['Канал', 'Маркетплейс'], order: ['№ заказа', 'Номер заказа', 'Номер отправления'], sku: ['Артикул'], name: ['Товар', 'Наименование'], date: ['Дата выкупа', 'Дата доставки', 'Дата'] }, ['kiz']);
  if (!h) throw new Error('Не нашёл колонку «КИЗ» (или «Код маркировки»)');
  return rows.slice(h.idx + 1).map((r) => {
    const ch = String(cell(r, h.map, 'ch') ?? '').toLowerCase();
    return { kiz: String(cell(r, h.map, 'kiz') ?? '').trim(), ch: /oz|озон/.test(ch) ? 'ozon' : 'wb', order: String(cell(r, h.map, 'order') ?? ''), sku: String(cell(r, h.map, 'sku') ?? ''), name: String(cell(r, h.map, 'name') ?? ''), d: toIso(cell(r, h.map, 'date')) };
  }).filter((x) => x.kiz && x.d);
}

function withPeriod(fin) {
  if (!fin.length) throw new Error('В файле не нашлось строк с датами');
  const ds = fin.map((x) => x.d).sort();
  return { from: ds[0], to: ds[ds.length - 1], fin };
}
