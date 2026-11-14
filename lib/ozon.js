// Ozon Seller API + Ozon Performance API → нормализованные данные канала (формат описан в wb.js).
// Документация: https://docs.ozon.ru/api/seller и https://docs.ozon.ru/api/performance — сверьте эндпоинты перед продом.
import { fetchJson, toIso, num, addDays, today, chunks, sleep } from './util.js';
import { setSync } from './store.js';

const SELLER = 'https://api-seller.ozon.ru';
const PERF = 'https://api-performance.ozon.ru';

export async function syncOzon(tokens, { days = 90 } = {}) {
  const H = { 'Client-Id': tokens.ozClientId, 'Api-Key': tokens.ozApiKey, 'Content-Type': 'application/json' };
  const post = (p, body, label) => fetchJson(SELLER + p, { method: 'POST', headers: H, body: JSON.stringify(body) }, { label });
  const get = (p, label) => fetchJson(SELLER + p, { headers: H }, { label });
  const from = addDays(today(), -days);
  const out = { products: {}, orders: [], fin: [], ads: [], stocks: [], prices: {}, promos: [], finSource: 'api' };
  const prod = (sku, name, extra = {}) => { if (!sku) return; const p = (out.products[sku] ||= { sku, name: name || sku }); Object.assign(p, extra); if (name && p.name === sku) p.name = name; };
  const ozsku2sku = {}, pid2sku = {};
  let errors = 0;

  // 1. Цены и справочник товаров (offer_id = наш артикул)
  try {
    let cursor = '';
    for (;;) {
      const j = await post('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 1000, cursor }, 'Ozon цены');
      for (const it of j?.items || []) {
        prod(it.offer_id, null, { productId: it.product_id });
        pid2sku[it.product_id] = it.offer_id;
        out.prices[it.offer_id] = num(it.price?.marketing_seller_price || it.price?.price);
      }
      cursor = j?.cursor;
      if (!cursor || !(j?.items || []).length) break;
    }
    setSync('ozon.prices', 'ok', `${Object.keys(out.prices).length} цен`);
  } catch (e) { errors++; setSync('ozon.prices', 'error', e.message); }

  // 2. Остатки по складам
  try {
    for (let offset = 0; ; offset += 1000) {
      const j = await post('/v2/analytics/stock_on_warehouses', { limit: 1000, offset, warehouse_type: 'ALL' }, 'Ozon остатки');
      const rows = j?.result?.rows || [];
      for (const r of rows) {
        prod(r.item_code, r.item_name, { ozSku: r.sku }); ozsku2sku[r.sku] = r.item_code;
        out.stocks.push({ sku: r.item_code, wh: r.warehouse_name, qty: num(r.free_to_sell_amount) + num(r.reserved_amount), inWay: num(r.promised_amount) });
      }
      if (rows.length < 1000) break;
    }
    setSync('ozon.stocks', 'ok', `${out.stocks.length} строк`);
  } catch (e) { errors++; setSync('ozon.stocks', 'error', e.message); }

  // 3. Заказы (аналитика по дням и SKU)
  try {
    for (let offset = 0; ; offset += 1000) {
      const j = await post('/v1/analytics/data', { date_from: from, date_to: today(), metrics: ['revenue', 'ordered_units'], dimension: ['sku', 'day'], limit: 1000, offset }, 'Ozon аналитика');
      const rows = j?.result?.data || [];
      for (const r of rows) {
        const [s, d] = r.dimensions;
        const sku = ozsku2sku[s.id] || s.id;
        prod(sku, s.name, { ozSku: s.id });
        out.orders.push({ d: toIso(d.id), sku, qty: num(r.metrics[1]), sum: num(r.metrics[0]) });
      }
      if (rows.length < 1000) break;
      await sleep(1000); // лимит аналитики — несколько запросов в минуту
    }
    setSync('ozon.orders', 'ok', `${out.orders.length} строк`);
  } catch (e) { errors++; setSync('ozon.orders', 'error', e.message); }

  // 4. Финансы: список транзакций, не больше месяца за запрос
  try {
    let n = 0;
    for (const [a, b] of chunks(from, today(), 28)) {
      for (let page = 1; ; page++) {
        const j = await post('/v3/finance/transaction/list', { filter: { date: { from: `${a}T00:00:00.000Z`, to: `${b}T23:59:59.999Z` }, operation_type: [], posting_number: '', transaction_type: 'all' }, page, page_size: 1000 }, 'Ozon финансы');
        const ops = j?.result?.operations || [];
        for (const op of ops) { out.fin.push(...ozOperation(op, ozsku2sku)); n++; }
        if (page >= (j?.result?.page_count || 1)) break;
      }
    }
    setSync('ozon.finance', 'ok', `${n} операций`);
  } catch (e) { errors++; setSync('ozon.finance', 'error', e.message); }

  // 5. Акции
  try {
    const j = await get('/v1/actions', 'Ozon акции');
    for (const a of (j?.result || []).slice(0, 15)) {
      const promo = { id: String(a.id), name: a.title, from: toIso(a.date_start), to: toIso(a.date_end), participating: num(a.participating_products_count) > 0, items: [] };
      for (const [path, inAction] of [['/v1/actions/products', true], ['/v1/actions/candidates', false]]) {
        try {
          const p = await post(path, { action_id: a.id, limit: 100, offset: 0 }, 'Ozon товары акции');
          for (const x of p?.result?.products || []) {
            const sku = pid2sku[x.id]; if (!sku) continue;
            promo.items.push({ sku, actionPrice: num(x.action_price || x.max_action_price), inAction });
          }
        } catch { /* ignore */ }
      }
      out.promos.push(promo);
    }
    setSync('ozon.promos', 'ok', `${out.promos.length} акций`);
  } catch (e) { setSync('ozon.promos', 'error', e.message); }

  // 6. Реклама (Ozon Performance) — отдельные ключи
  if (tokens.ozPerfClientId && tokens.ozPerfSecret) {
    try { out.ads = await syncOzonPerformance(tokens, Math.min(days, 30)); setSync('ozon.ads', 'ok', `${new Set(out.ads.map((x) => x.cid)).size} кампаний`); }
    catch (e) { setSync('ozon.ads', 'error', e.message); }
  } else setSync('ozon.ads', 'none', 'нет ключей Performance — реклама берётся из финансовых операций');

  setSync('ozon', errors ? (errors >= 2 ? 'error' : 'partial') : 'ok', errors ? 'часть данных не загрузилась' : 'синхронизировано');
  return out;
}

// Классификация услуги/операции Ozon по названию
export function ozKind(name) {
  const s = String(name || '').toLowerCase();
  if (/звезд|звёзд/.test(s)) return 'stars';
  if (/штраф|неустойк/.test(s)) return 'penalty';
  if (/продвиж|реклам|трафарет|оплата за клик|оплата за заказ|бонус.*продав|premium|премиум/.test(s)) return 'ads';
  if (/хранен|размещен/.test(s)) return 'storage';
  if (/вознагражд|комисс|эквайр/.test(s)) return 'commission';
  if (/логист|доставк|магистрал|последн.*мил|обработк|сборк|выдач|отправлен|кросс|возвратн.*поток|обратн/.test(s)) return 'logistics';
  return 'other';
}

function ozOperation(op, ozsku2sku) {
  const d = toIso(op.operation_date);
  const item = op.items?.[0];
  const sku = item ? (ozsku2sku[item.sku] || String(item.sku)) : '—';
  const qty = op.items?.length || 0;
  const rows = [];
  const t = op.type;
  if (t === 'orders' || t === 'returns') {
    const isRet = t === 'returns';
    if (op.accruals_for_sale) rows.push({ d, sku, kind: isRet ? 'return' : 'revenue', qty, amount: Math.abs(num(op.accruals_for_sale)) });
    if (op.sale_commission) rows.push({ d, sku, kind: 'commission', qty: 0, amount: -num(op.sale_commission) });
    for (const s of op.services || []) if (s.price) rows.push({ d, sku, kind: ozKind(s.name) === 'other' ? 'logistics' : ozKind(s.name), qty: 0, amount: -num(s.price) });
  } else {
    const amount = -num(op.amount); // расходы приходят со знаком минус
    if (amount) rows.push({ d, sku, kind: amount < 0 ? 'other' : ozKind(op.operation_type_name), qty: 0, amount });
  }
  return rows;
}

async function syncOzonPerformance(tokens, days) {
  const tok = await fetchJson(`${PERF}/api/client/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: tokens.ozPerfClientId, client_secret: tokens.ozPerfSecret, grant_type: 'client_credentials' }),
  }, { label: 'Ozon Performance токен' });
  const H = { headers: { Authorization: `Bearer ${tok.access_token}` } };
  const camps = await fetchJson(`${PERF}/api/client/campaign`, H, { label: 'Ozon кампании' });
  const list = camps?.list || [];
  const names = Object.fromEntries(list.map((c) => [String(c.id), c.title]));
  const ids = list.filter((c) => c.state !== 'CAMPAIGN_STATE_ARCHIVED').map((c) => c.id);
  const out = [];
  const from = addDays(today(), -days);
  for (let i = 0; i < ids.length; i += 10) {
    const q = ids.slice(i, i + 10).map((id) => `campaignIds=${id}`).join('&');
    const st = await fetchJson(`${PERF}/api/client/statistics/daily/json?${q}&dateFrom=${from}&dateTo=${today()}`, H, { label: 'Ozon статистика рекламы' });
    for (const r of st?.rows || []) out.push({ d: toIso(r.date), cid: String(r.id), name: names[String(r.id)] || r.title || `Кампания ${r.id}`, sku: null, spend: num(r.moneySpent), views: num(r.views), clicks: num(r.clicks), orders: num(r.orders), sum: num(r.ordersMoney) });
  }
  return out;
}
