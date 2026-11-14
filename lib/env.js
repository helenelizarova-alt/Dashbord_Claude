// Ключи API берутся только из .env (или переменных окружения). В базу и во фронт они не попадают.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

export function loadEnv() {
  try { process.loadEnvFile(ENV_FILE); return true; }
  catch (e) { if (e.code !== 'ENOENT') console.error('.env:', e.message); return false; }
}

// Имя переменной в .env → ключ, который используют wb.js / ozon.js
export const ENV_KEYS = {
  wb: 'WB_TOKEN',
  wbAdv: 'WB_ADV_TOKEN',
  ozClientId: 'OZON_CLIENT_ID',
  ozApiKey: 'OZON_API_KEY',
  ozPerfClientId: 'OZON_PERF_CLIENT_ID',
  ozPerfSecret: 'OZON_PERF_SECRET',
  anthropic: 'ANTHROPIC_API_KEY',
};

export function tokens() {
  const t = {};
  for (const [k, env] of Object.entries(ENV_KEYS)) { const v = (process.env[env] || '').trim(); if (v) t[k] = v; }
  return t;
}
