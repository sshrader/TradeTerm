# Pulse terminal

A personal Solana trading terminal for pump.fun tokens. One process on your own machine, no build step. The only dependency is TradingView's open-source Lightweight Charts, used for the price chart. Version 0.1 does **paper trading only**: real market data, simulated fills, no wallet, no funds at risk.

## Run it

You need Node.js 22 or newer (`node -v` to check; get it at nodejs.org).

**Install once**

```
npm install
```

This fetches the chart library. If you skip it, the terminal still works and falls back to a simpler built-in chart.

**Demo first (no key needed)**

```
node server/index.js --demo
```

Open http://localhost:8787. This runs a simulated market through the exact same pipeline as live data, so you can click around everything: feed, charts, risk checks, wallet tracker, paper trades.

**Live data**

1. Copy `.env.example` to `.env`.
2. Paste your Helius key after `HELIUS_API_KEY=`. Keep it out of chat, screenshots and git.
3. Run `npm start` (or `node server/index.js`) and open http://localhost:8787.

The pill at the top left shows `live` once the stream is connected. If it says `reconnecting`, the banner underneath tells you why.

Add `--open` to launch the browser automatically.

## Deploy on Railway

The server detects Railway, listens on all interfaces and uses the `PORT` Railway injects. Because the URL is public, it is **password protected**.

1. Create a Railway project from this GitHub repo. No build config is needed.
2. Add these variables on the service:

| Variable | Value |
|---|---|
| `HELIUS_API_KEY` | Your Helius key. Without it the app runs in demo mode |
| `ACCESS_PASSWORD` | A password you choose. If unset, a random one is generated and printed in the deploy logs on every start |
| `DATA_DIR` | Optional. Path of a mounted Railway volume (for example `/data`) to keep the paper account across deploys |
| `NIXPACKS_NODE_VERSION` | `22`, only if the build picks an older Node |

3. Under Settings > Networking, generate a public domain, then open it.
4. The browser asks for a login. Enter any username and your password.

**Public demo for friends.** Set `DEMO=1` and `PUBLIC_VIEW=1`. Anyone with the URL can browse the simulated market with no login, but trading, the kill switch and settings are turned off, and your paper account is never sent to them. To trade yourself, open `/login` on your site and enter your `ACCESS_PASSWORD`. `PUBLIC_VIEW` is ignored with live data, so a real feed always stays behind the password.

Ten wrong passwords from one address in ten minutes locks that address out for a while. Without a volume, the paper account resets on each deploy.

## What's in it

| Area | What it does |
|---|---|
| Dashboard | Opens first: three swimlanes (New, Final stretch, Graduated), each token in one lane. Every lane has its own search, quick-buy amount (the ⚡ button on a card) and filters (market cap, volume, holders, top-10 share, age, curve progress, 5m change, risk, bundled, dev sold) with presets, all remembered per lane. Cards show curve progress, top-10 share, dev holding, snipers, bundling and buy pressure at a glance. Drag the handles between lanes to resize them (double-click to reset). Click a token to open it in the Trade view |
| Quick trade | Floating, draggable buy/sell window (top bar button, Esc to close). One click on an amount buys, one click on a percent sells, for whichever token is selected. Presets are editable (pencil) and TP/SL are set in the window. Paper trades only |
| Themes | Five colour themes (Graphite, Ocean, Ember, Mono, Violet) from the dots in the top bar. Graphite is the default and your choice is remembered |
| Socials | Cards show X, Telegram and website icons (and the X handle) when the token has them, plus the token's real image. Metadata is fetched as cards scroll into view, three at a time. Only https links are shown, and each icon is picked from the link's real host |
| PnL | Total paper PnL sits in the top bar (SOL, percent and USD; hover for realized, open and today). Your position's PnL shows on the token header, as a "Held" chip on dashboard cards, and in the paper account summary |
| Trade view | Board tabs (New / Hot / Final stretch / Graduated) with market cap, 5m volume, holders, curve progress, risk level and quick-buy buttons |
| Chart | TradingView Lightweight Charts: candles and volume built locally from trades (1s, 5s, 15s, 1m), USD or SOL, crosshair, zoom and pan, your entry line |
| Risk check | 0-100 score from dev behaviour, holder concentration, snipers, bundled launches and sell pressure. "Verify on-chain" adds mint and freeze authority plus real top-holder numbers |
| Wallet tracker | Watch wallets and get real-time alerts. A leaderboard ranks the best realized PnL seen since launch, with a flag for bot-like wallets |
| Paper account | Buys and sells on the real bonding curve with take-profit, stop-loss, a kill switch and hard risk limits |
| Credit meter | Estimated Helius credits used this month. The Helius dashboard is the source of truth |

## How it works

```
Helius WebSocket (logsSubscribe on pump.fun)
  -> decoder (trades and creates read straight from transaction logs, no per-trade RPC call)
  -> market store (candles, holder ledger, dev and sniper tracking, wallet PnL book)
  -> risk scoring, paper engine
  -> local HTTP + server-sent events -> browser UI
```

Because pump.fun writes each trade into its logs, the terminal needs **no `getTransaction` calls**. RPC credits are only spent on the optional "Verify on-chain" button (about 4 calls) and one startup health check. That is what makes the free tier workable.

## Free tier notes

- It uses standard `logsSubscribe`, not Geyser/LaserStream, which are on paid plans.
- Tokens first seen mid-life are tracked only if a trade is at least `PARTIAL_MIN_SOL` (default 0.5) or a watched wallet touches them. This keeps memory and noise down.
- Check your plan's WebSocket and credit limits in the Helius dashboard. Set `HELIUS_MONTHLY_CREDITS` so the meter matches your plan.

## Paper trading model

Fills use the real curve reserves from the latest trade, then add pessimism so results are not flattering:

- Protocol and creator fees, read from the trade event (falls back to 1.25%)
- Extra slippage (`PAPER_SLIPPAGE_BPS`, default 0.5%) on every fill
- A simulated priority fee and tip per transaction (`PAPER_PRIORITY_FEE_SOL`, default 0.001)
- Limits: `MAX_POSITION_SOL`, `MAX_OPEN_POSITIONS`, `DAILY_LOSS_CAP_SOL`

The kill switch blocks new buys. Exits and TP/SL stay active so you can always get out.

A round trip typically costs 4-6% before the price moves at all. That is realistic for these tokens, and a good reason to expect paper results to be better than live results.

## Security

- Locally the server binds to `127.0.0.1` only (set `HOST` to change it). On a public host it requires a password (HTTP Basic auth). Locally it rejects requests with a foreign Host or Origin (DNS-rebinding and cross-site POST protection).
- The API key lives in `.env`, is never sent to the browser, and is scrubbed from logs and error messages.
- Token names, symbols and metadata are attacker-controlled. They are stripped of control and bidi characters, rendered as text (never HTML), and only IPFS content is fetched, through fixed public gateways. Images are size-capped, raster only, and verified by magic bytes.
- A strict Content-Security-Policy is set on every response.

## Not built yet

- **Live execution.** Deliberately left out of v0.1: it moves real money and cannot be verified without a funded wallet. The paper engine is shaped like an executor, so a live one can slot in. Recommended: a dedicated burner wallet, Jupiter or direct pump.fun swaps, Jito bundles, the same limits enforced server-side.
- Graduated tokens (PumpSwap), Raydium, Meteora and Orca pools. The feed ends when a token graduates.
- Pairs quoted in anything other than SOL are skipped on purpose, because all math here is in SOL.
- Token names for tokens first seen mid-life (they show a short mint until a DAS lookup is added).
- A gRPC data source for lower latency (paid plans).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Pill says `reconnecting` with "Cannot connect" | Wrong key, or your plan does not allow WebSockets |
| `live` but 0 events per second | Stream connected but nothing decoded. Check the `decoder` counters at `/api/status` |
| "Port 8787 is already in use" | Set `PORT=8788` in `.env` |
| Charts look sparse on a token | It was only just tracked. History builds from the moment the terminal sees it |
| Leaderboard is empty | It needs wallets with 2+ closed, profitable positions. Leave it running |

## Files

```
server/   index.js (HTTP + SSE), decoder.js, store.js, risk.js, paper.js, wallets.js,
          rpc.js, chain.js, meta.js, price.js, demo.js, config.js, util.js
web/      index.html, app.css, app.js, lwchart.js (TradingView chart), chart.js (fallback)
test/     decoder and paper-engine tests (npm test)
data/     created at runtime: paper account, watchlist, credit counter
```

Paper account and watchlist are saved in `data/` and kept separately for demo and live mode. This is a personal tool, not financial advice, and most memecoin trading loses money.
