// Демо-данные в том же формате, что и данные из API. Включаются для канала, у которого нет ключей и загруженных отчётов.
import { addDays, today, round } from './util.js';

const CATALOG = [
  ['SRM-001', 'Сыворотка с витамином C, 30 мл', 1290, 310],
  ['CRM-014', 'Крем для лица увлажняющий, 50 мл', 990, 240],
  ['TNK-020', 'Тоник для лица с AHA, 200 мл', 690, 190],
  ['MSK-033', 'Маска тканевая, набор 10 шт', 590, 260],
  ['SHM-041', 'Шампунь бессульфатный, 400 мл', 790, 180],
  ['BLM-042', 'Бальзам для волос, 300 мл', 750, 170],
  ['OIL-050', 'Масло для волос, 100 мл', 1190, 420],
  ['SPF-060', 'Солнцезащитный крем SPF50, 50 мл', 1490, 380],
  ['LIP-071', 'Бальзам для губ, 3 шт', 450, 210],
  ['GEL-080', 'Гель для умывания, 250 мл', 650, 150],
  ['SCR-090', 'Скраб для тела кофейный, 300 г', 890, 330],
  ['HND-101', 'Крем для рук, набор 3 шт', 690, 340],
];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function demoCosts() {
  return { bySku: Object.fromEntries(CATALOG.map(([s, , , c]) => [s, c])), byBarcode: {}, byName: {} };
}

export function demoChannel(ch, days = 120) {
  const R = rng(ch === 'wb' ? 7 : 13);
  const k = ch === 'wb' ? 1 : 0.6;                      // Ozon в демо поменьше
  const com = ch === 'wb' ? 0.24 : 0.2, logU = ch === 'wb' ? 80 : 95;
  const out = { products: {}, orders: [], fin: [], ads: [], stocks: [], prices: {}, promos: [], finSource: 'api', demo: true };
  const end = today();
  const finLag = ch === 'wb' ? 6 : 1;                   // у WB финотчёт отстаёт ~неделю
  CATALOG.forEach(([sku, name, price], i) => {
    out.products[sku] = { sku, name };
    const p = round(price * (ch === 'wb' ? 1 : 1.04));
    out.prices[sku] = p;
    const base = (2 + ((i * 7) % 11)) * k;
    const trend = i % 4 === 0 ? 1.01 : i % 5 === 0 ? 0.992 : 1.002;
    for (let t = days; t >= 0; t--) {
      const d = addDays(end, -t);
      const season = 1 + 0.25 * Math.sin((days - t) / 9 + i);
      const qty = Math.max(0, Math.round(base * season * trend ** (days - t) * (0.6 + R() * 0.8)));
      if (!qty) continue;
      out.orders.push({ d, sku, qty, sum: qty * p });
      if (t < finLag) continue;
      const buy = Math.round(qty * (ch === 'wb' ? 0.8 : 0.9)), ret = Math.round(qty * (R() < 0.3 ? 0.08 : 0));
      if (buy) {
        out.fin.push({ d, sku, kind: 'revenue', qty: buy, amount: buy * p });
        out.fin.push({ d, sku, kind: 'commission', qty: 0, amount: round(buy * p * com) });
        out.fin.push({ d, sku, kind: 'logistics', qty: 0, amount: buy * logU + (qty - buy) * 50 });
      }
      if (ret) out.fin.push({ d, sku, kind: 'return', qty: ret, amount: ret * p });
      if (R() < 0.04) out.fin.push({ d, sku, kind: 'penalty', qty: 0, amount: round(200 + R() * 800) });
      if (t % 7 === 0) out.fin.push({ d, sku, kind: 'storage', qty: 0, amount: round(30 + R() * 120) });
      if (ch === 'ozon' && R() < 0.15) out.fin.push({ d, sku, kind: 'stars', qty: 0, amount: round(qty * p * 0.03) });
    }
    // остатки: часть товаров кончается, часть затоварена
    const daily = base * 1.1;
    const cover = [5, 18, 40, 70, 160, 12, 30, 220, 9, 55, 90, 25][i];
    const whs = ch === 'wb' ? ['Коледино', 'Электросталь', 'Казань'] : ['Хоругвино', 'Тверь', 'Новосибирск'];
    const total = Math.round(daily * cover);
    whs.forEach((wh, j) => out.stocks.push({ sku, wh, qty: Math.round(total * [0.5, 0.3, 0.2][j]), inWay: j === 0 ? Math.round(daily * 2) : 0 }));
  });
  // реклама
  const camps = ch === 'wb'
    ? [['101', 'Аукцион · Сыворотка', 'SRM-001', 0.09], ['102', 'Аукцион · Крем', 'CRM-014', 0.14], ['103', 'Автокампания · SPF', 'SPF-060', 0.31], ['104', 'Аукцион · Шампунь', 'SHM-041', 0.07]]
    : [['201', 'Трафареты · Масло', 'OIL-050', 0.12], ['202', 'Поиск · Маски', 'MSK-033', 0.27], ['203', 'Трафареты · Скраб', 'SCR-090', 0.08]];
  for (const [cid, name, sku, drr] of camps) for (let t = 30; t >= 0; t--) {
    const d = addDays(end, -t);
    const views = Math.round(3000 + R() * 4000), clicks = Math.round(views * (0.025 + R() * 0.02)), orders = Math.round(clicks * (0.04 + R() * 0.03));
    const sumO = orders * out.prices[sku];
    out.ads.push({ d, cid, name, sku, spend: round(sumO * drr * (0.8 + R() * 0.4)), views, clicks, orders, sum: sumO });
  }
  // акции
  const pr = (id, name, from, to, part, skus, disc) => out.promos.push({ id, name, from: addDays(end, from), to: addDays(end, to), participating: part, items: skus.map((s, j) => ({ sku: s, actionPrice: round(out.prices[s] * (1 - disc - j * 0.02)), inAction: part && j < 2 })) });
  if (ch === 'wb') {
    pr('w1', 'Распродажа «Чёрная пятница»', 5, 12, false, ['SRM-001', 'CRM-014', 'SPF-060', 'OIL-050', 'GEL-080'], 0.25);
    pr('w2', 'Неделя ухода за волосами', -2, 5, true, ['SHM-041', 'BLM-042', 'OIL-050'], 0.12);
  } else {
    pr('o1', 'Ozon: Чёрная пятница', 5, 12, false, ['SRM-001', 'MSK-033', 'SCR-090', 'HND-101'], 0.22);
    pr('o2', 'Ozon: Товары дня', 0, 2, true, ['LIP-071', 'TNK-020'], 0.1);
  }
  return out;
}

export function demoKiz() {
  const R = rng(99), out = [];
  for (let i = 0; i < 18; i++) {
    const [sku, name] = CATALOG[i % CATALOG.length];
    const kiz = '010460' + String(Math.floor(R() * 1e10)).padStart(10, '0') + '21' + R().toString(36).slice(2, 15);
    out.push({ kiz, ch: i % 3 ? 'wb' : 'ozon', order: String(4100000000 + Math.floor(R() * 9e8)), sku, name, d: addDays(today(), -Math.floor(R() * 7)) });
  }
  return out;
}
