import { clamp } from './util.js';

const pctStr = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

/**
 * Heuristic risk score 0-100 (higher = riskier) built from data the terminal
 * already has for free (trade stream) plus optional on-chain verification.
 * It is a screening aid, not a safety guarantee.
 */
export function assess({ t, top, dev, snipePct, snipeCount, w5, now, onchain }) {
  const flags = [];
  let score = 0;
  const add = (id, sev, label, detail, pts = 0) => {
    flags.push({ id, sev, label, detail });
    score += pts;
  };

  const age = now - t.createdAt;
  const ledgerOk = !t.partial && !t.ledgerFull;
  const verified = Boolean(onchain && !onchain.error);

  // Authorities (on-chain only)
  if (verified) {
    if (onchain.mintAuthority) add('mint', 'bad', 'Mint authority active', 'Supply can be inflated', 30);
    else add('mint', 'ok', 'Mint authority revoked', 'Supply is fixed');
    if (onchain.freezeAuthority) add('freeze', 'bad', 'Freeze authority active', 'Token accounts can be frozen', 30);
    else add('freeze', 'ok', 'Freeze authority revoked', 'Accounts cannot be frozen');
  } else if (onchain?.error) {
    add('auth', 'info', 'On-chain check failed', onchain.error);
  } else {
    add('auth', 'info', 'Authorities unchecked', 'Press Verify on-chain to check mint and freeze authority');
  }

  // Dev behaviour
  switch (dev.status) {
    case 'sold_all':
      add('dev', 'bad', 'Dev sold everything', 'Creator wallet holds nothing after selling', 30);
      break;
    case 'sold_some':
      add('dev', 'warn', 'Dev is selling', `Creator sold ${pctStr(dev.sold / Math.max(dev.bought, 1e-9))} of what they bought`, 12);
      break;
    case 'holding':
      if (dev.pct >= 0.15) add('dev', 'warn', 'Dev holds a lot', `Creator holds ${pctStr(dev.pct)} of supply`, 10);
      else add('dev', 'ok', 'Dev holding', `Creator holds ${pctStr(dev.pct)} of supply`);
      break;
    case 'none':
      add('dev', 'ok', 'Dev holds nothing', 'No creator holdings seen');
      break;
    default:
      add('dev', 'info', 'Dev history unknown', 'Token was first seen mid-life');
  }

  // Concentration
  const top10 = verified && onchain.top10Pct != null ? onchain.top10Pct : top.top10Pct;
  const top1 = verified && onchain.top1Pct != null ? onchain.top1Pct : top.top[0]?.pct ?? 0;
  const src = verified && onchain.top10Pct != null ? 'on-chain' : ledgerOk ? 'live ledger' : 'partial ledger';
  if (top10 != null && (verified || top.top.length >= 5)) {
    if (top10 >= 0.5) add('top10', 'bad', 'Top 10 hold most supply', `${pctStr(top10)} (${src})`, 25);
    else if (top10 >= 0.3) add('top10', 'warn', 'Concentrated holders', `Top 10 hold ${pctStr(top10)} (${src})`, 12);
    else add('top10', 'ok', 'Holders well spread', `Top 10 hold ${pctStr(top10)} (${src})`);
    if (top1 >= 0.12) add('top1', 'bad', 'Single wallet too large', `Largest holder has ${pctStr(top1)}`, 15);
    else if (top1 >= 0.06) add('top1', 'warn', 'Large single holder', `Largest holder has ${pctStr(top1)}`, 6);
  }
  if (!ledgerOk && !verified) add('ledger', 'info', 'Partial holder data', 'Seen mid-life; verify on-chain for real numbers');

  // Launch quality
  if (!t.partial) {
    if (t.bundled) add('bundle', 'bad', 'Bundled launch', 'Several wallets bought in the creation slot', 15);
    if (snipeCount > 0) {
      if (snipePct >= 0.2) add('snipe', 'bad', 'Snipers hold a lot', `${snipeCount} early wallets hold ${pctStr(snipePct)}`, 20);
      else if (snipePct >= 0.08) add('snipe', 'warn', 'Sniper exposure', `${snipeCount} early wallets hold ${pctStr(snipePct)}`, 10);
      else add('snipe', 'info', 'Early snipers', `${snipeCount} early wallets hold ${pctStr(snipePct)}`);
    }
  }

  // Activity
  const holders = t.balances.size;
  if (ledgerOk && age > 120_000 && holders < 25) add('holders', 'warn', 'Few holders', `${holders} holders after ${Math.round(age / 60000)}m`, 6);
  if (w5.v >= 2) {
    const buyShare = w5.bv / w5.v;
    if (buyShare < 0.4) add('flow', 'warn', 'Sell pressure', `Only ${Math.round(buyShare * 100)}% of 5m volume is buying`, 8);
    else if (buyShare > 0.6) add('flow', 'ok', 'Buy pressure', `${Math.round(buyShare * 100)}% of 5m volume is buying`);
  }
  if (!t.partial && age < 60_000) add('age', 'info', 'Brand new', 'Under a minute old: expect extreme volatility');

  score = clamp(Math.round(score), 0, 100);
  const level = score >= 55 ? 'HIGH' : score >= 25 ? 'MED' : 'LOW';
  return { score, level, verified, flags };
}
