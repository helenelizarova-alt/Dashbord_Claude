// Wildberries API → нормализованные данные канала.
// Документация: https://dev.wildberries.ru — перед продом сверьте эндпоинты и лимиты, WB их периодически меняет.
//
// Формат канала (одинаковый для WB и Ozon):
//   products: {sku: {sku, name, barcode, nmId}}
//   orders:   [{d, sku, qty, sum}]                       — заказано
//   fin:      [{d, sku, kind, qty, amount}]              — финансы: revenue/return/commission/logistics/penalty/storage/ads/stars/other
//   ads:      [{d, cid, name, sku, spend, views, clicks, orders, sum}]
//   stocks:   [{sku, wh, qty, inWay}]
//   prices:   {sku: price}
//   promos:   [{id, name, from, to, participating, items: [{sku, actionPrice, inAction}]}]
import { fetchJson, toIso, num, addDays, today, sleep } from './util.js';
import { setSync } from './store.js';

const STAT = 'https://statistics-api.wildberries.ru';
const ADV = 'https://advert-api.wildberries.ru';
const PRICES = 'https://discounts-prices-api.wildberries.ru';
const CAL = 'https://dp-calendar-api.wildberries.ru';

export async function syncWb(tokens, { days = 90 } = {}) {
  const H = { headers: { Authorization: tokens.wb } };
  const from = addDays(today(), -days);
  const out = { products: {}, orders: [], fin: [], ads: [], stocks: [], prices: {}, promos: [], finSource: 'api' };
  const prod = (sku, name, nmId, barcode) => {
    if (!sku) return;
    const p = (out.products[sku] ||= { sku, name: name || sku });
    if (nmId) p.nmId = nmId;
    if (barcode) p.barcode = barcode;
    if (name && p.name === sku) p.name = name;
  };
  const nm2sku = {};
  let errors = 0;

  // 1. Заказы
  try {
    const rows = await fetchJson(`${STAT}/api/v1/supplier/orders?dateFrom=${from}`, H, { label: 'WB заказы' });
    for (const r of rows || []) {
      if (r.isCancel) continue;
      const sku = r.supplierArticle;
      prod(sku, r.subject, r.nmId, r.barcode); nm2sku[r.nmId] = sku;
      out.orders.push({ d: toIso(r.date), sku, qty: 1, sum: num(r.priceWithDisc) });
    }
    setSync('wb.orders', 'ok', `${out.orders.length} заказов`);
  } catch (e) { errors++; setSync('wb.orders', 'error', e.message); }

  // 2. Остатки
  try {
    const rows = await fetchJson(`${STAT}/api/v1/supplier/stocks?dateFrom=2019-06-20`, H, { label: 'WB остатки' });
    for (const r of rows || []) {
      const sku = r.supplierArticle;
      prod(sku, r.subject, r.nmId, r.barcode); nm2sku[r.nmId] = sku;
      out.stocks.push({ sku, wh: r.warehouseName, qty: num(r.quantity), inWay: num(r.inWayToClient) + num(r.inWayFromClient) });
    }
    setSync('wb.stocks', 'ok', `${out.stocks.length} строк`);
  } catch (e) { errors++; setSync('wb.stocks', 'error', e.message); }

  // 3. Отчёт о реализации (финансы). Лимит жёсткий — при 429 можно загрузить Excel вручную.
  try {
    let rrdid = 0, n = 0;
    for (;;) {
      const url = `${STAT}/api/v5/supplier/reportDetailByPeriod?dateFrom=${from}&dateTo=${today()}&limit=100000&rrdid=${rrdid}`;
      const rows = await fetchJson(url, H, { label: 'WB реализация', retries: 2 });
      if (!rows || !rows.length) break;
      for (const r of rows) out.fin.push(...wbRealizationRow({
        d: toIso(r.sale_dt || r.rr_dt), sku: r.sa_name, name: r.subject_name, nmId: r.nm_id,
        doc: r.doc_type_name, oper: r.supplier_oper_name, qty: num(r.quantity),
        retail: num(r.retail_amount), forPay: num(r.ppvz_for_pay), delivery: num(r.delivery_rub),
        penalty: num(r.penalty), storage: num(r.storage_fee), other: num(r.deduction) + num(r.acceptance),
      }, prod));
      n += rows.length;
      rrdid = rows[rows.length - 1].rrd_id;
      if (rows.length < 100000) break;
      await sleep(61000); // 1 запрос в минуту
    }
    setSync('wb.realization', n ? 'ok' : 'partial', n ? `${n} строк` : 'отчёт пуст — загрузите Excel вручную');
  } catch (e) { setSync('wb.realization', e.status == 429 ? 'partial' : 'error', e.status == 429 ? 'лимит 429 — загрузите еженедельный отчёт Excel вручную' : e.message); }

  // 4. Цены
  try {
    for (let offset = 0; ; offset += 1000) {
      const j = await fetchJson(`${PRICES}/api/v2/list/goods/filter?limit=1000&offset=${offset}`, H, { label: 'WB цены' });
      const list = j?.data?.listGoods || [];
      for (const g of list) {
        const s = g.sizes?.[0];
        if (g.vendorCode && s) { out.prices[g.vendorCode] = num(s.discountedPrice || s.price); prod(g.vendorCode, null, g.nmID); nm2sku[g.nmID] = g.vendorCode; }
      }
      if (list.length < 1000) break;
    }
    setSync('wb.prices', 'ok', `${Object.keys(out.prices).length} цен`);
  } catch (e) { setSync('wb.prices', 'error', e.message); }

  // 5. Реклама (WB Продвижение). Нужен токен с категорией «Продвижение» — можно отдельный tokens.wbAdv.
  try {
    const HA = { headers: { Authorization: tokens.wbAdv || tokens.wb } };
    const cnt = await fetchJson(`${ADV}/adv/v1/promotion/count`, HA, { label: 'WB кампании' });
    const ids = (cnt?.adverts || []).flatMap((g) => (g.advert_list || []).map((a) => a.advertId));
    const names = {};
    for (let i = 0; i < ids.length; i += 50) {
      const info = await fetchJson(`${ADV}/adv/v1/promotion/adverts`, { method: 'POST', headers: { ...HA.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(ids.slice(i, i + 50)) }, { label: 'WB кампании' });
      for (const a of info || []) names[a.advertId] = a.name;
    }
    const begin = addDays(today(), -Math.min(days, 30));
    for (let i = 0; i < ids.length; i += 50) {
      // Статистика кампаний. Если WB сменил версию — поправьте путь здесь.
      const st = await fetchJson(`${ADV}/adv/v3/fullstats?ids=${ids.slice(i, i + 50).join(',')}&beginDate=${begin}&endDate=${today()}`, HA, { label: 'WB статистика рекламы' });
      for (const c of st || []) for (const d of c.days || []) {
        const nms = (d.apps || []).flatMap((a) => a.nms || []);
        if (nms.length) for (const x of nms) out.ads.push({ d: toIso(d.date), cid: String(c.advertId), name: names[c.advertId] || `Кампания ${c.advertId}`, sku: nm2sku[x.nmId] || null, spend: num(x.sum), views: num(x.views), clicks: num(x.clicks), orders: num(x.orders), sum: num(x.sum_price) });
        else out.ads.push({ d: toIso(d.date), cid: String(c.advertId), name: names[c.advertId] || `Кампания ${c.advertId}`, sku: null, spend: num(d.sum), views: num(d.views), clicks: num(d.clicks), orders: num(d.orders), sum: num(d.sum_price) });
      }
      if (i + 50 < ids.length) await sleep(61000);
    }
    setSync('wb.ads', 'ok', `${ids.length} кампаний`);
  } catch (e) { setSync('wb.ads', 'error', e.message); }

  // 6. Акции календаря WB
  try {
    const start = `${today()}T00:00:00Z`, end = `${addDays(today(), 45)}T23:59:59Z`;
    const j = await fetchJson(`${CAL}/api/v1/calendar/promotions?startDateTime=${start}&endDateTime=${end}&allPromo=true&limit=100&offset=0`, H, { label: 'WB акции' });
    for (const p of (j?.data?.promotions || []).slice(0, 10)) {
      const promo = { id: String(p.id), name: p.name, from: toIso(p.startDateTime), to: toIso(p.endDateTime), participating: false, items: [] };
      for (const inAction of [true, false]) {
        try {
          const n = await fetchJson(`${CAL}/api/v1/calendar/promotions/nomenclatures?promotionID=${p.id}&inAction=${inAction}&limit=1000&offset=0`, H, { label: 'WB товары акции', retries: 1 });
          for (const x of n?.data?.nomenclatures || []) {
            const sku = nm2sku[x.id]; if (!sku) continue;
            promo.items.push({ sku, actionPrice: num(x.planPrice), inAction: !!x.inAction });
            if (x.inAction) promo.participating = true;
          }
        } catch { /* у авто-акций списка товаров нет */ }
        await sleep(700);
      }
      out.promos.push(promo);
    }
    setSync('wb.promos', 'ok', `${out.promos.length} акций`);
  } catch (e) { setSync('wb.promos', 'error', e.message); }

  setSync('wb', errors ? (errors >= 2 ? 'error' : 'partial') : 'ok', errors ? 'часть данных не загрузилась' : 'синхронизировано');
  return out;
}

// Одна строка отчёта о реализации → строки fin. Используется и для API, и для Excel.
export function wbRealizationRow(r, prod) {
  if (!r.d) return [];
  const sku = r.sku || (r.nmId ? String(r.nmId) : '—');
  if (prod) prod(sku, r.name, r.nmId);
  const rows = [];
  const doc = String(r.doc || '').toLowerCase(), oper = String(r.oper || '').toLowerCase();
  const isReturn = doc.includes('возврат') || oper.startsWith('возврат');
  if (oper.includes('продажа') || oper.includes('возврат') || oper.includes('компенсац') || (!oper && r.retail)) {
    if (r.retail) {
      rows.push({ d: r.d, sku, kind: isReturn ? 'return' : 'revenue', qty: r.qty, amount: Math.abs(r.retail) });
      // вознаграждение WB = розничная сумма − к перечислению продавцу
      const com = Math.abs(r.retail) - Math.abs(r.forPay);
      if (com) rows.push({ d: r.d, sku, kind: 'commission', qty: 0, amount: isReturn ? -com : com });
    }
  }
  if (r.delivery) rows.push({ d: r.d, sku, kind: 'logistics', qty: 0, amount: r.delivery });
  if (r.penalty) rows.push({ d: r.d, sku, kind: 'penalty', qty: 0, amount: r.penalty });
  if (r.storage) rows.push({ d: r.d, sku, kind: 'storage', qty: 0, amount: r.storage });
  if (r.other) rows.push({ d: r.d, sku, kind: 'other', qty: 0, amount: r.other });
  return rows;
}
