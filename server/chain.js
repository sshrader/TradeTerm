const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * On-chain verification of a mint: authorities and real top-holder concentration.
 * Costs roughly 4 RPC calls. Token accounts owned by programs (bonding curve, pool vaults)
 * are labelled "program" and excluded from the wallet concentration numbers.
 */
export async function verifyMint(rpc, mint) {
  const [info, largest] = await Promise.all([
    rpc.call('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    rpc.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
  ]);
  const parsed = info?.value?.data?.parsed;
  if (!parsed || parsed.type !== 'mint') throw new Error('Not an SPL mint account.');
  const m = parsed.info;
  const supply = Number(m.supply);

  const rows = (largest?.value || []).slice(0, 20);
  let holders = [];
  if (rows.length) {
    const accs = await rpc.call('getMultipleAccounts', [rows.map((r) => r.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const owners = accs.value.map((a) => a?.data?.parsed?.info?.owner || null);
    const uniq = [...new Set(owners.filter(Boolean))];
    let kind = new Map();
    if (uniq.length) {
      const oa = await rpc.call('getMultipleAccounts', [uniq, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
      kind = new Map(uniq.map((o, i) => [o, !oa.value[i] || oa.value[i].owner === SYSTEM_PROGRAM ? 'wallet' : 'program']));
    }
    holders = rows.map((r, i) => ({
      owner: owners[i],
      pct: supply > 0 ? Number(r.amount) / supply : 0,
      kind: owners[i] ? kind.get(owners[i]) : 'unknown',
    }));
  }
  const wallets = holders.filter((h) => h.kind === 'wallet');
  return {
    mintAuthority: m.mintAuthority || null,
    freezeAuthority: m.freezeAuthority || null,
    supply,
    decimals: m.decimals,
    holders,
    top1Pct: wallets[0]?.pct ?? 0,
    top10Pct: wallets.slice(0, 10).reduce((a, h) => a + h.pct, 0),
    checkedAt: Date.now(),
  };
}
