// Все расчёты дашборда. На вход — база, на выход — готовая модель для фронта (фронт только рисует).
import { addDays, today, daysBetween, parseIso, iso, sum, round, groupBy } from './util.js';
import { demoChannel, demoCosts, demoKiz } from './demo.js';
import { tokens } from './env.js';

const CH = ['wb', 'ozon'];
export const CH_NAME = { wb: 'Wildberries', ozon: 'Ozon' };
const demoCache = {};

const hasToken = (db, ch) => { const t = tokens(); return ch === 'wb' ? !!t.wb : !!(t.ozClientId && t.ozApiKey); };

// Данные канала: API + ручные отчёты (ручной отчёт заменяет API за свой период) либо демо.
export function channelData(db, ch) {
  const manualFin = db.manual[ch === 'wb' ? 'wbFin' : 'ozFin'] || [];
  const api = db.data[ch];
  if (!api && !hasToken(db, ch) && !manualFin.length) return (demoCache[ch] ||= demoChannel(ch));
  const base = api || { products: {}, orders: [], fin: [], ads: [], stocks: [], prices: {}, promos: [] };
  const inManual = (d) => manualFin.some((r) => d >= r.from && d <= r.to);
  const fin = base.fin.filter((x) => !inManual(x.d)).concat(manualFin.flatMap((r) => r.fin));
  const products = { ...base.products };
  for (const x of fin) if (x.sku && x.sku !== '—' && !products[x.sku]) products[x.sku] = { sku: x.sku, name: x.sku };
  const prices = ch === 'wb' ? { ...(db.manual.wbPrices || {}), ...base.prices } : base.prices;
  return { ...base, fin, products, prices, demo: false, finManual: manualFin.length > 0 };
}

function costTable(db, chans) {
  const demo = chans.some((c) => c.demo) ? demoCosts() : { bySku: {}, byBarcode: {}, byName: {} };
  const m = db.manual.costs || {};
  return { bySku: { ...demo.bySku, ...m.bySku }, byBarcode: { ...m.byBarcode }, byName: { ...m.byName } };
}
const costOf = (T, p) => T.bySku[p.sku] ?? (p.barcode && T.byBarcode[p.barcode]) ?? T.byName[String(p.name || '').toLowerCase()] ?? null;

function addWorkDays(d, n) {
  let x = d, k = 0;
  while (k < n) { x = addDays(x, 1); const w = parseIso(x).getDay(); if (w !== 0 && w !== 6) k++; }
  return x;
}

// Агрегация по SKU за период [a, b]. Дни без финотчёта оцениваются по заказам и настройкам.
function aggregate(cd, ch, S, a, b) {
  const pre = ch === 'wb' ? 'wb' : 'oz';
  const buyout = S[pre + 'BuyoutPct'] / 100, comPct = S[pre + 'CommissionPct'] / 100, logU = S[pre + 'LogisticsPerUnit'];
  const finDates = cd.fin.filter((x) => x.kind === 'revenue').map((x) => x.d);
  const lastFin = finDates.length ? finDates.reduce((m, d) => (d > m ? d : m)) : null;
  const M = {};
  const row = (sku) => (M[sku] ||= { sku, ordQty: 0, ordSum: 0, qty: 0, revenue: 0, retQty: 0, returns: 0, commission: 0, logistics: 0, penalty: 0, storage: 0, stars: 0, other: 0, adsFin: 0, ads: 0, adOrders: 0, adSum: 0, est: false });
  let estDays = new Set();
  for (const o of cd.orders) {
    if (o.d < a || o.d > b) continue;
    const r = row(o.sku); r.ordQty += o.qty; r.ordSum += o.sum;
    if (!lastFin || o.d > lastFin) { // оценка
      const q = o.qty * buyout, rev = o.sum * buyout;
      r.qty += q; r.revenue += rev; r.commission += rev * comPct; r.logistics += q * logU; r.est = true; estDays.add(o.d);
    }
  }
  for (const f of cd.fin) {
    if (f.d < a || f.d > b) continue;
    const r = row(f.sku);
    switch (f.kind) {
      case 'revenue': r.qty += f.qty; r.revenue += f.amount; break;
      case 'return': r.retQty += f.qty; r.returns += f.amount; break;
      case 'ads': r.adsFin += f.amount; break;
      default: r[f.kind] += f.amount;
    }
  }
  const adsRows = cd.ads.filter((x) => x.d >= a && x.d <= b);
  const rows = Object.values(M);
  if (adsRows.length) {
    let unassigned = 0;
    for (const x of adsRows) { if (x.sku && M[x.sku]) { M[x.sku].ads += x.spend; M[x.sku].adOrders += x.orders; M[x.sku].adSum += x.sum; } else unassigned += x.spend; }
    const tot = sum(rows, (r) => r.revenue) || 1;
    for (const r of rows) r.ads += unassigned * (r.revenue / tot);
  } else for (const r of rows) r.ads = r.adsFin;
  return { rows, lastFin, estDays: estDays.size };
}

function totals(rows) {
  const t = {};
  for (const k of ['ordQty', 'ordSum', 'qty', 'revenue', 'retQty', 'returns', 'commission', 'logistics', 'penalty', 'storage', 'stars', 'other', 'ads', 'cogs']) t[k] = sum(rows, (r) => r[k]);
  return t;
}

function pnlOf(t, S, fixed) {
  const net = t.revenue - t.returns;
  const mp = t.logistics + t.storage + t.other;
  const bt = net - t.cogs - t.commission - mp - t.ads - t.stars - t.penalty - fixed;
  const tax = S.taxMode === 'profit' ? Math.max(0, bt) * S.taxPct / 100 : Math.max(0, net) * S.taxPct / 100;
  return { rev: t.revenue, ret: t.returns, net, cogs: t.cogs, gross: net - t.cogs, com: t.commission, log: mp, ad: t.ads, st: t.stars, pn: t.penalty, fx: fixed, bt, tax, np: bt - tax };
}

export function compute(db, from, to) {
  const S = db.settings;
  const N = daysBetween(from, to);
  const pFrom = addDays(from, -N), pTo = addDays(from, -1);
  const chans = Object.fromEntries(CH.map((c) => [c, channelData(db, c)]));
  const T = costTable(db, Object.values(chans));
  const out = { from, to, days: N, settings: S, channels: {}, pnl: {}, kpi: {}, unit: [], ads: [], stocks: [], warehouses: [], promos: [], series: [], decisions: [], insights: [] };

  // ---- агрегаты по каналам: текущий и прошлый период
  const cur = {}, prev = {};
  for (const ch of CH) {
    const cd = chans[ch];
    for (const [store, a, b] of [[cur, from, to], [prev, pFrom, pTo]]) {
      const ag = aggregate(cd, ch, S, a, b);
      for (const r of ag.rows) {
        const p = cd.products[r.sku] || { sku: r.sku, name: r.sku };
        r.name = p.name; r.cost = costOf(T, p);
        r.cogs = (r.qty - r.retQty) * (r.cost || 0);
      }
      store[ch] = { ...ag, t: totals(ag.rows) };
    }
    out.channels[ch] = { name: CH_NAME[ch], demo: !!cd.demo, lastFin: cur[ch].lastFin, estDays: cur[ch].estDays, finManual: !!cd.finManual };
  }

  // постоянные расходы делим по доле чистой выручки
  const share = (st, ch) => { const all = sum(CH, (c) => st[c].t.revenue - st[c].t.returns) || 1; return (st[ch].t.revenue - st[ch].t.returns) / all; };
  const fixedFor = (st, ch) => S.fixedMonthly * (N / 30) * share(st, ch);
  const sumP = (ps) => Object.fromEntries(Object.keys(ps[0]).map((k) => [k, sum(ps, (p) => p[k])]));
  const P = {}, PP = {};
  for (const ch of CH) { P[ch] = pnlOf(cur[ch].t, S, fixedFor(cur, ch)); PP[ch] = pnlOf(prev[ch].t, S, fixedFor(prev, ch)); }
  P.all = sumP(CH.map((c) => P[c])); PP.all = sumP(CH.map((c) => PP[c]));
  out.pnl = P;

  // ---- KPI
  for (const k of [...CH, 'all']) {
    const t = k === 'all' ? null : cur[k].t, pt = k === 'all' ? null : prev[k].t;
    const qty = k === 'all' ? sum(CH, (c) => cur[c].t.qty - cur[c].t.retQty) : t.qty - t.retQty;
    const pqty = k === 'all' ? sum(CH, (c) => prev[c].t.qty - prev[c].t.retQty) : pt.qty - pt.retQty;
    const ord = k === 'all' ? sum(CH, (c) => cur[c].t.ordSum) : t.ordSum;
    const pord = k === 'all' ? sum(CH, (c) => prev[c].t.ordSum) : pt.ordSum;
    const m = (p) => (p.net ? p.np / p.net : 0);
    out.kpi[k] = {
      revenue: P[k].net, revenuePrev: PP[k].net, sales: round(qty), salesPrev: round(pqty), ordered: ord, orderedPrev: pord,
      profit: P[k].np, profitPrev: PP[k].np, margin: m(P[k]), marginPrev: m(PP[k]),
      drr: P[k].net ? P[k].ad / P[k].net : 0, marginNoAds: P[k].net ? (P[k].np + P[k].ad) / P[k].net : 0,
    };
  }

  // ---- график: заказы по дням
  for (let d = from; d <= to; d = addDays(d, 1)) out.series.push({ d, wb: 0, ozon: 0 });
  const idx = Object.fromEntries(out.series.map((x, i) => [x.d, i]));
  for (const ch of CH) for (const o of chans[ch].orders) if (o.d in idx) out.series[idx[o.d]][ch] += o.sum;

  // ---- план месяца (по чистой выручке)
  const t0 = today(), mStart = t0.slice(0, 8) + '01';
  const dim = new Date(parseIso(t0).getFullYear(), parseIso(t0).getMonth() + 1, 0).getDate();
  const passed = parseIso(t0).getDate();
  const fact = sum(CH, (ch) => { const ag = aggregate(chans[ch], ch, S, mStart, t0); return sum(ag.rows, (r) => r.revenue - r.returns); });
  out.plan = { goal: S.planMonth, fact, forecast: fact / passed * dim, pct: S.planMonth ? fact / S.planMonth : 0, passed, dim };

  // ---- юнит-экономика
  const tax = S.taxPct / 100, tm = S.targetMarginPct / 100;
  const unitIdx = {};
  for (const ch of CH) {
    const pre = ch === 'wb' ? 'wb' : 'oz';
    for (const r of cur[ch].rows) {
      if (!r.qty && !r.ordQty) continue;
      const price = chans[ch].prices[r.sku] || (r.qty ? r.revenue / r.qty : r.ordQty ? r.ordSum / r.ordQty : 0);
      if (!price) continue;
      const comPct = r.revenue ? r.commission / r.revenue : S[pre + 'CommissionPct'] / 100;
      const logU = r.qty ? (r.logistics + r.storage + r.other) / r.qty : S[pre + 'LogisticsPerUnit'];
      const net = Math.max(1, r.qty - r.retQty);
      const adsU = r.ads / net;
      const cost = r.cost || 0;
      const taxU = S.taxMode === 'income' ? price * tax : 0;
      let profitNoAds = price * (1 - comPct) - logU - cost - taxU;
      if (S.taxMode === 'profit') profitNoAds -= Math.max(0, profitNoAds) * tax;
      const profitAds = profitNoAds - adsU;
      const denom = 1 - comPct - (S.taxMode === 'income' ? tax : 0);
      const u = {
        ch, sku: r.sku, name: r.name, price, cost: r.cost, comPct, logU, adsU, taxU, profitNoAds, profitAds,
        marginNoAds: profitNoAds / price, marginAds: profitAds / price,
        breakeven: denom > 0 ? (cost + logU + adsU) / denom : null,
        targetPrice: denom - tm > 0 ? (cost + logU + adsU) / (denom - tm) : null,
        retPct: r.qty ? r.retQty / r.qty : 0, qty: round(r.qty - r.retQty), ordQty: r.ordQty, revenue: r.revenue - r.returns,
        profit: r.revenue - r.returns - r.commission - r.logistics - r.storage - r.other - r.penalty - r.stars - r.ads - r.cogs - (S.taxMode === 'income' ? (r.revenue - r.returns) * tax : 0),
        est: r.est, noCost: r.cost == null,
      };
      out.unit.push(u); unitIdx[ch + ':' + r.sku] = u;
    }
  }
  out.unit.sort((a, b) => b.revenue - a.revenue);

  // ---- реклама по кампаниям
  for (const ch of CH) {
    const rows = chans[ch].ads.filter((x) => x.d >= from && x.d <= to);
    const mNo = out.kpi[ch].marginNoAds;
    for (const [cid, list] of groupBy(rows, 'cid')) {
      const s = { spend: sum(list, (x) => x.spend), views: sum(list, (x) => x.views), clicks: sum(list, (x) => x.clicks), orders: sum(list, (x) => x.orders), sum: sum(list, (x) => x.sum) };
      const skus = [...new Set(list.map((x) => x.sku).filter(Boolean))];
      out.ads.push({ ch, cid, name: list[0].name, skus, ...s, ctr: s.views ? s.clicks / s.views : 0, cpc: s.clicks ? s.spend / s.clicks : 0, cr: s.clicks ? s.orders / s.clicks : 0, drr: s.sum ? s.spend / s.sum : null, roas: s.spend ? s.sum / s.spend : null, roi: s.spend ? (s.sum * mNo - s.spend) / s.spend : null });
    }
  }
  out.ads.sort((a, b) => b.spend - a.spend);

  // ---- склад
  for (const ch of CH) {
    const cd = chans[ch];
    const ordBySku = {};
    const a30 = addDays(to, -29);
    for (const o of cd.orders) if (o.d >= a30 && o.d <= to) ordBySku[o.sku] = (ordBySku[o.sku] || 0) + o.qty;
    for (const [sku, list] of groupBy(cd.stocks, 'sku')) {
      const qty = sum(list, (x) => x.qty), inWay = sum(list, (x) => x.inWay);
      const perDay = (ordBySku[sku] || 0) / 30;
      const p = cd.products[sku] || { sku, name: sku };
      const cost = costOf(T, p) || 0;
      const daysLeft = perDay ? qty / perDay : qty ? Infinity : 0;
      const withWay = perDay ? (qty + inWay) / perDay : Infinity;
      const need = S.leadTimeDays + S.safetyDays;
      const status = withWay < need ? 'reorder' : daysLeft > S.overstockDays ? 'overstock' : 'ok';
      out.stocks.push({ ch, sku, name: p.name, qty, inWay, perDay, daysLeft, withWay, turnover: qty && perDay ? 365 * perDay / qty : 0, frozen: qty * cost, status, reorderQty: status === 'reorder' ? Math.ceil(perDay * (need + 30) - qty - inWay) : 0 });
      for (const x of list) out.warehouses.push({ ch, sku, name: p.name, wh: x.wh, qty: x.qty, inWay: x.inWay });
    }
  }
  out.stocks.sort((a, b) => (a.withWay === b.withWay ? 0 : a.withWay - b.withWay));
  const fin = (x) => (isFinite(x) ? x : null);
  for (const s of out.stocks) { s.daysLeft = fin(s.daysLeft); s.withWay = fin(s.withWay); }
  out.stockTotals = {
    qty: sum(out.stocks, (s) => s.qty), frozen: sum(out.stocks, (s) => s.frozen),
    reorder: out.stocks.filter((s) => s.status === 'reorder').length, overstock: out.stocks.filter((s) => s.status === 'overstock').length,
    turnover: (() => { const l = out.stocks.filter((s) => s.turnover); return l.length ? sum(l, (s) => s.turnover) / l.length : 0; })(),
  };
  out.supplies = db.supplies;

  // ---- акции
  for (const ch of CH) for (const p of chans[ch].promos) {
    const items = p.items.map((it) => {
      const u = unitIdx[ch + ':' + it.sku];
      const price = chans[ch].prices[it.sku] || u?.price || 0;
      if (!u || !price || !it.actionPrice) return { ...it, name: chans[ch].products[it.sku]?.name || it.sku, price, margin: null, pass: false };
      const profitAt = (x) => x * (1 - u.comPct - (S.taxMode === 'income' ? tax : 0)) - u.logU - (u.cost || 0) - u.adsU;
      const margin = profitAt(it.actionPrice) / it.actionPrice;
      return { ...it, name: u.name, price, reqDisc: 1 - it.actionPrice / price, margin, pass: margin >= tm, maxDisc: u.targetPrice ? 1 - u.targetPrice / price : null };
    });
    out.promos.push({ ch, ...p, items, passCount: items.filter((i) => i.pass).length });
  }

  // ---- Честный знак
  const kizList = db.manual.kiz.length ? db.manual.kiz : (chans.wb.demo || chans.ozon.demo ? demoKiz() : []);
  out.kiz = kizList.map((k) => {
    const deadline = addWorkDays(k.d, S.kizDeadlineDays);
    const done = db.kizDone[k.kiz];
    const status = done ? 'done' : t0 > deadline ? 'overdue' : deadline <= addWorkDays(t0, 1) ? 'urgent' : 'ok';
    return { ...k, deadline, done: done || null, status };
  }).sort((a, b) => a.deadline.localeCompare(b.deadline));
  out.kizTotals = { todo: out.kiz.filter((k) => k.status !== 'done').length, done: out.kiz.filter((k) => k.status === 'done').length, overdue: out.kiz.filter((k) => k.status === 'overdue').length, urgent: out.kiz.filter((k) => k.status === 'urgent').length };

  out.decisions = decisions(out, S);
  out.insights = insights(out, cur, prev);
  return out;
}

const R = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const PCT = (x) => (x * 100).toFixed(1).replace('.', ',') + '%';

function decisions(o, S) {
  const D = [];
  const add = (pri, area, title, text, ch, sku) => D.push({ id: `${area}:${ch || ''}:${sku || title}`, pri, area, title, text, ch, sku });
  for (const k of o.kiz) if (k.status === 'overdue' || k.status === 'urgent') add('hi', 'cz', `КИЗ ${k.status === 'overdue' ? 'просрочен' : 'срок истекает'}: ${k.sku}`, `Заказ ${k.order}, срок ${k.deadline}. Выведите код из оборота в ГИС МТ.`, k.ch, k.sku);
  for (const s of o.stocks) {
    if (s.status === 'reorder') add(s.daysLeft != null && s.daysLeft < S.leadTimeDays ? 'hi' : 'me', 'wh', `Дозаказать ${s.sku}`, `Хватит на ${s.daysLeft == null ? '—' : Math.round(s.daysLeft)} дн. (с учётом в пути ${s.withWay == null ? '—' : Math.round(s.withWay)}), продаж ${s.perDay.toFixed(1)}/день. Заказать ≈ ${s.reorderQty} шт.`, s.ch, s.sku);
    if (s.status === 'overstock') add('me', 'wh', `Затоварка ${s.sku}`, `Остатка на ${s.daysLeft == null ? '∞' : Math.round(s.daysLeft)} дн., заморожено ${R(s.frozen)}. Варианты: акция, снижение цены, реклама.`, s.ch, s.sku);
  }
  for (const a of o.ads) {
    if (a.drr != null && a.drr > S.drrMaxPct / 100) add(a.roi != null && a.roi < 0 ? 'hi' : 'me', 'ads', `ДРР ${PCT(a.drr)}: ${a.name}`, `Расход ${R(a.spend)}, заказов на ${R(a.sum)}, ROI ${a.roi == null ? '—' : PCT(a.roi)}. Снизьте ставки или отключите кампанию.`, a.ch, a.skus[0]);
  }
  for (const u of o.unit) {
    if (u.noCost && u.qty > 0) { add('me', 'unit', `Нет себестоимости: ${u.sku}`, 'Загрузите себестоимость, иначе прибыль завышена.', u.ch, u.sku); continue; }
    if (u.profitAds < 0) add('hi', 'unit', `В минус с рекламой: ${u.sku}`, `Прибыль/ед ${R(u.profitAds)}. Цена безубытка ${u.breakeven ? R(u.breakeven) : '—'}, для маржи ${S.targetMarginPct}% — ${u.targetPrice ? R(u.targetPrice) : 'недостижимо'}.`, u.ch, u.sku);
    else if (u.marginNoAds < S.targetMarginPct / 100) add('me', 'unit', `Маржа ниже цели: ${u.sku}`, `Маржа без рекламы ${PCT(u.marginNoAds)}. Поднять цену до ${u.targetPrice ? R(u.targetPrice) : '—'}.`, u.ch, u.sku);
  }
  for (const p of o.promos) if (!p.participating && p.passCount) add('lo', 'promo', `Акция «${p.name}»: ${p.passCount} поз. проходят по марже`, `С ${p.from} по ${p.to}. Можно участвовать без потери целевой маржи.`, p.ch);
  for (const ch of Object.keys(o.channels)) if (o.channels[ch].estDays) add('lo', 'int', `${o.channels[ch].name}: ${o.channels[ch].estDays} дн. посчитаны оценочно`, 'Финотчёта за эти дни ещё нет — комиссия и логистика взяты из настроек. Загрузите отчёт или дождитесь синхронизации.', ch);
  const ord = { hi: 0, me: 1, lo: 2 };
  return D.sort((a, b) => ord[a.pri] - ord[b.pri]);
}

function insights(o, cur, prev) {
  const I = [];
  const chs = Object.keys(o.channels);
  const best = chs.slice().sort((a, b) => o.kpi[b].margin - o.kpi[a].margin)[0];
  if (o.kpi[best].revenue) I.push(`Самый маржинальный канал — ${o.channels[best].name}: чистая рентабельность ${PCT(o.kpi[best].margin)}, ДРР ${PCT(o.kpi[best].drr)}.`);
  const growth = [];
  for (const ch of chs) for (const r of cur[ch].rows) { const p = prev[ch].rows.find((x) => x.sku === r.sku); if (p && p.ordSum > 5000) growth.push({ ch, sku: r.sku, g: r.ordSum / p.ordSum - 1 }); }
  growth.sort((a, b) => b.g - a.g);
  if (growth[0]?.g > 0.1) I.push(`Быстрее всех растёт ${growth[0].sku} (${o.channels[growth[0].ch].name}): заказы +${PCT(growth[0].g)} к прошлому периоду.`);
  const fall = growth[growth.length - 1];
  if (fall && fall.g < -0.1) I.push(`Сильнее всех падает ${fall.sku} (${o.channels[fall.ch].name}): заказы ${PCT(fall.g)}. Проверьте остатки, цену и позиции.`);
  const bestAd = o.ads.filter((a) => a.roas).sort((a, b) => b.roas - a.roas)[0];
  if (bestAd) I.push(`Лучшая связка: «${bestAd.name}» — ROAS ${bestAd.roas.toFixed(1).replace('.', ',')}, ДРР ${PCT(bestAd.drr)}.`);
  const all = o.pnl.all;
  if (all.net) I.push(`Логистика и услуги маркетплейсов съедают ${PCT(all.log / all.net)} выручки, комиссии — ${PCT(all.com / all.net)}.`);
  if (o.stockTotals.frozen) I.push(`В остатках заморожено ${R(o.stockTotals.frozen)}; в затоварке ${o.stockTotals.overstock} поз., к дозаказу ${o.stockTotals.reorder}.`);
  return I;
}

// Короткая сводка для ИИ-ассистента
export function aiContext(m) {
  const pick = (u) => ({ ch: u.ch, sku: u.sku, name: u.name, price: round(u.price), marginNoAds: round(u.marginNoAds, 3), marginAds: round(u.marginAds, 3), profit: round(u.profit), qty: u.qty });
  return {
    period: `${m.from} — ${m.to}`, channels: m.channels, kpi: m.kpi, pnl: Object.fromEntries(Object.entries(m.pnl).map(([k, p]) => [k, Object.fromEntries(Object.entries(p).map(([a, b]) => [a, round(b)]))])),
    plan: m.plan, decisions: m.decisions.slice(0, 25).map((d) => `[${d.pri}] ${d.title}: ${d.text}`), insights: m.insights,
    unitTop: m.unit.slice(0, 40).map(pick), ads: m.ads.slice(0, 20).map((a) => ({ ch: a.ch, name: a.name, spend: round(a.spend), sum: round(a.sum), drr: a.drr && round(a.drr, 3), roi: a.roi && round(a.roi, 2) })),
    stocks: m.stocks.slice(0, 30).map((s) => ({ ch: s.ch, sku: s.sku, qty: s.qty, perDay: round(s.perDay, 1), daysLeft: s.daysLeft && round(s.daysLeft), status: s.status })),
    settings: m.settings,
  };
}
