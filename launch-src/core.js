// Creates the TradeTerm coin on pump.fun's bonding curve and does the owner's dev buy in the SAME transaction.
// Ported from the Sparkpad project, where this exact flow was tested on devnet. Runs in the browser: your wallet signs,
// no key ever touches the server.
//
// Create + buy is about 1500 bytes, over the 1232 byte limit, so it is sent as a version 0 transaction with an address lookup
// table (a list of shared addresses stored on-chain). The table is made once per wallet, which costs one or two extra wallet approvals.
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const MAX_TX_BYTES = 1232;
const LUT_CHUNK = 18;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));


function config(network) {
  // Every call goes through this server's allowlisted proxy (the page's security policy allows no other address),
  // so confirmation is by polling, not by websocket.
  const rpc = window.location.origin + '/api/launch/rpc/' + network;
  return network === 'mainnet'
    ? { label: 'Mainnet', mainnet: true, poll: true, priority: 300000, explorer: '', rpc }
    : { label: 'Devnet', mainnet: false, poll: true, priority: 0, explorer: '?cluster=devnet', rpc };
}

function message(e) {
  if (e && e.code === 4001) return 'You declined the request.';
  let m = (e && e.message) || String(e);
  const logs = e && e.logs;
  if (Array.isArray(logs) && logs.length) m += ' Logs: ' + logs.slice(-3).join(' | ');
  return m;
}

async function phase(step, label, fn) {
  const done = step(label);
  try { return await fn(done); } catch (e) { done('err', message(e)); throw e; }
}

const txUrl = (cfg, sig) => 'https://explorer.solana.com/tx/' + sig + cfg.explorer;
const addrUrl = (cfg, a) => 'https://explorer.solana.com/address/' + a + cfg.explorer;

async function checkNetwork(conn, cfg) {
  const genesis = await conn.getGenesisHash();
  if (cfg.mainnet && genesis !== MAINNET_GENESIS) throw new Error('The mainnet connection is not answering as mainnet. Refusing to continue.');
  if (!cfg.mainnet && genesis === MAINNET_GENESIS) throw new Error('This RPC is mainnet. Refusing to continue.');
}

async function pollConfirm(conn, sig, raw, lastValidBlockHeight) {
  for (let i = 0; i < 80; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st && st.err) throw new Error('Transaction failed: ' + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return;
    if (i > 0 && i % 4 === 0) {
      try { await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); } catch (e) { /* the first send may already have landed */ }
      if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error('The transaction expired before it was confirmed. Nothing was spent. Try again.');
    }
    await wait(1200);
  }
  throw new Error('Still waiting for confirmation after about 90 seconds. Check the signature on Solana Explorer before trying again.');
}

export async function airdrop(address, sol = 1) {
  const cfg = config('devnet');
  const conn = new Connection(cfg.rpc, 'confirmed');
  const sig = await conn.requestAirdrop(new PublicKey(address), sol * LAMPORTS_PER_SOL);
  for (let i = 0; i < 40; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st && st.err) throw new Error('The airdrop failed: ' + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await wait(1500);
  }
  throw new Error('The airdrop is taking long. Devnet faucets are often rate limited; try again in a minute.');
}

// Dry run, wallet signs, the new mint signs, send, confirm. Returns the signature.
async function signAndSend({ step, conn, cfg, wallet, tx, extraSigner, labels, dryRetries }) {
  await phase(step, labels.dry, async (done) => {
    let sim = null;
    for (let i = 0; i <= (dryRetries || 0); i++) {
      sim = await conn.simulateTransaction(tx);
      if (!sim.value.err) break;
      if (i < (dryRetries || 0)) await wait(1500);
    }
    if (sim.value.err) {
      const tail = (sim.value.logs || []).slice(-4).join(' | ');
      throw new Error('The network rejected the dry run: ' + JSON.stringify(sim.value.err) + (tail ? '. ' + tail : ''));
    }
    done('ok', 'Passed, ' + (sim.value.unitsConsumed || '?') + ' compute units');
  });

  // The wallet signs first, then the new mint signs, so a wallet that adjusts the transaction cannot invalidate the mint's signature.
  const signed = await phase(step, labels.sign, async (done) => {
    const s = await wallet.signTransaction(tx);
    if (extraSigner) { if (typeof s.partialSign === 'function') s.partialSign(extraSigner); else s.sign([extraSigner]); }
    done('ok', extraSigner ? 'Signed by your wallet and the new coin' : 'Signed by your wallet');
    return s;
  });

  return await phase(step, labels.send, async (done) => {
    const latest = await conn.getLatestBlockhash('confirmed');
    const raw = signed.serialize();
    // Resending the same signed transaction is safe: it can only land once.
    let sig = null;
    for (let i = 0; i < 6 && !sig; i++) {
      try {
        sig = await conn.sendRawTransaction(raw, { skipPreflight: i >= 4, preflightCommitment: 'processed' });
      } catch (e) {
        if (i === 5 || !/blockhash not found/i.test(String((e && e.message) || e))) throw e;
        await wait(1200);
      }
    }
    if (cfg.poll) await pollConfirm(conn, sig, raw, latest.lastValidBlockHeight);
    else {
      const res = await conn.confirmTransaction({ signature: sig, blockhash: (signed.message && signed.message.recentBlockhash) || signed.recentBlockhash || latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
      if (res.value.err) throw new Error('Transaction failed: ' + JSON.stringify(res.value.err));
    }
    done('ok', 'Confirmed ' + sig.slice(0, 12) + '... View on Solana Explorer', txUrl(cfg, sig));
    return sig;
  });
}

const keysOf = (ixs) => {
  const out = new Set();
  for (const ix of ixs) { out.add(ix.programId.toBase58()); for (const k of ix.keys) out.add(k.pubkey.toBase58()); }
  return out;
};

// Addresses that are the same for every launch by this wallet: build the instructions for two throwaway mints and keep what they share.
async function sharedAddresses({ global, userKey, amount, lamports, name, symbol, uri }) {
  const build = (mint) => PUMP_SDK.createV2AndBuyV2Instructions({ global, mint, name, symbol, uri, creator: userKey, user: userKey, amount, quoteAmount: lamports, mayhemMode: false, slippage: 1 });
  const [a, b] = await Promise.all([build(Keypair.generate().publicKey), build(Keypair.generate().publicKey)]);
  const kb = keysOf(b);
  return [...keysOf(a)].filter((k) => kb.has(k) && k !== userKey.toBase58());
}

const lutKey = (cfg, userKey) => 'tradeterm-lut:' + cfg.label + ':' + userKey.toBase58();
const savedTable = (cfg, userKey) => { try { return localStorage.getItem(lutKey(cfg, userKey)); } catch (e) { return null; } };
const saveTable = (cfg, userKey, addr) => { try { localStorage.setItem(lutKey(cfg, userKey), addr); } catch (e) { /* only a convenience */ } };

async function ensureLookupTable({ step, conn, cfg, wallet, userKey, keys }) {
  return await phase(step, 'Lookup table', async (done) => {
    let table = null;
    let why = 'no saved table in this browser';
    const saved = savedTable(cfg, userKey);
    if (saved) {
      why = 'saved table could not be read';
      for (let i = 0; i < 4 && !table; i++) {
        try { table = (await conn.getAddressLookupTable(new PublicKey(saved), { commitment: 'confirmed' })).value; } catch (e) { table = null; }
        if (!table && i < 3) await wait(800);
      }
      if (table && !(table.state.authority && table.state.authority.equals(userKey))) { table = null; why = 'saved table is not controlled by this wallet'; }
    }
    const have = new Set(table ? table.state.addresses.map((x) => x.toBase58()) : []);
    const missing = keys.filter((k) => !have.has(k));
    if (table && !missing.length) { done('ok', 'Using your saved table ' + table.key.toBase58().slice(0, 6) + '...'); return { table, fresh: false }; }

    let tableKey = table ? table.key : null;
    const chunks = [];
    for (let i = 0; i < missing.length; i += LUT_CHUNK) chunks.push(missing.slice(i, i + LUT_CHUNK).map((k) => new PublicKey(k)));
    for (let i = 0; i < chunks.length; i++) {
      const n = chunks.length > 1 ? ' ' + (i + 1) + '/' + chunks.length : '';
      for (let attempt = 0; ; attempt++) {
        const ixs = [];
        const creating = !tableKey || (attempt > 0 && i === 0 && !table);
        if (creating) {
          // A finalized slot is already in the network's recent-slot list; the latest one may not be yet.
          const slot = Math.max(1, (await conn.getSlot('finalized')) - attempt * 24);
          const [createIx, addr] = AddressLookupTableProgram.createLookupTable({ authority: userKey, payer: userKey, recentSlot: slot });
          ixs.push(createIx);
          tableKey = addr;
        }
        ixs.push(AddressLookupTableProgram.extendLookupTable({ payer: userKey, authority: userKey, lookupTable: tableKey, addresses: chunks[i] }));
        const t = new Transaction().add(...ixs);
        t.feePayer = userKey;
        t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
        try {
          await signAndSend({ step, conn, cfg, wallet, tx: t, labels: { dry: 'Dry run (lookup table' + n + ')', sign: 'Approve lookup table' + n + ' in your wallet', send: 'Send lookup table' + n } });
          break;
        } catch (e) {
          if (!creating || attempt >= 3 || !/not a recent slot/i.test(String((e && e.message) || e))) throw e;
          await wait(1000);
        }
      }
      saveTable(cfg, userKey, tableKey.toBase58()); // remembered at once, so a declined second step does not strand it
    }
    saveTable(cfg, userKey, tableKey.toBase58());

    let fresh = null;
    for (let i = 0; i < 12; i++) {
      fresh = (await conn.getAddressLookupTable(tableKey)).value;
      if (fresh && keys.every((k) => fresh.state.addresses.some((x) => x.toBase58() === k))) break;
      fresh = null;
      await wait(1000);
    }
    if (!fresh) throw new Error('The lookup table was created but is not readable yet. Press the launch button again in a few seconds.');
    await wait(2500); // a table is usable from the slot after it is filled
    done('ok', 'Table ready with ' + fresh.state.addresses.length + ' addresses (' + why + ')');
    return { table: fresh, fresh: true };
  });
}


/** Creates the coin and buys `devBuySol` of it, in one transaction. `wallet` is the wallet adapter ({ signTransaction }). */
export async function launchCoin({ network, wallet, user, name, symbol, uri, devBuySol }, step) {
  const cfg = config(network);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const userKey = new PublicKey(user);
  const mint = Keypair.generate();
  const lamports = new BN(Math.round(devBuySol * LAMPORTS_PER_SOL));
  if (lamports.lten(0)) throw new Error('The dev buy must be more than 0 SOL.');

  await phase(step, 'Network check', async (done) => {
    await checkNetwork(conn, cfg);
    const sol = (await conn.getBalance(userKey)) / LAMPORTS_PER_SOL;
    const need = (cfg.mainnet ? 0.08 : 0.06) + devBuySol;
    if (sol < need) throw new Error('Balance is ' + sol.toFixed(3) + ' SOL. A ' + devBuySol + ' SOL dev buy plus fees needs about ' + need.toFixed(2) + ' SOL.');
    done('ok', cfg.label + ', balance ' + sol.toFixed(3) + ' SOL');
  });

  const online = new OnlinePumpSdk(conn);
  const built = await phase(step, 'Build create + buy', async (done) => {
    const global = await online.fetchGlobal();
    let feeConfig = null;
    try { feeConfig = await online.fetchFeeConfig(); } catch (e) { /* the quote also works without it */ }
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: lamports, quoteMint: NATIVE_MINT });
    if (amount.lten(0)) throw new Error('That dev buy size returns no tokens.');
    const ixs = await PUMP_SDK.createV2AndBuyV2Instructions({ global, mint: mint.publicKey, name, symbol, uri, creator: userKey, user: userKey, amount, quoteAmount: lamports, mayhemMode: false, slippage: 1 });
    const shared = await sharedAddresses({ global, userKey, amount, lamports, name, symbol, uri });
    const whole = Number(amount.div(new BN(10).pow(new BN(6))).toString());
    // Sanity check on the quote: 2.5 SOL on pump.fun's mainnet curve buys roughly 7% of the 1 billion supply. If the quote is
    // far bigger, the price on this network is not what we expect (devnet's curve is much cheaper: 2.5 SOL bought all of it),
    // so a mainnet launch is refused rather than risk the wrong buy. Devnet only warns.
    const pct = whole / 10_000_000; // percent of a 1,000,000,000 supply
    const expectedPct = Math.min(100, devBuySol * 2.9);
    if (cfg.mainnet && pct > expectedPct * 2.5) throw new Error('Stopped before anything was signed: the quote says ' + devBuySol + ' SOL buys ' + pct.toFixed(1) + '% of the supply, but about ' + expectedPct.toFixed(1) + '% was expected. Send this message to Claude.');
    done('ok', 'Coin ' + mint.publicKey.toBase58() + '. ' + devBuySol + ' SOL buys about ' + whole.toLocaleString('en-US') + ' tokens (' + pct.toFixed(1) + '% of supply), in the same transaction as the launch', addrUrl(cfg, mint.publicKey.toBase58()));
    return { ixs, shared };
  });

  const { table, fresh } = await ensureLookupTable({ step, conn, cfg, wallet, userKey, keys: built.shared });

  const tx = await phase(step, 'Pack into one transaction', async (done) => {
    const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })];
    if (cfg.priority > 0) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priority }));
    const msg = new TransactionMessage({ payerKey: userKey, recentBlockhash: (await conn.getLatestBlockhash('confirmed')).blockhash, instructions: pre.concat(built.ixs) }).compileToV0Message([table]);
    const vtx = new VersionedTransaction(msg);
    const size = vtx.serialize().length;
    if (size > MAX_TX_BYTES) throw new Error('Still too large for one transaction (' + size + ' of ' + MAX_TX_BYTES + ' bytes).');
    done('ok', size + ' of ' + MAX_TX_BYTES + ' bytes');
    return vtx;
  });

  const signature = await signAndSend({ step, conn, cfg, wallet, tx, extraSigner: mint, dryRetries: fresh ? 6 : 1, labels: { dry: 'Dry run (create + buy)', sign: 'Approve create + buy in your wallet', send: 'Send create + buy' } });
  return { mint: mint.publicKey.toBase58(), signature };
}

// ---------- Creator fees ----------

/** SOL waiting in the creator's fee vaults (the bonding curve and, after it fills, the open market), in SOL. */
export async function creatorFees(network, address) {
  const cfg = config(network);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const bal = await new OnlinePumpSdk(conn).getCreatorVaultBalanceBothPrograms(new PublicKey(address));
  return Number(bal.toString()) / LAMPORTS_PER_SOL;
}

/** Sends the creator's waiting fees to the creator's own wallet. Your wallet signs; nothing is sent anywhere else. */
export async function claimCreatorFees({ network, wallet, user }, step) {
  const cfg = config(network);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const userKey = new PublicKey(user);
  await phase(step, 'Network check', async (done) => { await checkNetwork(conn, cfg); done('ok', cfg.label); });
  const tx = await phase(step, 'Build claim', async (done) => {
    const online = new OnlinePumpSdk(conn);
    const bal = await online.getCreatorVaultBalanceBothPrograms(userKey);
    if (bal.lten(0)) throw new Error('Nothing to claim yet. Fees build up as people trade the coin.');
    const ixs = await online.collectCoinCreatorFeeInstructions(userKey, userKey);
    const t = new Transaction().add(...ixs);
    t.feePayer = userKey;
    t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    done('ok', 'Claiming about ' + (Number(bal.toString()) / LAMPORTS_PER_SOL).toFixed(6) + ' SOL to your wallet');
    return t;
  });
  return await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (claim)', sign: 'Approve claim in your wallet', send: 'Send claim' } });
}
