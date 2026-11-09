const WSOL = 'So11111111111111111111111111111111111111112';

/** SOL/USD from public endpoints. Returns null if none respond (the UI then shows SOL values). */
export async function fetchSolUsd() {
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(5000) });
    const v = Number((await r.json())?.data?.amount);
    if (v > 0) return v;
  } catch {
    /* try next */
  }
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, { signal: AbortSignal.timeout(5000) });
    const v = Number((await r.json())?.[WSOL]?.usdPrice);
    if (v > 0) return v;
  } catch {
    /* give up */
  }
  return null;
}
