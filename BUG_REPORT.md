# 🐛 avt-bot — Full Bug Report & Missing-Features Audit

Reviewed: 2026-09-22 · Source: `Raccoon254/Aviator-Automated-Betika-Bot@main` (imported into this repo)
Scope: `index.js`, `game/*`, `util/*`, `database/*`, `public/*`, `package.json`, CI, README

---

## 🔴 CRITICAL — the bot doesn't behave the way it claims

### 1. Martingale never progresses — every bet is the initial bet
`game/betManager.js:26` calls `this.strategy.calculateNextBet()` with **no argument**.
In `game/strategies.js:16-21`, `if (!lastResult) return this.initialBet;` — and **no code anywhere ever passes a win/loss result**. `consecutiveLosses`/`consecutiveWins` are never updated, bet size never changes. The entire martingale engine is dead code.

### 2. Stop-loss / take-profit / loss-streak breaker are never enforced
`shouldStopTrading()` (`game/strategies.js:35`) is **never called**. The bot ignores `stopLoss`, `takeProfit`, and the 5-consecutive-losses breaker, and will keep betting until the 24h timer. On a real-money account this can drain the whole balance.

### 3. The strategy you pick in the menu is silently ignored
`index.js` (handleNewTab) does `gameMonitor.strategy = new BettingStrategy(strategyConfig)` **after** `GameMonitor`'s constructor already built `BetManager` with the hardcoded **AGGRESSIVE** strategy (`game/gameMonitor.js:13-15`). `BetManager` keeps its own reference — so bet sizing and cashout targets are always AGGRESSIVE no matter what you selected.

### 4. Custom strategy can never place a bet
`customStrategySetup()` (`index.js`) never asks for `averageMultiplierThreshold`, so it's `undefined`.
The bet condition in `game/gameMonitor.js:140` is `avgMultiplier <= averageThreshold` → comparison with `undefined` is always false → **a Custom-strategy bot bets zero times**.

### 5. Off-by-one crash attribution — bets settled with the WRONG round's crash value
When the bubble changes, `gameMonitor.js` passes `this.previousMultiplier` to `betManager.handleGameCrash(...)`. But `previousMultiplier` is the *previous* bubble (= the crash of the round **before** the one that just ended); the new value `gameState.multiplier` is the crash of the round that just finished. Consequences:
- losses are recorded against the wrong multiplier,
- `multiplierHistory` is permanently one round stale (the freshest crash is never in the average when decisions are made).

### 6. Polling overlap → possible DOUBLE bets
`startMonitoring()` uses `setInterval(fn, 4000)`, but one `monitorGame()` cycle can take up to **30s** (`FrameHelper.waitForSelectorInFrames` default timeout). Overlapping cycles both see `!betPlaced && !isWaitingForResult` and both call `placeBet()` → two bets in one round. Needs a re-entrancy lock or chained `setTimeout`.

### 7. New-tab race: bot can CLOSE the game tab before ever monitoring it
`index.js` (handleNewTab): `await newPage.waitForNavigation(...)` runs *after* `targetcreated` fires. If the page already finished navigating, this waits the full 60s timeout, throws, and the `catch` block runs `await newPage.close()` — the game tab is closed and nothing is monitored. Classic waitForNavigation race; needs a `Promise.race` with a "already loaded" check.

### 8. Same-tab navigation is never handled
All game detection hinges on the browser firing `targetcreated` (i.e., a **new tab**). If clicking the demo button navigates the *same* tab (common with Spribe embeds), no `targetcreated` event fires → the bot idles forever after the intro clicks.

### 9. Wins are recorded optimistically, without verification
`executeCashout()` (`game/betManager.js`) records a winning trade the moment `button.click()` executes — it never confirms the site accepted the cashout. With a 4s polling delay, a round can crash between the check and the click; the site rejects the cashout, but the bot logs a **phantom win**. Profit is also computed with `targetMultiplier` instead of the actual cashout multiplier.

### 10. Bet amount is likely never applied on the Angular page
`placeBet()` sets `input.value = amount` and dispatches `input`/`change` events. Aviator is Angular (the selectors themselves contain `ng-star-inserted`) and does not pick up programmatic `value` writes — it needs the native value-setter trick or real keyboard typing. Worse, the evaluate return value is ignored, so the bot logs "Successfully placed bet" even if the amount wasn't registered.

---

## 🟠 HIGH

11. **Unbounded monitors** — `handleNewTab` starts a `GameMonitor` for *every* new page target. Multiple popups = multiple betting loops betting simultaneously. `setInterval` handles are also never cleared (monitoring survives "shutdown" until `process.exit`).
12. **Balance parsing is brittle** — `parseFloat(text.replace(/,/g,''))` returns `NaN` on currency symbols ("KSh 1,000" etc.); there's no NaN guard, and balance isn't used in any decision anyway — there is **no insufficient-balance check** before betting.
13. **No round-phase state machine** — the only state signal is "bubble changed". During the betting window the bet button is active; depending on timing the bot can bet for the *next* round while `betPlaced` bookkeeping assumes the current one → skipped rounds or double bets per round.
14. **Database layer is 100% dead code** — `database.connect()` is commented out in `index.js`, `saveBubbleValue()` is never called, there's no table schema anywhere, and no reconnect logic. Both `mysql` (deprecated lib) and `mysql2` are installed; only `mysql` is required.
15. **The dashboard is orphaned** — `public/index.html` + `script.js` expect a socket.io server emitting `newData`, but **no server file exists**. `express` and `socket.io` are installed and never used. The web UI literally cannot run.
16. **CI is broken** — `.github/workflows/node.js.yml` starts with a junk line (`aviatorpredictortool This workflow...`) making the YAML header invalid, and `npm test` fails because `package.json` has no `test` script.
17. **`unhandledRejection` only logs and continues** — in a bot that handles money, silent promise failures can leave the state machine inconsistent; at minimum the current round/bet state should be reset.

---

## 🟡 MEDIUM

18. `public/index.html`: **duplicate `id="accuracyRate"`** (only the first element ever updates) and a **stray backtick** after `</style>` that renders on the page.
19. `public/script.js`: `dataPoint.predictedValue.toFixed(2)` throws when `predictedValue` is undefined (it guards `currentPrediction` but renders `dataPoint.predictedValue`); `movingAverage()` and `meanAbsolutePercentageError()` are unused; chart label/data arrays grow unbounded (memory leak on a 24h run).
20. `package.json`: `"main": "main.js"` points at a file that doesn't exist (entry is `index.js`); heavy unused deps: `@tensorflow/tfjs`, `arima`, `python-shell`, `puppeteer-core`, `mysql2`, `chart.js` (server-side); the npm packages `readline` and `process` shadow Node built-ins and should be removed.
21. **Hardcoded secrets/config** — DB credentials (`root`/empty password) sit in `util/config.js`; no `.env`/dotenv support at all. `BASE_URL` and all selectors are hardcoded to the Spribe demo.
22. **Fragile selectors** — `ng-star-inserted` in BET_BUTTON/CASHOUT_BUTTON changes with every Angular build; there's no selector self-check or fallback.
23. **Inconsistent defaults** — CLI falls back to MODERATE, but `GameMonitor` constructor hardcodes AGGRESSIVE and `startMonitoring()` logs "with aggressive strategy" regardless.
24. `logger.debug(...)` calls (betManager, database) never print — logger level is `info`.
25. `FrameHelper` tests frames sequentially with 1s waits each (slow with many frames) and returns the **first** match — could grab a hidden/duplicate frame instead of the live game iframe.
26. `navigateInitialPages()` throws on the first missing selector and kills the whole bot — no retry on flaky page loads.
27. `statsTracker.trades` grows unbounded and is never persisted — all stats die with the process.

---

## 🔵 MINOR / HYGIENE

28. `README.md`: clone URL points at the old repo; a badge links to `yourusername`; references `LICENSE` and `CONTRIBUTING.md` which **don't exist**; "How It Works" section is duplicated; claims "Authentication: Logs into the betting site using provided credentials" — no login code exists anywhere.
29. `.idea/` JetBrains settings are committed (should be in `.gitignore`).
30. `page.waitForTimeout()` is deprecated and was **removed in Puppeteer ≥ 22** — any dependency upgrade breaks `index.js` and `betManager.js`.
31. `package.json` has no `engines` field while CI tests Node 18/20/22 and the README claims Node ≥ 14.

---

## ❌ MISSING FEATURES (the roadmap)

| # | Missing piece | Why it matters |
|---|---|---|
| 1 | **Login/authentication flow** for a real bookmaker | README claims it; nothing exists — bot only works on the public demo |
| 2 | **Dashboard server** (`server.js`: express static + socket.io broadcast of `newData`) | `public/` UI is currently unrunnable |
| 3 | **Risk enforcement hook** — call `strategy.shouldStopTrading(stats)` every cycle and exit the loop | stop-loss/take-profit are decorative today |
| 4 | **Result → strategy wiring** — feed win/loss into `calculateNextBet(result)` | martingale actually starts working |
| 5 | **Balance check** before every bet (`balance >= betAmount`) | avoids rejected bets / debt |
| 6 | **Bet & cashout confirmation** (balance delta or bet-slip check) | stops phantom wins/losses |
| 7 | **Round-phase state machine** (waiting → betting → in-flight → crashed) with events | fixes off-by-one & double-bet bugs structurally |
| 8 | **DB schema + wiring** (create table, connect, save round data, reconnect) | persistence feature actually exists |
| 9 | **Crash recovery** — page reload, session expiry, browser crash → restart flow | a 24h run WILL hit these |
| 10 | **dotenv-based config** (credentials, URLs, strategy params) | security + per-user setup |
| 11 | **Monitor lock / dedupe** — one monitor per game, guarded cycle | concurrency safety |
| 12 | **Same-tab navigation support** in `index.js` | reliability of game detection |
| 13 | **Tests** (unit: strategies/statsTracker; integration: mocked frames) + fix CI | `npm test` currently fails |
| 14 | **LICENSE + CONTRIBUTING.md** | referenced by README, absent |
| 15 | **Stats persistence** across restarts | 24h runs lose everything on exit |

---

## Suggested fix order

1. Bugs **#1–#4** (strategy wiring) — small, isolated, unblocks everything else
2. Bug **#5** (off-by-one) + **#13/7** (state machine) — correctness of game reading
3. Bugs **#6/#11** (concurrency + monitor dedupe) — money safety
4. Bugs **#7/#8** (tab handling) — bot actually starts reliably
5. Bugs **#9/#10** (verification + Angular input) — bets do what they say
6. Missing #2 (dashboard server) — quick win, visible result
7. Missing #3/#10 (risk + env config), then #8 (DB), #13 (tests/CI)
