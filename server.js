// Сервер дашборда: статика из public/, JSON API, синхронизация с WB/Ozon в фоне.
// Запуск: npm install && npm start  →  http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, save, setSync, DEFAULT_SETTINGS } from './lib/store.js';
import { syncWb } from './lib/wb.js';
import { syncOzon } from './lib/ozon.js';
import { compute, aiContext } from './lib/calc.js';
import { parseWbRealization, parseOzAccruals, parseWbPrices, parseCosts, parseKiz } from './lib/manual.js';
import { askAssistant } from './lib/ai.js';
import { today, addDays } from './lib/util.js';
import { loadEnv, tokens, ENV_KEYS } from './lib/env.js';

const envLoaded = loadEnv();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // только локально. Для доступа извне поставьте за прокси с авторизацией.
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const db = load();
let syncing = false;

async function runSync() {
  if (syncing) return;
  syncing = true;
  try {
    const t = tokens();
    if (t.wb) { setSync('wb', 'running', 'идёт загрузка…'); db.data.wb = await syncWb(t); save(); }
    if (t.ozClientId && t.ozApiKey) { setSync('ozon', 'running', 'идёт загрузка…'); db.data.ozon = await syncOzon(t); save(); }
    db.lastSync = new Date().toISOString(); save();
  } catch (e) { console.error('sync', e); }
  finally { syncing = false; }
}
// автообновление раз в 3 часа
setInterval(runSync, 3 * 3600e3).unref();

function status() {
  const t = tokens();
  // во фронт уходят только имя переменной и признак «задан», без значений
  const keys = Object.entries(ENV_KEYS).map(([k, env]) => ({ k, env, set: !!t[k] }));
  const m = db.manual;
  return {
    syncing, lastSync: db.lastSync || null, sync: db.sync, keys, envLoaded,
    manual: {
      wbFin: m.wbFin.map((r) => ({ from: r.from, to: r.to, name: r.name, rows: r.fin.length })),
      ozFin: m.ozFin.map((r) => ({ from: r.from, to: r.to, name: r.name, rows: r.fin.length })),
      wbPrices: m.wbPrices ? Object.keys(m.wbPrices).length : 0,
      costs: m.costs ? Object.keys(m.costs.bySku).length + Object.keys(m.costs.byBarcode).length + Object.keys(m.costs.byName).length : 0,
      kiz: m.kiz.length,
    },
  };
}

const UPLOADS = {
  // повторная загрузка отчёта за тот же период заменяет прежний
  wbFin: (rows, name) => { const r = parseWbRealization(rows); db.manual.wbFin = db.manual.wbFin.filter((x) => x.from !== r.from || x.to !== r.to).concat({ ...r, name }); return `Отчёт ${r.from} — ${r.to}, строк: ${r.fin.length}`; },
  ozFin: (rows, name) => { const r = parseOzAccruals(rows); db.manual.ozFin = db.manual.ozFin.filter((x) => x.from !== r.from || x.to !== r.to).concat({ ...r, name }); return `Отчёт ${r.from} — ${r.to}, строк: ${r.fin.length}`; },
  wbPrices: (rows) => { const p = parseWbPrices(rows); db.manual.wbPrices = p; return `Цен: ${Object.keys(p).length}`; },
  costs: (rows) => { const c = parseCosts(rows); const o = db.manual.costs || { bySku: {}, byBarcode: {}, byName: {} }; db.manual.costs = { bySku: { ...o.bySku, ...c.bySku }, byBarcode: { ...o.byBarcode, ...c.byBarcode }, byName: { ...o.byName, ...c.byName } }; return `Себестоимость: ${Object.keys(c.bySku).length + Object.keys(c.byBarcode).length + Object.keys(c.byName).length} позиций`; },
  kiz: (rows) => { const k = parseKiz(rows); const have = new Set(db.manual.kiz.map((x) => x.kiz)); const add = k.filter((x) => !have.has(x.kiz)); db.manual.kiz.push(...add); return `Добавлено КИЗ: ${add.length} (дубликатов пропущено: ${k.length - add.length})`; },
};
const CLEAR = { wbFin: () => (db.manual.wbFin = []), ozFin: () => (db.manual.ozFin = []), wbPrices: () => (db.manual.wbPrices = null), costs: () => (db.manual.costs = null), kiz: () => { db.manual.kiz = []; db.kizDone = {}; } };

async function api(req, res, url) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' ? await readBody(req) : null;
  const p = url.pathname;

  if (p === '/api/dashboard' && req.method === 'GET') {
    const to = url.searchParams.get('to') || today();
    const from = url.searchParams.get('from') || addDays(to, -29);
    return send(200, { ...compute(db, from, to), status: status() });
  }
  if (p === '/api/status') return send(200, status());
  if (p === '/api/refresh' && req.method === 'POST') { runSync(); return send(200, { started: true }); }
  if (p === '/api/settings' && req.method === 'POST') {
    for (const [k, v] of Object.entries(body)) if (k in DEFAULT_SETTINGS) db.settings[k] = typeof DEFAULT_SETTINGS[k] === 'number' ? Number(v) || 0 : String(v);
    save(); return send(200, db.settings);
  }
  let m;
  if ((m = p.match(/^\/api\/upload\/(\w+)$/)) && req.method === 'POST') {
    const fn = UPLOADS[m[1]];
    if (!fn) return send(404, { error: 'неизвестный тип файла' });
    try { const msg = fn(body.rows || [], body.name || ''); save(); return send(200, { ok: true, msg }); }
    catch (e) { return send(400, { error: e.message }); }
  }
  if ((m = p.match(/^\/api\/upload\/(\w+)$/)) && req.method === 'DELETE') { CLEAR[m[1]]?.(); save(); return send(200, { ok: true }); }
  if (p === '/api/kiz/done' && req.method === 'POST') { for (const k of body.kiz || []) db.kizDone[k] = today(); save(); return send(200, { ok: true }); }
  if (p === '/api/kiz/undo' && req.method === 'POST') { for (const k of body.kiz || []) delete db.kizDone[k]; save(); return send(200, { ok: true }); }
  if (p === '/api/supplies') {
    if (req.method === 'POST') { db.supplies.push({ id: Date.now().toString(36), ...pickSupply(body) }); save(); }
    if (req.method === 'DELETE') { db.supplies = db.supplies.filter((s) => s.id !== body.id); save(); }
    return send(200, db.supplies);
  }
  if (p === '/api/tasks') {
    if (req.method === 'POST') { const t = { id: Date.now().toString(36), status: 'new', pri: 'me', created: today(), ...body }; db.tasks.push(t); save(); }
    if (req.method === 'PUT') { const t = db.tasks.find((x) => x.id === body.id); if (t) Object.assign(t, body); save(); }
    if (req.method === 'DELETE') { db.tasks = db.tasks.filter((x) => x.id !== body.id); save(); }
    return send(200, db.tasks);
  }
  if (p === '/api/chat' && req.method === 'POST') {
    const to = body.to || today(), from = body.from || addDays(to, -29);
    const answer = await askAssistant(body.messages || [], aiContext(compute(db, from, to)));
    return send(200, { answer });
  }
  send(404, { error: 'not found' });
}

const pickSupply = (b) => ({ ch: b.ch === 'ozon' ? 'ozon' : 'wb', wh: String(b.wh || ''), date: String(b.date || ''), sku: String(b.sku || ''), qty: Number(b.qty) || 0, status: String(b.status || 'План') });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 80e6) { reject(new Error('слишком большой файл')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = path.join(PUB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, HOST, () => console.log(`Дашборд: http://localhost:${PORT}`));

// ключ убрали из .env — забываем загруженные по нему данные, канал уходит в демо/ручные отчёты
{
  const t = tokens();
  if (!t.wb) db.data.wb = null;
  if (!t.ozClientId || !t.ozApiKey) db.data.ozon = null;
  save();
  console.log(envLoaded ? 'Ключи прочитаны из .env' : 'Файл .env не найден — скопируйте .env.example в .env');
  if (t.wb || (t.ozClientId && t.ozApiKey)) runSync();
}
