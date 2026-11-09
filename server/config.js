import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSecret } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependencies). Real environment variables win.
function loadEnvFile(file) {
  let txt;
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const num = (k, d) => {
  const raw = process.env[k];
  if (raw === undefined || raw === '') return d;
  const v = Number(raw);
  return Number.isFinite(v) ? v : d;
};

const argv = process.argv.slice(2);
const key = (process.env.HELIUS_API_KEY || '').trim();
addSecret(key);

const forcedDemo = argv.includes('--demo') || process.env.DEMO === '1';
const demo = forcedDemo || !key;

export const config = {
  version: '0.1.0',
  host: '127.0.0.1',
  port: num('PORT', 8787),
  openBrowser: argv.includes('--open'),
  demo,
  demoReason: forcedDemo ? 'flag' : !key ? 'no-key' : null,
  hasKey: Boolean(key),
  rpcUrl: key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : null,
  wsUrl: key ? `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : null,
  creditBudget: num('HELIUS_MONTHLY_CREDITS', 1_000_000),
  rpcMaxRps: num('RPC_MAX_RPS', 8),
  maxTokens: num('MAX_TOKENS', 800),
  partialMinSol: num('PARTIAL_MIN_SOL', 0.5),
  defaultFeeBps: 125,
  dataDir: path.join(ROOT, 'data'),
  paper: {
    startSol: num('PAPER_START_SOL', 10),
    maxPositionSol: num('MAX_POSITION_SOL', 1),
    maxOpen: num('MAX_OPEN_POSITIONS', 5),
    dailyLossCapSol: num('DAILY_LOSS_CAP_SOL', 2),
    slippageBps: num('PAPER_SLIPPAGE_BPS', 50),
    priorityFeeSol: num('PAPER_PRIORITY_FEE_SOL', 0.001),
  },
};
