// Rolling per-wallet PnL book built from the live trade stream (no RPC credits).
// Realized PnL uses average cost per token. Only trades since launch are seen,
// so treat the leaderboard as "who is winning right now", not a verified history.

export class WalletBook {
  constructor(cap = 30000) {
    this.cap = cap;
    this.w = new Map();
    this._topAt = 0;
    this._top = [];
  }

  record(wallet, mint, isBuy, sol, tok, now) {
    let w = this.w.get(wallet);
    if (w) {
      this.w.delete(wallet); // refresh LRU position
    } else {
      if (this.w.size >= this.cap) this._evict();
      w = { tokens: new Map(), realized: 0, wins: 0, losses: 0, closed: 0, holdSum: 0, trades: 0, first: now, last: now };
    }
    this.w.set(wallet, w);
    w.trades++;
    w.last = now;

    let p = w.tokens.get(mint);
    if (!p) {
      if (w.tokens.size >= 40) w.tokens.delete(w.tokens.keys().next().value);
      p = { held: 0, cost: 0, realized: 0, first: now, closed: false };
      w.tokens.set(mint, p);
    }
    if (isBuy) {
      p.held += tok;
      p.cost += sol;
      p.closed = false;
      return;
    }
    if (p.held <= 0.01) return; // inventory bought before we started watching: PnL unknown
    const portion = Math.min(1, tok / p.held);
    const costOut = p.cost * portion;
    const pnl = sol - costOut;
    p.held -= tok * Math.min(1, p.held / tok);
    p.cost -= costOut;
    p.realized += pnl;
    w.realized += pnl;
    if (portion >= 0.98 && !p.closed) {
      p.closed = true;
      p.held = 0;
      p.cost = 0;
      w.closed++;
      w.holdSum += now - p.first;
      if (p.realized > 0) w.wins++;
      else w.losses++;
    }
  }

  _evict() {
    let n = Math.ceil(this.cap * 0.1);
    for (const k of this.w.keys()) {
      this.w.delete(k);
      if (--n <= 0) break;
    }
  }

  profile(wallet) {
    const w = this.w.get(wallet);
    if (!w) return null;
    return {
      realized: w.realized,
      closed: w.closed,
      wins: w.wins,
      winRate: w.closed ? w.wins / w.closed : null,
      trades: w.trades,
      avgHoldMs: w.closed ? w.holdSum / w.closed : null,
      open: [...w.tokens.values()].filter((p) => p.held > 0.01).length,
    };
  }

  /** Best realized PnL among wallets with enough closed positions. */
  top(minClosed = 3, limit = 30) {
    const now = Date.now();
    if (now - this._topAt < 4000 && this._top.length) return this._top;
    const rows = [];
    for (const [wallet, w] of this.w) {
      if (w.closed < minClosed || w.realized <= 0) continue;
      const avgHoldMs = w.holdSum / w.closed;
      rows.push({
        wallet,
        realized: w.realized,
        closed: w.closed,
        winRate: w.wins / w.closed,
        avgHoldMs,
        fast: avgHoldMs < 4000, // likely a bot
        trades: w.trades,
        last: w.last,
      });
    }
    rows.sort((a, b) => b.realized - a.realized);
    this._top = rows.slice(0, limit);
    this._topAt = now;
    return this._top;
  }
}
