# Aviator Betting Bot

> ⚠️ **Educational / research use only.** See the [disclaimer](#-legal-disclaimer).

An automation tool for the Aviator crash game on **BetPawa Uganda**, built with
**Node.js + Puppeteer**. It watches the game, studies round history with a persistent
adaptive model, applies a configurable betting strategy with layered risk management,
and streams live stats to a browser dashboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D%2018-brightgreen.svg)](https://nodejs.org/)
[![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)

## Table of Contents

- [What's new in v2](#whats-new-in-v2)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Strategies](#strategies)
- [Multi-site & multi-account](#multi-site--multi-account)
- [Live dashboard](#live-dashboard)
- [Database](#database)
- [How it works](#how-it-works)
- [Testing](#testing)
- [FAQ](#faq)
- [Security](#security)
- [Contributing](#-contributing)
- [Disclaimer](#-legal-disclaimer)
- [License](#license)

## What's new in v3 (risk-controlled structure)

The bot is now built as a **risk-controlled trading system**, not a simple
"bet when average is low" script:

- **Bankroll guard** — hard session + daily loss limits (persisted across
  restarts), a max-stake fraction of the bankroll (default 1.5%), and a balance
  reserve. When a limit trips, betting is blocked — no override in code paths.
- **Confidence tiers** — `OBSERVING → MICRO → ARMED`. Warm-up is mandatory:
  zero bets for the first `MIN_ROUNDS_OBSERVE` rounds. Then only micro-bets
  (default 0.4% of bankroll) until the bot sustains a 58%+ hit-rate over 25+
  decisions; dropping below 48% demotes it back to micro.
- **Pattern detector** — mines recent round clusters of length **10, 5 and 3**
  (L/M/H symbols), carries a smoothed prediction for the next round, refuses
  risky patterns, and benches patterns that keep failing live until they
  re-earn trust. Patterns persist in `data/patterns.json`.
- **Volatility risk evaluation** — wild recent rounds raise the confidence
  required to bet.
- **Paper mode by default** — `PAPER_MODE=true` observes the real site and logs
  hypothetical trades without clicking anything. Real betting requires an
  explicit opt-in.
- **Simulator** — `npm run simulate` runs the bot's real decision stack over
  thousands of rounds (replayed history, synthetic Aviator distribution, or
  mixed) and writes a round-by-round CSV. Measure behavior BEFORE any funds.
- **Round-by-round logs** — `data/rounds.csv` and `data/trades.csv` record
  every decision with its full reasoning (confidence, pattern, tier, regime).
- **Live learning dashboard** — tier, bankroll, loss-limit usage bars, model
  probability, active pattern and last decision reasons at `localhost:3000`.
- **MICRO default strategy** — UGX 100 stakes, 1.30x target, tiny limits.

## What's new in v2

This release is a full overhaul focused on **correctness and money-safety**:

- **Martingale now works** — win/loss results are fed back into the strategy, so bet
  sizing actually progresses after losses and resets after wins.
- **Risk limits are enforced** — stop-loss, take-profit and a 5-consecutive-loss
  circuit breaker are checked every cycle and halt betting when hit.
- **Your strategy choice is respected** — the selected (or custom) strategy is the one
  used for betting and cashouts. Custom strategies now include the average-multiplier
  threshold they need to actually place bets.
- **Correct crash attribution** — bets are settled against the crash value of the round
  they were actually in, not the previous round's value.
- **No more double bets** — the monitoring cycle is re-entrancy-safe.
- **Confirmed actions** — bet placement and cashout are verified against the page before
  being booked; unconfirmed outcomes are booked conservatively (never as phantom wins).
- **Angular-safe bet input** — the stake is written through the native value setter so
  the game UI actually registers it.
- **Self-healing** — repeated failures trigger a page reload and re-baseline; browser
  disconnects exit non-zero so a supervisor can restart; selector drift raises loud errors.
- **Anti-stuck guarantees** — a jitter guard debounces false round-end signals, and any
  bet that cannot be settled (never armed, or crash never detected) is written off after a
  configurable timeout so the loop can never block or double-bet.
- **Tamer martingale** — the loss-streak breaker is configurable
  (`maxConsecutiveLosses`), and a bet the balance can't fund resets the progression to the
  initial stake instead of resuming escalated.
- **Live dashboard** — a real Express + Socket.IO server (the previous client had no
  backend) at `http://localhost:3000`.
- **BetPawa Uganda target** — login flow with a persistent browser profile (log in
  once, the session is remembered), direct navigation to the Aviator game page.
- **History memory + adaptive model** — every crash is stored in `data/history.json`
  (survives restarts). A model estimates `P(crash >= target)` from all studied rounds,
  pauses betting during cold streaks, and tunes its entry threshold from actual
  outcomes. See [How the model learns](#how-the-model-learns).
- **Safer resets** — progression resets and recovery events trigger round cooldowns;
  a balance reserve is never touched; the loss-streak breaker is configurable.
- **Best-possible round detection** — payouts-strip signal + jitter guard +
  flight-end fallback, so rounds are neither double-counted nor missed.
- **Site-state recovery ladder** — reload → re-navigate → halt trading. The bot never
  bets blind, and session expiry is detected and reported.
- **Optional persistence** — MySQL via `mysql2` with auto-schema and reconnect.
- **Configurable via `.env`** — no more hard-coded secrets.
- **Tested** — strategy, stats and balance-parsing logic covered by `node --test`.

## Features

### Core
- Automated betting with Conservative / Moderate / Aggressive / Custom strategies
- Real-time game monitoring across the page and all iframes
- Martingale progression with configurable multiplier and hard `maxBet` cap
- Stop-loss, take-profit and consecutive-loss circuit breaker
- Balance check before every bet
- Robust crash/round-end detection with round history

### Advanced
- Live web dashboard with crash chart and prediction accuracy
- Optional MySQL persistence of rounds and trades
- Structured logging (console + rotating files in `logs/`)
- Graceful shutdown on `SIGINT` / `SIGTERM` and after a configurable run duration

## Requirements

- **Node.js >= 18**
- npm
- A Chromium-compatible browser (bundled via Puppeteer)
- MySQL (optional, only for persistence)

## Installation

```bash
git clone https://github.com/Petkigz/avt-bot.git
cd avt-bot
npm install
```

Copy the example environment file and adjust as needed:

```bash
cp .env.example .env
```

Run the bot:

```bash
npm start
```

You'll be prompted to pick a strategy. The bot then opens BetPawa Uganda in a
browser window:

1. **Log in** to your BetPawa account in that window (phone number + PIN). You only
   do this once — the session is stored in a persistent Chrome profile
   (`data/browser-profile`) and reused on later runs.
2. Press **ENTER** in the terminal.
3. The bot opens the Aviator game page and starts monitoring.

The live dashboard runs at `http://localhost:3000`.

> **Currency note:** all strategy amounts are in the site currency — **UGX** on
> BetPawa.ug. The bundled presets are already scaled (e.g. UGX 1,000 initial bet on
> MODERATE).

## Configuration

All settings live in `.env` (see [.env.example](.env.example)). Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `https://www.betpawa.ug` | Login/landing page |
| `GAME_URL` | `https://www.betpawa.ug/virtual/aviator` | Aviator game page (after login) |
| `MANUAL_LOGIN` | `true` | Pause for manual login, continue on ENTER |
| `HEADLESS` | `false` | Run browser without a window |
| `POLLING_INTERVAL` | `4000` | How often the game is polled (ms) |
| `HISTORY_SIZE` | `5` | Rounds used for the moving average |
| `MIN_BALANCE_RESERVE` | `0` | Balance the bot will never bet into (UGX) |
| `MODEL_ENABLED` | `true` | Enable the adaptive history model |
| `MODEL_MIN_ENTRY_PROBABILITY` | `0.55` | Minimum confidence to place a bet |
| `MODEL_COLD_STREAK_LIMIT` | `3` | Pause betting after this many low crashes |
| `MIN_ROUND_GAP_MS` | `2000` | Jitter guard for round-end detection |
| `BET_STALENESS_MS` | `120000` | Write-off timeout for an unconfirmed bet |
| `MAX_BET_LIFETIME_MS` | `180000` | Absolute max lifetime of an open bet |
| `FLIGHT_END_GRACE_MS` | `10000` | Settle if flight ended but bubble never updates |
| `DASHBOARD_ENABLED` | `true` | Serve the live dashboard |
| `DASHBOARD_PORT` | `3000` | Dashboard port |
| `DASHBOARD_HOST` | `0.0.0.0` | Bind interface (`127.0.0.1` = local only, no auth built in) |
| `UI_START` | `false` | Start sessions from Mission Control instead of terminal prompts |
| `DATABASE_ENABLED` | `false` | Enable MySQL persistence |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `PAPER_MODE` | `true` | Observe + log without betting (SAFE default) |
| `SITE` | `betpawa.ug` | Starting site profile (`betpawa.ug` \| `betpawa.co.zm` \| `betpawa.co.mw` \| `custom`) |
| `MAX_SESSIONS` | `1` | Max concurrent browser sessions (one per account) |
| `CUSTOM_BASE_URL` / `CUSTOM_GAME_URL` | *(empty)* | For `SITE=custom`: any Spribe-Aviator bookmaker |
| `CUSTOM_CURRENCY` / `CUSTOM_MIN_STAKE` | `UNITS` / `0` | Currency + min stake for the custom site |
| `SESSION_LOSS_LIMIT` | `3000` | Hard session loss cap (site currency) |
| `DAILY_LOSS_LIMIT` | `6000` | Hard daily loss cap (site currency, persists) |
| `MAX_STAKE_FRACTION` | `0.015` | Max stake as fraction of bankroll |
| `MICRO_STAKE_FRACTION` | `0.004` | Micro-tier stake as fraction of bankroll |
| `MIN_ROUNDS_OBSERVE` | `150` | Mandatory warm-up rounds before any bet |
| `PATTERN_LENGTHS` | `10,5,3` | Cluster lengths the pattern miner tracks |

Full list (promotion thresholds, volatility penalties, pattern bins, ...) is in
[.env.example](.env.example).

> **Note:** Automating a real bookmaker may violate its terms of service — know the
> rules and the risks before pointing this at a funded account. If a site serves a
> different Aviator build, the selectors in `util/sites.js` (`SELECTOR_SETS.spribe`)
> are the only values to adjust (they target the standard Spribe widget).

## Multi-site & multi-account

The bot is **not BetPawa-only**. Aviator is ONE global Spribe game — every
bookmaker shows the same rounds at the same time — so data gathered on any
site feeds the same memory, model and pattern miner.

**Built-in site profiles** (`util/sites.js`):

| Site id | Currency | Notes |
|---|---|---|
| `betpawa.ug` | UGX | Deep link `/virtual/aviator`, min stake UGX 100 |
| `betpawa.co.zm` | ZMW | Deep link `/aviator-crash-game` |
| `betpawa.co.mw` | MWK | No verified deep link — open Aviator from the site menu; the watcher finds the game page |
| `custom` | env | Point `CUSTOM_BASE_URL` / `CUSTOM_GAME_URL` at any Spribe-Aviator site |

**Choosing site & account at startup (CLI dropdown):** unless `SITE` is set in
`.env`, startup shows an interactive menu — pick the site (1–4), then pick one
of your saved login profiles or create a new one. Without a terminal, the bot
restores the last-active site/account automatically.

**…or do everything from the dashboard (Mission Control):** set
`UI_START=true` in `.env` and the bot starts the dashboard first, then waits —
you pick site, account and strategy in **Mission Control** and press
**🚀 Launch session**. While running, Mission Control also lets you switch
site/account live and **⏸ pause / ▶ resume betting** with one click (the
pause is a hard decision-gate in the Brain, not just a UI flag).

**Login verification:** the bot never touches your credentials — you log in
yourself on the real site page, and a wrong PIN is rejected by the site
itself. On top of that the bot VERIFIES the login: it polls the page for the
site's logged-in indicators and auto-detects success (no click needed); if you
confirm but the page still looks logged out, it warns you and gives you 3
attempts before falling through to watch-only mode.

**Switching sites/accounts live:** use the *Site & Account* card on the
dashboard — pick a site, pick (or create) an account, click **Switch site**.
Saved profiles are listed in *Saved login profiles* with a per-account
**Switch to** button (account switching = close old profile's browser, open
the new one). The bot enforces `MAX_SESSIONS`, waits for you to log in, then
navigates to the game. You can also press ENTER in the terminal instead of
clicking continue.

**Saved login profiles:** each account is a persistent browser profile under
`data/profiles/<id>` — log in once per account and the session survives
restarts; the dashboard shows each profile's last confirmed login. Only
metadata (id/site/label/lastLoginAt) is stored in `data/accounts.json`;
**passwords are never stored anywhere**. Multiple accounts per site are
supported; concurrent sessions are capped by `MAX_SESSIONS` (oldest over the
cap is closed).

**Real site config structure:** every profile in `util/sites.js` carries
`baseUrl`, `loginUrl`, `loginSelectors` (username/PIN/submit/logged-in hints),
`balanceSelector`, `gameUrl` and per-site notes. Login stays manual by design —
the selector hints only let tooling point at the right fields. The dashboard's
*Live bot sessions* panel shows each open browser session's site, account,
phase (`launching / loginRequired / navigating / active / monitoring`) and
rounds seen, and *Cross-site history* charts the stored rounds per site.

**Cross-site data:** every row in `data/rounds.csv` and `data/trades.csv` is
tagged with `site` and `account`, so you can always see which site/account
produced which data — while the shared model learns from all of it.

## Strategies

**All four presets are always available** — via the interactive menu, the
`STRATEGY` env var (for headless runs), or `--strategy` in the simulator.

| Preset | Initial | Max | Target | Martingale | Stop-loss | Take-profit |
|---|---|---|---|---|---|---|
| **MICRO** (default) | UGX 100 | UGX 800 | 1.30x | ×1.3 | UGX 1,500 | UGX 2,000 |
| CONSERVATIVE | UGX 500 | UGX 25,000 | 1.20x | ×1.5 | UGX 10,000 | UGX 20,000 |
| MODERATE | UGX 1,000 | UGX 50,000 | 1.50x | ×2 | UGX 25,000 | UGX 50,000 |
| AGGRESSIVE | UGX 2,500 | UGX 100,000 | 2.00x | ×2.5 | UGX 50,000 | UGX 150,000 |

> **Caution-tuned for BetPawa by default:** 150-round warm-up, 0.60 entry
> confidence, 1.5% max stake fraction, UGX 3,000 session / UGX 6,000 daily loss
> caps, pattern families need 8+ observations before they're trusted, and
> promotions require a 58%+ hit-rate over 25+ decisions. Loosen only with data.

```bash
STRATEGY=CONSERVATIVE npm start       # env override, no prompt
node sim/simulate.js --strategy MODERATE --rounds 10000   # simulate any preset
```

A **CUSTOM** strategy (menu option 5) lets you set every parameter yourself:

- `initialBet`, `minBet`, `maxBet` — stake bounds
- `targetMultiplier` — cash out when the live multiplier reaches this
- `martingaleMultiplier` — multiply the stake by this after each loss (capped at `maxBet`)
- `stopLoss` / `takeProfit` — halt betting when net result crosses these
- `averageMultiplierThreshold` — only bet when recent average crash is at/below this
- `maxConsecutiveLosses` — halt betting after this many losses in a row (default 5)

**`MICRO_ONLY=true`** — strict safety profile: the bot stays in the MICRO tier
forever (micro-sized bets, never promoted to full strategy stakes), regardless
of which preset you pick.

## How the model learns

The bot keeps **memory across restarts** and refines its entry decisions:

1. **History** — every round's crash value is appended to `data/history.json`
   (capped at 5,000 rounds). On startup the full history is re-loaded.
2. **Probability estimate** — `P(crash ≥ target)` is computed from all studied
   rounds (Laplace-smoothed). If that confidence is below the entry threshold,
   the bot stands down that round.
3. **Regime detection** — after `MODEL_COLD_STREAK_LIMIT` consecutive crashes
   below the target, betting **pauses** ("cold regime") until the strip warms up.
   This is the primary loss-avoidance mechanism.
4. **Outcome learning** — each settled bet nudges the entry threshold: losses
   tighten it (bet less often), wins loosen it slightly. Adjustments are bounded
   (`MODEL_MIN_ENTRY_PROBABILITY`..`MODEL_MAX_ENTRY_PROBABILITY`) so learning can
   never run away. State persists in `data/model.json`.
5. **Dashboard transparency** — regime, model probability, entry threshold, rounds
   studied and bot state are all visible live at `http://localhost:3000`.

> ⚠️ **Honest note:** Aviator rounds are produced by an RNG — **no model can predict
> the next crash**, and none can guarantee profit. The model improves *entry
> discipline* and protects the bankroll from bad stretches; the house edge remains.
> Bet only what you can afford to lose.

## Live dashboard

When `DASHBOARD_ENABLED=true`, open `http://localhost:3000`:

- **Site & Account card** — switch sites/accounts live, add accounts, and the
  "I'm logged in — continue" button for the manual-login step
- **Live learning panel** — all-time stored memory (via `GET /api/history`),
  entry-threshold trend (what the learning has done), strongest pattern
  families with their probabilities, and a live decision feed with reasons
- **Log history viewer** — browse the stored `data/rounds.csv` /
  `data/trades.csv` rows (site/account tagged) right in the dashboard
- **Risk panel** — bankroll, session/daily P/L, loss-limit usage bars, tier,
  hit-rate, regime, model probability and the active strategy profile
- **Crash chart** with prediction accuracy table

REST endpoints:

| Endpoint | Returns |
|---|---|
| `GET /api/history` | All-time round count, averages, %-below-1.5x, last 50 rounds |
| `GET /api/history/bySite` | Stored rounds aggregated per site (counts, avg, %-below-1.5x, per-account splits, last 30 crashes) |
| `GET /api/sites` | Registered site profiles + the active one |
| `GET /api/accounts` | Account metadata + last login (never credentials) |
| `POST /api/accounts/new` | Create an account `{site, label}` |
| `GET /api/sessions` | Live browser sessions (site/account/phase/rounds seen) |
| `GET /api/logs?type=rounds\|trades&limit=N` | Stored log rows as JSON (newest first) |
| `GET /api/export?type=rounds\|trades\|history` | Download the raw stored files (CSV/JSON) |

Socket.IO: the server emits `siteStatus` (`switching` / `loginRequired` /
`findGame` / `active` / `error`) and `sessions` (live session snapshots); the
client sends `switchSite {siteId, accountId}`, `switchAccount {siteId,
accountId}` and `confirmLogin`.

## Database

Set `DATABASE_ENABLED=true` plus the `DB_*` variables. The bot auto-creates the
`rounds` and `trades` tables on first connect and reconnects automatically if the
connection drops.

## How it works

1. **Launch & navigate** — Puppeteer opens the target page and clicks through to the game.
2. **Locate the game** — every page/frame is scanned for the payouts strip; the first
   page containing it gets a dedicated `GameMonitor`.
3. **Detect rounds** — the payouts strip only changes when a round crashes; the newest
   bubble is that round's crash value.
4. **Decide** — if no bet is live, betting is allowed, and the recent average crash is
   at/below the threshold, a bet of the strategy-computed size is placed.
5. **Cash out** — while a round is in flight, if the live multiplier reaches the target,
   the bot cashes out and books the (confirmed) win.
6. **Manage risk** — every cycle checks stop-loss/take-profit/streak limits and halts
   betting if any is hit.
7. **Report** — stats stream to the dashboard and, optionally, the database.

## Testing

```bash
npm test
```

Runs 115 tests: strategy engine, stats, balance parsing, model, patterns,
bankroll, confidence tiers, round detection, recovery ladder, simulator,
site registry, accounts, round-rate math, REST endpoints and a live
socket.io integration test.

### Pre-flight & offline demo

```bash
npm run doctor   # checks Node, deps, Chrome binary, .env, data/, port, network
npm run demo     # OFFLINE synthetic feed through the real dashboard
```

`npm run demo` streams fake Aviator rounds through the real dashboard, CSV
logs and history store — all isolated in `data/demo/` (your real memory is
never touched). It lights up every panel — crash chart, learning panel, live
sessions (with rounds/hour rate + balance), cross-site history charts and the
log viewer — without a browser, a login or any risk. Great for verifying an
install before pointing it at a real site.

### Debug screenshots

When the monitor hits its recovery ladder or trading halts, a timestamped
screenshot is saved to `data/screenshots/` (max 20 kept) — so you can see
exactly what the bot saw when something went wrong.

## Paper mode & simulation (do this BEFORE real funds)

1. **Simulate** — thousands of rounds, zero money, zero browser:
   ```bash
   npm run simulate                                            # realistic session
   node sim/simulate.js --rounds 20000 --source mixed --long-run  # long-term behavior
   node sim/simulate.js --batch 10 --rounds 5000 --long-run       # large-sample analysis:
   #   10 independent runs aggregated: avg/median/worst P/L, drawdowns,
   #   how often the bankroll guard trips, tier outcomes + aggregate CSV
   ```
   Prints P/L, max drawdown, win rate, tier progression and skip-reason
   breakdown; writes a round-by-round CSV to `data/simulations/`.
2. **Paper mode on the live site** — default. The bot logs in, watches real
   rounds, makes real decisions, but never clicks. Check `data/rounds.csv`
   and the dashboard.
3. Only then consider `PAPER_MODE=false`, starting with the MICRO strategy.

> **Read the simulation output honestly.** Aviator has a built-in house edge:
> even a 75% win-rate at a 1.30x target is slightly negative long-term. The
> model's job is discipline and loss limitation, not beating the RNG. If a
> simulation shows steady profit, question it before trusting it.

## FAQ

**Q: Does this guarantee profit?**
A: No. Crash games are negative-expectation; this is an automation/research tool. Use
strict risk limits.

**Q: Where are the logs?**
A: `logs/combined.log` (all) and `logs/error.log` (errors only).

**Q: It stopped betting — why?**
A: Check the log for `RISK LIMIT REACHED`. Betting halts (monitoring continues) once a
stop-loss, take-profit or 5-loss streak triggers.

## Security

- **No credentials are ever stored.** `data/accounts.json` holds metadata only
  (id/site/label/last-login); account updates are whitelist-filtered so stray
  fields (passwords, PINs) are dropped even if passed in by mistake. Logins
  live inside per-account browser profiles (`data/profiles/<id>`), which are
  gitignored — treat that folder like a wallet: anyone with it can open your
  logged-in sessions.
- **The dashboard has no built-in authentication.** It binds to
  `DASHBOARD_HOST` (default `0.0.0.0`). On an untrusted network set
  `DASHBOARD_HOST=127.0.0.1` so only your machine can reach it.
- **Hardened inputs:** `/api/accounts/new` validates the site id against the
  registry, caps label length and the total profile count (50); `/api/logs`
  only ever reads the two known CSV files; dashboard tables HTML-escape all
  server-supplied values.
- **Nothing sensitive in logs:** the bot logs rounds, decisions and phases —
  never credentials or balances beyond what the game page shows.
- **Manual login only:** the bot never types your phone number or PIN; you log
  in yourself inside the per-account browser profile.

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please read the money-safety rules before
touching the betting/cashout code.

## ⚠️ Legal Disclaimer

This software is provided for **educational and research purposes only**.

- **Financial Risk:** Gambling involves substantial risk. Never bet money you cannot
  afford to lose.
- **Terms of Service:** Automating a betting platform may breach its terms. Use at your
  own risk.
- **No Liability:** The authors are not responsible for financial loss, legal issues or
  damages arising from use of this software.
- **Age Restriction:** You must be of legal gambling age in your jurisdiction.

## License

MIT — see [LICENSE](LICENSE).

---
Originally by [Raccoon254](https://github.com/Raccoon254) · v2 overhaul by the avt-bot contributors
