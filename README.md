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
- [Live dashboard](#live-dashboard)
- [Database](#database)
- [How it works](#how-it-works)
- [Testing](#testing)
- [FAQ](#faq)
- [Contributing](#-contributing)
- [Disclaimer](#-legal-disclaimer)
- [License](#license)

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
| `DATABASE_ENABLED` | `false` | Enable MySQL persistence |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

> **Note:** Automating a real bookmaker may violate its terms of service — know the
> rules and the risks before pointing this at a funded account. If BetPawa serves a
> different Aviator build, the selectors in `util/config.js` are the only values to
> adjust (they target the standard Spribe widget).

## Strategies

Choose interactively at startup:

1. **Conservative** — low risk, small target multiplier
2. **Moderate** — balanced
3. **Aggressive** — higher stakes, higher target
4. **Custom** — set every parameter yourself

Strategy fields:

- `initialBet`, `minBet`, `maxBet` — stake bounds
- `targetMultiplier` — cash out when the live multiplier reaches this
- `martingaleMultiplier` — multiply the stake by this after each loss (capped at `maxBet`)
- `stopLoss` / `takeProfit` — halt betting when net result crosses these
- `averageMultiplierThreshold` — only bet when recent average crash is at/below this
- `maxConsecutiveLosses` — halt betting after this many losses in a row (default 5)

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

When `DASHBOARD_ENABLED=true`, open `http://localhost:3000` to see the crash history
chart, the model state (regime, probability, threshold), session P/L, win rate,
the current prediction and a running accuracy table. The server pushes each
completed round over Socket.IO.

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

Runs the unit tests for the strategy engine, stats tracker and balance parsing.

## FAQ

**Q: Does this guarantee profit?**
A: No. Crash games are negative-expectation; this is an automation/research tool. Use
strict risk limits.

**Q: Where are the logs?**
A: `logs/combined.log` (all) and `logs/error.log` (errors only).

**Q: It stopped betting — why?**
A: Check the log for `RISK LIMIT REACHED`. Betting halts (monitoring continues) once a
stop-loss, take-profit or 5-loss streak triggers.

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
