// Фронт дашборда: получает готовую модель с /api/dashboard и рисует разделы.
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const R = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('ru-RU') + ' ₽');
const N = (n, k = 0) => (n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: k, minimumFractionDigits: k }));
const P = (x, k = 1) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(k).replace('.', ',') + '%');
const D = (s) => (s ? s.split('-').reverse().join('.') : '—');
const CHN = { wb: 'WB', ozon: 'Ozon' };
const chTag = (c) => `<span class="ch ${c}">${CHN[c]}</span>`;
const PRI = { hi: 'Высокий', me: 'Средний', lo: 'Низкий' };
const TITLES = { home: 'Главная', dec: 'Центр решений', ads: 'Реклама', promo: 'Акции', cz: 'Честный знак', unit: 'Юнит-экономика', wh: 'Склад и поставки', pnl: 'Прибыли и убытки', tasks: 'Задачи', int: 'Интеграции' };

const S = { view: 'home', ch: 'all', q: '', m: null, tasks: [], sort: {}, chat: [], kizSel: new Set() };
try { Object.assign(S, JSON.parse(localStorage.getItem('mpdash') || '{}'), { m: null, tasks: [], chat: [], kizSel: new Set(), sort: {} }); } catch {}
const persist = () => { try { localStorage.setItem('mpdash', JSON.stringify({ view: S.view, ch: S.ch, period: $('#period').value })); } catch {} };

async function J(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Ошибка ${r.status}`);
  return j;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 4000); }

// ---------- период
const isoD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function range() {
  const v = $('#period').value, t = new Date();
  if (v === 'custom') return [$('#dFrom').value || isoD(new Date(Date.now() - 29 * 864e5)), $('#dTo').value || isoD(t)];
  if (v === 'month') return [isoD(new Date(t.getFullYear(), t.getMonth(), 1)), isoD(t)];
  return [isoD(new Date(Date.now() - (Number(v) - 1) * 864e5)), isoD(t)];
}

async function load() {
  const [from, to] = range();
  try {
    S.m = await J(`/api/dashboard?from=${from}&to=${to}`);
    S.tasks = await J('/api/tasks');
  } catch (e) { toast('Не удалось загрузить данные: ' + e.message); return; }
  render();
}

// ---------- фильтры
const byCh = (rows) => rows.filter((r) => S.ch === 'all' || r.ch === S.ch);
const byQ = (rows) => { const q = S.q.trim().toLowerCase(); return q ? rows.filter((r) => `${r.sku || ''} ${r.name || ''}`.toLowerCase().includes(q)) : rows; };
const F = (rows) => byQ(byCh(rows));

// ---------- таблица с сортировкой
// cols: [{k, t, f?: (row)=>html, num?: bool, v?: (row)=>value для сортировки}]
function table(id, cols, rows, { total } = {}) {
  const st = S.sort[id];
  if (st) {
    const c = cols.find((x) => x.k === st.k);
    const val = c?.v || ((r) => r[st.k]);
    rows = rows.slice().sort((a, b) => { const x = val(a), y = val(b); if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * (st.dir === 'asc' ? 1 : -1); });
  }
  if (!rows.length) return '<div class="empty">Нет данных</div>';
  const head = cols.map((c) => `<th data-t="${id}" data-k="${c.k}" class="${c.num ? 'num' : ''} ${st?.k === c.k ? 's-' + st.dir : ''}">${c.t}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('');
  const tot = total ? `<tr class="tot">${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${total[c.k] ?? ''}</td>`).join('')}</tr>` : '';
  return `<div class="sc"><table><thead><tr>${head}</tr></thead><tbody>${body}${tot}</tbody></table></div>`;
}
document.addEventListener('click', (e) => {
  const th = e.target.closest('th[data-t]'); if (!th) return;
  const { t, k } = th.dataset, cur = S.sort[t];
  S.sort[t] = { k, dir: cur?.k === k && cur.dir === 'desc' ? 'asc' : 'desc' };
  render();
});

const skuCell = (r) => `${chTag(r.ch)}<b>${esc(r.sku)}</b><span class="nm">${esc(r.name)}</span>`;
const delta = (cur, prev, inverse) => {
  if (!prev) return '<div class="delta mut">нет данных за прошлый период</div>';
  const d = cur / prev - 1, good = inverse ? d < 0 : d > 0;
  return `<div class="delta ${good ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${P(Math.abs(d))} к прошлому периоду</div>`;
};
const kpiCard = (t, v, d, extra = '') => `<div class="card"><h3>${t}${extra}</h3><div class="big">${v}</div>${d || ''}</div>`;
const demoBadge = () => (S.ch === 'all' ? Object.values(S.m.channels).some((c) => c.demo) : S.m.channels[S.ch].demo) ? '<span class="badge-demo">демо</span>' : '';

// ---------- разделы
const V = {};

V.home = () => {
  const m = S.m, k = m.kpi[S.ch], p = m.plan;
  const att = F(m.decisions).filter((d) => d.pri === 'hi').slice(0, 6);
  const st = F(m.stocks);
  const chRows = ['wb', 'ozon'].map((c) => `<div class="li"><span>${chTag(c)}${m.channels[c].name}</span><span class="small">маржа <b>${P(m.kpi[c].margin)}</b> · ДРР <b>${P(m.kpi[c].drr)}</b></span></div>`).join('');
  return `
  <div class="row">
    ${kpiCard('Выручка', R(k.revenue), delta(k.revenue, k.revenuePrev), demoBadge())}
    ${kpiCard('Продажи, шт', N(k.sales), delta(k.sales, k.salesPrev))}
    ${kpiCard('Чистая прибыль', R(k.profit), delta(k.profit, k.profitPrev))}
    ${kpiCard('Чистая рентабельность', P(k.margin), `<div class="delta mut">было ${P(k.marginPrev)}</div>`)}
  </div>
  <div class="grid">
    <div class="col">
      <div class="card chart"><h3>Заказы по дням, ₽ <span class="mut small">заказано ${R(k.ordered)}</span></h3>${chart(m.series)}</div>
      <div class="row">
        <div class="card"><h3>Маржинальность и ДРР по каналам</h3>${chRows}</div>
        <div class="card"><h3>Остатки и оборачиваемость</h3>
          <div class="li"><span>Всего на складах</span><b>${N(sum(st, 'qty'))} шт</b></div>
          <div class="li"><span>Заморожено в остатках</span><b>${R(sum(st, 'frozen'))}</b></div>
          <div class="li"><span>Нужен дозаказ</span><b class="dn">${st.filter((s) => s.status === 'reorder').length}</b></div>
          <div class="li"><span>Затоварка</span><b class="me">${st.filter((s) => s.status === 'overstock').length}</b></div>
        </div>
      </div>
    </div>
    <div class="col">
      <div class="card"><h3>План месяца <b>${P(p.pct, 0)}</b></h3>
        <div class="bar"><i style="width:${Math.min(100, p.pct * 100)}%"></i></div>
        <div class="li"><span class="mut">Факт</span><b>${R(p.fact)}</b></div>
        <div class="li"><span class="mut">План</span><b>${R(p.goal)}</b></div>
        <div class="li"><span class="mut">Прогноз на конец месяца</span><b class="${p.forecast >= p.goal ? 'up' : 'dn'}">${R(p.forecast)}</b></div>
      </div>
      <div class="card"><h3>Требуют внимания <button class="btn sm" data-go="dec">Все решения</button></h3>
        ${att.length ? att.map((d) => `<div class="li"><span>${d.ch ? chTag(d.ch) : ''}${esc(d.title)}<div class="mut small">${esc(d.text)}</div></span></div>`).join('') : '<div class="empty">Срочного нет</div>'}
      </div>
      <div class="card"><h3>ИИ-инсайты</h3>${m.insights.map((i) => `<div class="li"><span>● ${esc(i)}</span></div>`).join('') || '<div class="empty">Мало данных</div>'}</div>
    </div>
  </div>`;
};

function chart(series) {
  const W = 800, H = 220, pad = 30;
  const show = S.ch === 'all' ? ['wb', 'ozon'] : [S.ch];
  const max = Math.max(1, ...series.map((x) => Math.max(...show.map((c) => x[c]))));
  const xs = (i) => pad + (i * (W - pad * 2)) / Math.max(1, series.length - 1);
  const ys = (v) => H - pad - (v / max) * (H - pad * 2);
  const col = { wb: 'var(--wb)', ozon: 'var(--oz)' };
  const lines = show.map((c) => `<polyline fill="none" stroke="${col[c]}" stroke-width="2" points="${series.map((x, i) => `${xs(i).toFixed(1)},${ys(x[c]).toFixed(1)}`).join(' ')}"/>`).join('');
  const grid = [0, 0.5, 1].map((f) => `<line x1="${pad}" x2="${W - pad}" y1="${ys(max * f)}" y2="${ys(max * f)}" stroke="#262b4d"/><text x="${pad - 4}" y="${ys(max * f) + 4}" fill="#8b91b8" font-size="10" text-anchor="end">${N(max * f / 1000)}к</text>`).join('');
  const step = Math.ceil(series.length / 8);
  const labels = series.map((x, i) => (i % step === 0 ? `<text x="${xs(i)}" y="${H - 8}" fill="#8b91b8" font-size="10" text-anchor="middle">${x.d.slice(8)}.${x.d.slice(5, 7)}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${lines}${labels}</svg>
  <div class="legend">${show.map((c) => `<span><i style="background:${col[c]}"></i>${CHN[c]}</span>`).join('')}</div>`;
}
const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);

V.dec = () => {
  const list = F(S.m.decisions);
  if (!list.length) return '<div class="card empty">Решений нет — всё в порядке.</div>';
  const go = { cz: 'cz', wh: 'wh', ads: 'ads', unit: 'unit', promo: 'promo', int: 'int' };
  return ['hi', 'me', 'lo'].map((p) => {
    const l = list.filter((d) => d.pri === p); if (!l.length) return '';
    return `<div class="card" style="margin-bottom:16px"><h3>${PRI[p]} приоритет <span class="tag ${p}">${l.length}</span></h3>
      ${l.map((d) => `<div class="li"><span>${d.ch ? chTag(d.ch) : ''}<b>${esc(d.title)}</b><div class="mut small">${esc(d.text)}</div></span>
        <span style="display:flex;gap:6px"><button class="btn sm" data-go="${go[d.area]}">Открыть</button><button class="btn sm" data-task="${esc(d.id)}">В задачи</button></span></div>`).join('')}
    </div>`;
  }).join('');
};

V.ads = () => {
  const rows = F(S.m.ads.map((a) => ({ ...a, sku: a.skus.join(', ') })));
  const sp = sum(rows, 'spend'), sm = sum(rows, 'sum');
  return `<div class="row">
    ${kpiCard('Расход на рекламу', R(sp), '', demoBadge())}
    ${kpiCard('Заказы с рекламы', R(sm))}
    ${kpiCard('ДРР', P(sm ? sp / sm : null))}
    ${kpiCard('ROAS', sp ? N(sm / sp, 1) : '—')}
  </div>
  <div class="card"><h3>Рекламные кампании <span class="mut small">ДРР выше ${S.m.settings.drrMaxPct}% подсвечен</span></h3>
  ${table('ads', [
    { k: 'name', t: 'Кампания', f: (r) => `${chTag(r.ch)}<b>${esc(r.name)}</b><span class="nm">${esc(r.sku)}</span>` },
    { k: 'spend', t: 'Расход', num: 1, f: (r) => R(r.spend) },
    { k: 'views', t: 'Показы', num: 1, f: (r) => N(r.views) },
    { k: 'clicks', t: 'Клики', num: 1, f: (r) => N(r.clicks) },
    { k: 'ctr', t: 'CTR', num: 1, f: (r) => P(r.ctr, 2) },
    { k: 'cpc', t: 'CPC', num: 1, f: (r) => R(r.cpc) },
    { k: 'cr', t: 'CR клик→заказ', num: 1, f: (r) => P(r.cr, 2) },
    { k: 'orders', t: 'Заказы', num: 1, f: (r) => N(r.orders) },
    { k: 'sum', t: 'Выручка', num: 1, f: (r) => R(r.sum) },
    { k: 'drr', t: 'ДРР', num: 1, f: (r) => `<span class="${r.drr > S.m.settings.drrMaxPct / 100 ? 'dn' : ''}">${P(r.drr)}</span>` },
    { k: 'roas', t: 'ROAS', num: 1, f: (r) => N(r.roas, 1) },
    { k: 'roi', t: 'ROI', num: 1, f: (r) => `<span class="${r.roi < 0 ? 'dn' : 'up'}">${P(r.roi, 0)}</span>` },
  ], rows)}
  <p class="mut small">ROI считается как (выручка с рекламы × маржа канала без рекламы − расход) / расход.</p></div>`;
};

V.promo = () => {
  const promos = byCh(S.m.promos);
  const t = S.m.settings.targetMarginPct;
  return `<div class="row">
    ${kpiCard('Акций доступно', N(promos.length), '', demoBadge())}
    ${kpiCard('Акций с участием', N(promos.filter((p) => p.participating).length))}
    ${kpiCard(`Позиций проходит по марже ≥ ${t}%`, N(sum(promos, 'passCount')))}
  </div>
  ${promos.map((p) => `<div class="card" style="margin-bottom:16px"><h3><span>${chTag(p.ch)}<b style="color:var(--t)">${esc(p.name)}</b> · ${D(p.from)} — ${D(p.to)}</span>${p.participating ? '<span class="tag lo">участвуем</span>' : '<span class="tag">не участвуем</span>'}</h3>
    ${table('promo' + p.id, [
      { k: 'sku', t: 'Товар', f: (r) => `<b>${esc(r.sku)}</b><span class="nm">${esc(r.name)}</span>` },
      { k: 'price', t: 'Цена', num: 1, f: (r) => R(r.price) },
      { k: 'actionPrice', t: 'Цена в акции', num: 1, f: (r) => R(r.actionPrice) },
      { k: 'reqDisc', t: 'Требуемая скидка', num: 1, f: (r) => P(r.reqDisc) },
      { k: 'margin', t: 'Маржа в акции', num: 1, f: (r) => `<span class="${r.pass ? 'up' : 'dn'}">${P(r.margin)}</span>` },
      { k: 'maxDisc', t: `Макс. скидка для ${t}%`, num: 1, f: (r) => P(r.maxDisc) },
      { k: 'inAction', t: 'Статус', f: (r) => (r.inAction ? '<span class="tag lo">в акции</span>' : r.pass ? '<span class="tag lo">можно</span>' : '<span class="tag hi">в минус марже</span>') },
    ], byQ(p.items))}</div>`).join('') || '<div class="card empty">Акций нет</div>'}`;
};

V.cz = () => {
  const m = S.m, t = m.kizTotals;
  const rows = F(m.kiz);
  const stTag = { done: '<span class="tag lo">выведен</span>', overdue: '<span class="tag hi">просрочен</span>', urgent: '<span class="tag me">сегодня / 1 раб. день</span>', ok: '<span class="tag">в срок</span>' };
  return `<div class="row">
    ${kpiCard('К выводу (выкуплено)', N(t.todo), '', m.status.manual.kiz ? '' : '<span class="badge-demo">демо</span>')}
    ${kpiCard('Выведено', N(t.done))}
    ${kpiCard('Просрочено', `<span class="${t.overdue ? 'dn' : ''}">${N(t.overdue)}</span>`)}
    ${kpiCard('Срок: сегодня или 1 раб. день', `<span class="${t.urgent ? 'me' : ''}">${N(t.urgent)}</span>`)}
  </div>
  <div class="card" style="margin-bottom:16px"><h3>Вывод из оборота в ГИС МТ: файл для загрузки</h3>
    <ol class="mut small" style="margin:0 0 10px;padding-left:18px">
      <li>Отметьте коды ниже (или «Выбрать все к выводу») и нажмите «Скачать TXT».</li>
      <li>В ГИС МТ создайте документ «Вывод из оборота», причина «розничная продажа».</li>
      <li>Загрузите файл с кодами и подпишите документ электронной подписью.</li>
      <li>Вернитесь сюда и нажмите «Отметить выведенными». Возвраты и отмены в файл не попадают.</li>
    </ol>
    <div class="form">
      <button class="btn" id="kizAll">Выбрать все к выводу</button>
      <button class="btn p" id="kizTxt">Скачать TXT (${S.kizSel.size})</button>
      <button class="btn" id="kizDone">Отметить выведенными</button>
      <button class="btn" id="kizUndo">Снять отметку</button>
      <span class="mut small">Срок вывода: ${m.settings.kizDeadlineDays} раб. дн. после выкупа (меняется в «Интеграциях»).</span>
    </div>
    ${table('kiz', [
      { k: 'sel', t: '', f: (r) => `<input type="checkbox" data-kiz="${esc(r.kiz)}" ${S.kizSel.has(r.kiz) ? 'checked' : ''}>` },
      { k: 'kiz', t: 'КИЗ', f: (r) => `<code class="small">${esc(r.kiz.slice(0, 31))}${r.kiz.length > 31 ? '…' : ''}</code>` },
      { k: 'ch', t: 'Канал', f: (r) => chTag(r.ch) },
      { k: 'order', t: '№ заказа FBS' },
      { k: 'sku', t: 'Товар', f: (r) => `<b>${esc(r.sku)}</b><span class="nm">${esc(r.name)}</span>` },
      { k: 'd', t: 'Выкуп', f: (r) => D(r.d) },
      { k: 'deadline', t: 'Крайний срок', f: (r) => D(r.deadline) },
      { k: 'status', t: 'Статус', f: (r) => stTag[r.status] },
    ], rows)}
  </div>
  ${uploadBlock('kiz', 'Честный знак: список выкупленных FBS-заказов с КИЗ', 'Excel или CSV с колонками «КИЗ», «Канал» (WB/Ozon), «№ заказа», «Артикул», «Товар», «Дата выкупа». Дубликаты КИЗ пропускаются.', m.status.manual.kiz ? `● загружено ${m.status.manual.kiz} КИЗ` : '○ демо-данные')}`;
};

V.unit = () => {
  const m = S.m, rows = F(m.unit), t = m.settings.targetMarginPct;
  const avg = rows.length ? sum(rows.map((r) => ({ x: r.marginNoAds * r.revenue })), 'x') / (sum(rows, 'revenue') || 1) : null;
  return `<div class="row">
    ${kpiCard('Средняя маржа (без рекламы)', P(avg), '<div class="delta mut">взвешено по выручке</div>', demoBadge())}
    ${kpiCard('Позиций в минус (с рекламой)', `<span class="dn">${rows.filter((r) => r.profitAds < 0).length}</span>`)}
    ${kpiCard(`Проходим по марже ≥ ${t}%`, `${rows.filter((r) => r.marginAds >= t / 100).length} из ${rows.length}`)}
    ${kpiCard('Без себестоимости', `<span class="${rows.some((r) => r.noCost) ? 'me' : ''}">${rows.filter((r) => r.noCost).length}</span>`)}
  </div>
  <div class="card" style="margin-bottom:16px"><h3>Расчёт на 1 единицу <span class="mut small">* — часть дней посчитана оценочно (нет финотчёта)</span></h3>
  ${table('unit', [
    { k: 'sku', t: 'Артикул', f: (r) => skuCell(r) + (r.est ? ' <span class="mut">*</span>' : '') },
    { k: 'price', t: 'Цена', num: 1, f: (r) => R(r.price) },
    { k: 'cost', t: 'Себест.', num: 1, f: (r) => (r.noCost ? '<span class="me">нет</span>' : R(r.cost)) },
    { k: 'comPct', t: 'Комиссия', num: 1, f: (r) => P(r.comPct) },
    { k: 'logU', t: 'Логистика/ед', num: 1, f: (r) => R(r.logU) },
    { k: 'adsU', t: 'Реклама/ед', num: 1, f: (r) => R(r.adsU) },
    { k: 'taxU', t: 'Налог/ед', num: 1, f: (r) => R(r.taxU) },
    { k: 'profitNoAds', t: 'Прибыль/ед без рекл.', num: 1, f: (r) => R(r.profitNoAds) },
    { k: 'marginNoAds', t: 'Маржа без рекл.', num: 1, f: (r) => P(r.marginNoAds) },
    { k: 'marginAds', t: 'Маржа с рекл.', num: 1, f: (r) => `<span class="${r.marginAds < 0 ? 'dn' : r.marginAds >= t / 100 ? 'up' : 'me'}">${P(r.marginAds)}</span>` },
    { k: 'breakeven', t: 'Цена безубытка', num: 1, f: (r) => R(r.breakeven) },
    { k: 'targetPrice', t: `Цена для ${t}%`, num: 1, f: (r) => R(r.targetPrice) },
    { k: 'retPct', t: 'Возвраты', num: 1, f: (r) => P(r.retPct) },
    { k: 'qty', t: 'Продано, шт', num: 1, f: (r) => N(r.qty) },
    { k: 'profit', t: 'Прибыль за период', num: 1, f: (r) => `<span class="${r.profit < 0 ? 'dn' : ''}">${R(r.profit)}</span>` },
  ], rows)}</div>
  ${uploadBlock('costs', 'Себестоимость из Excel', 'Excel или CSV с колонкой «Себестоимость» и колонкой «Артикул» (можно «Штрихкод» или «Название»). Товар ищется по артикулу, затем по штрихкоду, затем по названию. Загруженная себестоимость сразу идёт в P&L и юнит-экономику.', m.status.manual.costs ? `● загружено ${m.status.manual.costs} позиций` : '○ не загружена')}`;
};

V.wh = () => {
  const m = S.m, rows = F(m.stocks), S2 = m.settings;
  const turn = rows.filter((r) => r.turnover);
  return `<div class="row">
    ${kpiCard('Всего на складах', N(sum(rows, 'qty')) + ' шт', '', demoBadge())}
    ${kpiCard('Заморожено в остатках', R(sum(rows, 'frozen')))}
    ${kpiCard('Нужен дозаказ', `<span class="dn">${rows.filter((r) => r.status === 'reorder').length}</span>`)}
    ${kpiCard('Затоварка', `<span class="me">${rows.filter((r) => r.status === 'overstock').length}</span>`)}
    ${kpiCard('Средняя оборачиваемость', turn.length ? N(sum(turn, 'turnover') / turn.length, 1) + ' раз/год' : '—')}
  </div>
  <div class="card" style="margin-bottom:16px"><h3>Остатки и оборачиваемость <span class="mut small">дозаказ, если запаса меньше ${S2.leadTimeDays} + ${S2.safetyDays} дн.; затоварка — больше ${S2.overstockDays} дн.</span></h3>
  ${table('wh', [
    { k: 'sku', t: 'Артикул', f: skuCell },
    { k: 'qty', t: 'Остаток, шт', num: 1, f: (r) => N(r.qty) },
    { k: 'inWay', t: 'В пути', num: 1, f: (r) => N(r.inWay) },
    { k: 'perDay', t: 'Продаж/день', num: 1, f: (r) => N(r.perDay, 1) },
    { k: 'daysLeft', t: 'Хватит на, дн.', num: 1, f: (r) => N(r.daysLeft) },
    { k: 'withWay', t: 'С учётом в пути', num: 1, f: (r) => N(r.withWay) },
    { k: 'turnover', t: 'Оборот, раз/год', num: 1, f: (r) => N(r.turnover, 1) },
    { k: 'frozen', t: 'Заморожено', num: 1, f: (r) => R(r.frozen) },
    { k: 'status', t: 'Статус', f: (r) => (r.status === 'reorder' ? `<span class="tag hi">дозаказ ≈ ${N(r.reorderQty)} шт</span>` : r.status === 'overstock' ? '<span class="tag me">затоварка</span>' : '<span class="tag lo">норма</span>') },
  ], rows)}
  <details><summary>По складам</summary>${table('whs', [
    { k: 'sku', t: 'Артикул', f: skuCell }, { k: 'wh', t: 'Склад' }, { k: 'qty', t: 'Остаток', num: 1, f: (r) => N(r.qty) }, { k: 'inWay', t: 'В пути', num: 1, f: (r) => N(r.inWay) },
  ], F(m.warehouses))}</details></div>
  <div class="card"><h3>Поставки на склады <span class="mut small">план ведётся вручную</span></h3>
    <form class="form" id="supForm">
      <select name="ch"><option value="wb">WB</option><option value="ozon">Ozon</option></select>
      <input name="sku" placeholder="Артикул" required style="width:120px">
      <input name="qty" type="number" min="1" placeholder="Кол-во" required style="width:90px">
      <input name="wh" placeholder="Склад" style="width:140px">
      <input name="date" type="date" required>
      <select name="status"><option>План</option><option>Собрана</option><option>В пути</option><option>Принята</option></select>
      <button class="btn p">Добавить</button>
    </form>
    ${table('sup', [
      { k: 'ch', t: 'Канал', f: (r) => chTag(r.ch) }, { k: 'sku', t: 'Артикул' }, { k: 'qty', t: 'Кол-во', num: 1, f: (r) => N(r.qty) }, { k: 'wh', t: 'Куда' },
      { k: 'date', t: 'Плановая дата', f: (r) => D(r.date) }, { k: 'status', t: 'Статус' }, { k: 'x', t: '', f: (r) => `<button class="btn sm" data-supdel="${esc(r.id)}">✕</button>` },
    ], F(m.supplies))}
  </div>`;
};

V.pnl = () => {
  const P_ = S.m.pnl;
  const cols = S.ch === 'all' ? ['wb', 'ozon', 'all'] : [S.ch];
  const name = { wb: 'WB', ozon: 'Ozon', all: 'Итого' };
  const base = P_[cols[cols.length - 1]].net || 1;
  const L = [['Выручка', 'rev', 1], ['− Возвраты', 'ret'], ['Чистая выручка', 'net', 1], ['− Себестоимость', 'cogs'], ['Валовая прибыль', 'gross', 1], ['− Комиссии маркетплейсов', 'com'], ['− Логистика и услуги маркетплейса', 'log'], ['− Реклама', 'ad'], ['− Звёздные товары Ozon', 'st'], ['− Штрафы', 'pn'], ['− Постоянные расходы (по доле выручки)', 'fx'], ['Прибыль до налогов', 'bt', 1], ['− Налоги', 'tax'], ['Чистая прибыль', 'np', 1]];
  const rows = L.filter(([, k]) => k !== 'st' || cols.some((c) => P_[c].st)).map(([t, k, b]) => `<tr${b ? ' class="tot"' : ''}><td>${t}</td>${cols.map((c) => `<td class="num ${k === 'np' || k === 'bt' ? (P_[c][k] < 0 ? 'dn' : 'up') : ''}">${R(P_[c][k])}</td>`).join('')}<td class="num mut">${P(P_[cols[cols.length - 1]][k] / base)}</td></tr>`).join('');
  const est = Object.entries(S.m.channels).filter(([, c]) => c.estDays).map(([, c]) => `${c.name}: ${c.estDays} дн. по оценке`).join('; ');
  return `<div class="card"><h3>Прибыли и убытки · ${D(S.m.from)} — ${D(S.m.to)} ${demoBadge()}</h3>
    <div class="sc"><table><thead><tr><th>Статья</th>${cols.map((c) => `<th class="num">${name[c]}</th>`).join('')}<th class="num">% от выручки</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="mut small">Налог: ${S.m.settings.taxMode === 'income' ? 'УСН «доходы»' : 'УСН «доходы минус расходы»'}, ${S.m.settings.taxPct}%. ${est ? 'Нет финотчёта — ' + esc(est) + ' (комиссия и логистика из настроек).' : ''}</p></div>`;
};

V.tasks = () => {
  const cols = [['new', 'Новые'], ['work', 'В работе'], ['done', 'Готово']];
  return `<form class="form" id="taskForm">
    <input name="title" placeholder="Новая задача" required style="flex:1;min-width:200px">
    <select name="pri"><option value="hi">Высокий</option><option value="me" selected>Средний</option><option value="lo">Низкий</option></select>
    <input name="due" type="date">
    <button class="btn p">Добавить</button></form>
  <div class="kan">${cols.map(([s, t]) => {
    const l = S.tasks.filter((x) => x.status === s);
    return `<div class="kc" data-col="${s}"><h4>${t}<span class="mut">${l.length}</span></h4>${l.map((x) => `<div class="item" draggable="true" data-id="${esc(x.id)}">
      <div>${x.ch ? chTag(x.ch) : ''}${esc(x.title)}</div>${x.text ? `<div class="mut small">${esc(x.text)}</div>` : ''}
      <div class="meta"><span class="tag ${x.pri}">${PRI[x.pri] || ''}</span>${x.due ? `<span class="${x.due < isoD(new Date()) && s !== 'done' ? 'dn' : ''}">до ${D(x.due)}</span>` : ''}<span>создана ${D(x.created)}</span>
      <button class="btn sm" data-tdel="${esc(x.id)}" style="margin-left:auto">✕</button></div></div>`).join('')}</div>`;
  }).join('')}</div>`;
};

V.int = () => {
  const st = S.m.status, sy = st.sync, S2 = S.m.settings;
  const stl = (k) => { const x = sy[k]; return x ? `<span class="st ${x.status}" title="${esc(x.msg)}">${{ ok: 'подключено', partial: 'частично', error: 'ошибка', running: 'загрузка', none: 'нет ключей' }[x.status] || x.status}</span>` : '<span class="st none">нет данных</span>'; };
  const line = (name, what, k) => `<div class="li"><span><b>${name}</b><div class="mut small">${what}${sy[k]?.msg ? ' · ' + esc(sy[k].msg) : ''}${sy[k]?.at ? ' · ' + new Date(sy[k].at).toLocaleString('ru-RU') : ''}</div></span>${stl(k)}</div>`;
  const KEY_NAMES = { wb: 'WB: статистика, цены, акции', wbAdv: 'WB: Продвижение (если отдельный)', ozClientId: 'Ozon Seller: Client-Id', ozApiKey: 'Ozon Seller: Api-Key', ozPerfClientId: 'Ozon Performance: client_id', ozPerfSecret: 'Ozon Performance: client_secret', anthropic: 'ИИ-ассистент' };
  const num = (k, label) => `<label>${label}<input name="${k}" type="number" step="any" value="${esc(S2[k])}"></label>`;
  const man = st.manual;
  return `<div class="grid"><div class="col">
    <div class="card"><h3>Источники данных</h3>
      ${line('Wildberries · заказы', 'Statistics API', 'wb.orders')}
      ${line('Wildberries · остатки', 'Statistics API', 'wb.stocks')}
      ${line('Wildberries · реализация', 'финансы, комиссия, логистика', 'wb.realization')}
      ${line('Wildberries · цены', 'Prices API', 'wb.prices')}
      ${line('WB Продвижение', 'реклама, расход по кампаниям', 'wb.ads')}
      ${line('WB · акции', 'календарь акций', 'wb.promos')}
      ${line('Ozon Seller · заказы', 'аналитика', 'ozon.orders')}
      ${line('Ozon Seller · финансы', 'транзакции, услуги', 'ozon.finance')}
      ${line('Ozon Seller · остатки', 'склады', 'ozon.stocks')}
      ${line('Ozon Seller · цены', '', 'ozon.prices')}
      ${line('Ozon · акции', '', 'ozon.promos')}
      ${line('Ozon Performance', 'реклама', 'ozon.ads')}
      <p class="mut small">Последняя синхронизация: ${st.lastSync ? new Date(st.lastSync).toLocaleString('ru-RU') : 'не было'}. Автообновление каждые 3 часа.</p>
    </div>
    ${uploadBlock('wbFin', 'WB — отчёты о реализации вручную', 'Если API отвечает 429 «слишком частые запросы», скачайте в кабинете WB: Финансы → Отчёты → еженедельный детализированный отчёт → Скачать Excel. Можно сразу несколько файлов. Отчёт за тот же период заменяет прежний.', man.wbFin.length ? `● ${man.wbFin.map((r) => D(r.from) + '–' + D(r.to)).join(', ')}` : '○ не загружено', true)}
    ${uploadBlock('wbPrices', 'WB — цены вручную', 'Кабинет WB: Цены и скидки → Скачать Excel. Используются, если API не вернул цен.', man.wbPrices ? `● ${man.wbPrices} цен` : '○ не загружено')}
    ${uploadBlock('ozFin', 'Ozon — отчёт о начислениях вручную', 'Кабинет Ozon: Финансы → Начисления → Скачать Excel. Начисления разносятся по статьям (выручка, комиссия, логистика, реклама, штрафы, хранение) по названию типа начисления.', man.ozFin.length ? `● ${man.ozFin.map((r) => D(r.from) + '–' + D(r.to)).join(', ')}` : '○ не загружено', true)}
    ${uploadBlock('costs', 'Себестоимость — загрузка вручную', 'Excel или CSV с колонками «Артикул» (или «Штрихкод»/«Название») и «Себестоимость».', man.costs ? `● ${man.costs} позиций` : '○ не загружена')}
  </div><div class="col">
    <div class="card"><h3>Ключи API <span class="mut small">${st.envLoaded ? 'файл .env найден' : '<span class="me">файл .env не найден</span>'}</span></h3>
      ${st.keys.map((x) => `<div class="li"><span>${KEY_NAMES[x.k] || x.k}<div class="mut small"><code>${x.env}</code></div></span>${x.set ? '<span class="st ok">задан</span>' : x.k === 'wbAdv' ? '<span class="st none">берётся WB_TOKEN</span>' : '<span class="st none">не задан</span>'}</div>`).join('')}
      <p class="mut small">Ключи хранятся в файле <code>.env</code> в папке проекта (образец — <code>.env.example</code>). После изменения .env перезапустите сервер, синхронизация начнётся сама.</p>
    </div>
    <form class="card" id="setForm"><h3>Настройки расчётов</h3>
      <div class="fgrid">
        <label>Налог<select name="taxMode"><option value="income" ${S2.taxMode === 'income' ? 'selected' : ''}>УСН доходы</option><option value="profit" ${S2.taxMode === 'profit' ? 'selected' : ''}>УСН доходы − расходы</option></select></label>
        ${num('taxPct', 'Ставка налога, %')}
        ${num('planMonth', 'План выручки на месяц, ₽')}
        ${num('fixedMonthly', 'Постоянные расходы в месяц, ₽')}
        ${num('targetMarginPct', 'Целевая маржа, %')}
        ${num('drrMaxPct', 'Допустимый ДРР, %')}
        ${num('leadTimeDays', 'Срок поставки, дн.')}
        ${num('safetyDays', 'Страховой запас, дн.')}
        ${num('overstockDays', 'Затоварка от, дн.')}
        ${num('kizDeadlineDays', 'Срок вывода КИЗ, раб. дн.')}
      </div>
      <details><summary>Оценка для дней без финотчёта</summary><div class="fgrid">
        ${num('wbCommissionPct', 'WB комиссия, %')}${num('wbLogisticsPerUnit', 'WB логистика, ₽/шт')}${num('wbBuyoutPct', 'WB выкуп, %')}
        ${num('ozCommissionPct', 'Ozon комиссия, %')}${num('ozLogisticsPerUnit', 'Ozon логистика, ₽/шт')}${num('ozBuyoutPct', 'Ozon выкуп, %')}
      </div></details>
      <button class="btn p">Сохранить</button>
    </form>
  </div></div>`;
};

function uploadBlock(kind, title, text, state, multiple) {
  return `<div class="card up-block"><h3>${title}<span class="small">${state}</span></h3><p>${text}</p>
    <div class="form"><label class="btn p">Загрузить файл<input type="file" hidden accept=".xlsx,.xls,.csv" data-up="${kind}" ${multiple ? 'multiple' : ''}></label>
    <button class="btn" data-clear="${kind}">Удалить загруженное</button></div></div>`;
}

// ---------- рендер
function render() {
  if (!S.m) return;
  const el = $('#v-' + S.view);
  el.innerHTML = V[S.view]();
  $('#title').textContent = TITLES[S.view];
  $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + S.view));
  $$('#chSeg button').forEach((b) => b.classList.toggle('on', b.dataset.ch === S.ch));
  $('#decCnt').textContent = S.m.decisions.filter((d) => d.pri === 'hi').length || '';
  $('#czCnt').textContent = S.m.kizTotals.overdue || '';
  $('#demoNote').hidden = !Object.values(S.m.channels).some((c) => c.demo);
  const st = S.m.status;
  $('#sync').textContent = st.syncing ? 'Идёт синхронизация…' : st.lastSync ? 'Обновлено ' + new Date(st.lastSync).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  if (S.view === 'tasks') bindKanban();
}

function go(v) { S.view = v; persist(); render(); $('#side').classList.remove('on'); window.scrollTo(0, 0); }

// ---------- события
$$('.nav').forEach((b) => (b.onclick = () => go(b.dataset.v)));
$('#burger').onclick = () => $('#side').classList.toggle('on');
$$('#chSeg button').forEach((b) => (b.onclick = () => { S.ch = b.dataset.ch; persist(); render(); }));
$('#period').onchange = () => { $('#customDates').hidden = $('#period').value !== 'custom'; persist(); load(); };
$('#dFrom').onchange = $('#dTo').onchange = load;
let qT; $('#q').oninput = (e) => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value; render(); }, 150); };
$('#refresh').onclick = async () => { await J('/api/refresh', { method: 'POST' }); toast('Синхронизация запущена'); pollSync(); };

async function pollSync() {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await J('/api/status').catch(() => null);
    if (st && !st.syncing) { await load(); toast('Данные обновлены'); return; }
    if (st) $('#sync').textContent = 'Идёт синхронизация…';
  }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-go],[data-task],[data-clear],[data-supdel],[data-tdel],#kizAll,#kizTxt,#kizDone,#kizUndo');
  if (!t) return;
  try {
    if (t.dataset.go) go(t.dataset.go);
    else if (t.dataset.task) {
      const d = S.m.decisions.find((x) => x.id === t.dataset.task);
      S.tasks = await J('/api/tasks', { method: 'POST', body: { title: d.title, text: d.text, ch: d.ch, pri: d.pri } });
      toast('Задача создана'); t.disabled = true;
    } else if (t.dataset.clear) {
      if (!confirm('Удалить загруженные данные этого типа?')) return;
      await J('/api/upload/' + t.dataset.clear, { method: 'DELETE' }); toast('Удалено'); load();
    } else if (t.dataset.supdel) { await J('/api/supplies', { method: 'DELETE', body: { id: t.dataset.supdel } }); load(); }
    else if (t.dataset.tdel) { S.tasks = await J('/api/tasks', { method: 'DELETE', body: { id: t.dataset.tdel } }); render(); }
    else if (t.id === 'kizAll') { S.kizSel = new Set(F(S.m.kiz).filter((k) => k.status !== 'done').map((k) => k.kiz)); render(); }
    else if (t.id === 'kizTxt') {
      if (!S.kizSel.size) return toast('Сначала отметьте коды');
      const blob = new Blob([[...S.kizSel].join('\r\n') + '\r\n'], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `vyvod_kiz_${isoD(new Date())}.txt`; a.click(); URL.revokeObjectURL(a.href);
    } else if (t.id === 'kizDone' || t.id === 'kizUndo') {
      if (!S.kizSel.size) return toast('Сначала отметьте коды');
      await J(t.id === 'kizDone' ? '/api/kiz/done' : '/api/kiz/undo', { method: 'POST', body: { kiz: [...S.kizSel] } });
      S.kizSel.clear(); load();
    }
  } catch (err) { toast(err.message); }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.kiz) { t.checked ? S.kizSel.add(t.dataset.kiz) : S.kizSel.delete(t.dataset.kiz); $('#kizTxt').textContent = `Скачать TXT (${S.kizSel.size})`; return; }
  if (t.dataset.up) {
    if (typeof XLSX === 'undefined') return toast('Библиотека чтения Excel не загрузилась — проверьте интернет');
    for (const f of t.files) {
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false });
        // берём лист с наибольшим числом строк
        const rows = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true })).sort((a, b) => b.length - a.length)[0];
        const r = await J('/api/upload/' + t.dataset.up, { method: 'POST', body: { rows, name: f.name } });
        toast(`${f.name}: ${r.msg}`);
      } catch (err) { toast(`${f.name}: ${err.message}`); }
    }
    t.value = ''; load();
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target; if (!['setForm', 'supForm', 'taskForm'].includes(f.id)) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(f));
  try {
    if (f.id === 'setForm') { await J('/api/settings', { method: 'POST', body: data }); toast('Настройки сохранены'); load(); }
    else if (f.id === 'supForm') { await J('/api/supplies', { method: 'POST', body: data }); load(); }
    else if (f.id === 'taskForm') { S.tasks = await J('/api/tasks', { method: 'POST', body: data }); render(); }
  } catch (err) { toast(err.message); }
});

function bindKanban() {
  $$('.item[draggable]').forEach((it) => (it.ondragstart = (e) => e.dataTransfer.setData('text/plain', it.dataset.id)));
  $$('.kc').forEach((c) => {
    c.ondragover = (e) => { e.preventDefault(); c.classList.add('over'); };
    c.ondragleave = () => c.classList.remove('over');
    c.ondrop = async (e) => { e.preventDefault(); c.classList.remove('over'); S.tasks = await J('/api/tasks', { method: 'PUT', body: { id: e.dataTransfer.getData('text/plain'), status: c.dataset.col } }); render(); };
  });
}

// ---------- ИИ-чат
$('#aiOpen').onclick = () => $('#drawer').classList.add('on');
$('#aiClose').onclick = () => $('#drawer').classList.remove('on');
$$('#chips .btn').forEach((b) => (b.onclick = () => ask(b.textContent)));
$('#chatForm').onsubmit = (e) => { e.preventDefault(); const v = $('#chatIn').value.trim(); if (v) { $('#chatIn').value = ''; ask(v); } };
function drawChat() { $('#chat').innerHTML = S.chat.map((m) => `<div class="msg ${m.role === 'user' ? 'u' : ''}">${esc(m.content)}</div>`).join(''); $('#chat').scrollTop = 1e9; }
async function ask(q) {
  S.chat.push({ role: 'user', content: q }); S.chat.push({ role: 'assistant', content: 'Думаю…' }); drawChat();
  const [from, to] = range();
  try { const r = await J('/api/chat', { method: 'POST', body: { messages: S.chat.slice(0, -1), from, to } }); S.chat[S.chat.length - 1].content = r.answer; }
  catch (err) { S.chat[S.chat.length - 1].content = 'Ошибка: ' + err.message; }
  drawChat();
}

// ---------- старт
try { const s = JSON.parse(localStorage.getItem('mpdash') || '{}'); if (s.period) $('#period').value = s.period; } catch {}
$('#customDates').hidden = $('#period').value !== 'custom';
load();
