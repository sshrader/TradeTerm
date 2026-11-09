import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { redact, sleep } from './util.js';
import { PUMP_PROGRAM, parseLogsNotification } from './decoder.js';

// Rough per-method credit estimates. The Helius dashboard is the source of truth.
const COST = { getProgramAccounts: 10 };

/** Counts estimated RPC credits per calendar month and persists them. */
export class CreditMeter {
  constructor(dir, budget) {
    this.file = path.join(dir, 'credits.json');
    this.budget = budget;
    this.month = new Date().toISOString().slice(0, 7);
    this.used = 0;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j.month === this.month) this.used = Number(j.used) || 0;
    } catch {
      /* first run */
    }
    this._t = null;
  }

  add(n) {
    const m = new Date().toISOString().slice(0, 7);
    if (m !== this.month) {
      this.month = m;
      this.used = 0;
    }
    this.used += n;
    if (!this._t) this._t = setTimeout(() => this.flush(), 5000).unref();
  }

  flush() {
    clearTimeout(this._t);
    this._t = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ month: this.month, used: this.used }));
    } catch {
      /* non-fatal */
    }
  }

  snapshot() {
    return { used: this.used, budget: this.budget, month: this.month };
  }
}

/** JSON-RPC client with a token-bucket rate limiter and credit metering. */
export class Rpc {
  constructor({ url, rps, meter }) {
    this.url = url;
    this.rps = rps;
    this.meter = meter;
    this._tokens = rps;
    this._last = Date.now();
    this.stats = { calls: 0, errors: 0, lastError: null, ok: null };
  }

  async _take() {
    for (;;) {
      const now = Date.now();
      this._tokens = Math.min(this.rps, this._tokens + ((now - this._last) / 1000) * this.rps);
      this._last = now;
      if (this._tokens >= 1) {
        this._tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this._tokens) / this.rps) * 1000));
    }
  }

  async call(method, params = [], { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      await this._take();
      let res;
      try {
        res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(12000),
        });
      } catch (e) {
        this.stats.errors++;
        this.stats.lastError = redact(e.message);
        if (attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new Error('RPC network error: ' + redact(e.message));
      }
      this.meter.add(COST[method] ?? 1);
      this.stats.calls++;
      if (res.status === 429 && attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        this.stats.ok = false;
        this.stats.lastError = `Helius rejected the API key (HTTP ${res.status})`;
        throw new Error(this.stats.lastError);
      }
      if (!res.ok) throw new Error('RPC HTTP ' + res.status);
      const json = await res.json();
      if (json.error) throw new Error(redact(json.error.message || 'RPC error'));
      this.stats.ok = true;
      return json.result;
    }
  }
}

/** logsSubscribe on the pump.fun program with reconnect + watchdog. */
export class LogStream extends EventEmitter {
  constructor({ url }) {
    super();
    this.url = url;
    this.state = 'idle';
    this.lastMsgAt = 0;
    this.msgCount = 0;
    this.reconnects = 0;
    this.lastError = null;
    this._attempts = 0;
    this._fails = 0;
    this._stopped = false;
  }

  start() {
    this._connect();
    this._dog = setInterval(() => {
      const idle = Date.now() - this.lastMsgAt;
      if ((this.state === 'connected' && idle > 30_000) || (this.state === 'connecting' && idle > 20_000)) {
        this.lastError = 'No data received, reconnecting';
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        if (this.state === 'connecting') this._retry();
      }
    }, 10_000);
    this._dog.unref();
  }

  stop() {
    this._stopped = true;
    clearInterval(this._dog);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  _connect() {
    if (this._stopped) return;
    this.state = 'connecting';
    this.lastMsgAt = Date.now();
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.lastError = redact(e.message);
      return this._retry();
    }
    this.ws = ws;
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }],
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      this.lastMsgAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.method === 'logsNotification') {
        this.msgCount++;
        const n = parseLogsNotification(msg);
        if (n) this.emit('notification', n);
      } else if (msg.id === 1) {
        if (msg.error) {
          this.lastError = redact(msg.error.message || 'subscribe failed');
        } else {
          this.state = 'connected';
          this.lastError = null;
          this._attempts = 0;
          this._fails = 0;
        }
      }
    });
    ws.addEventListener('error', (ev) => {
      this.lastError = redact(ev?.message || 'WebSocket error');
    });
    ws.addEventListener('close', () => {
      if (ws !== this.ws) return;
      this.state = 'closed';
      if (!opened) {
        this._fails++;
        if (this._fails >= 3) this.lastError = 'Cannot connect. Check HELIUS_API_KEY and that your plan allows WebSockets.';
      }
      this._retry();
    });
  }

  _retry() {
    if (this._stopped || this._timer) return;
    this.reconnects++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this._attempts++, 5));
    this._timer = setTimeout(() => {
      this._timer = null;
      this._connect();
    }, delay);
    this._timer.unref?.();
  }
}
