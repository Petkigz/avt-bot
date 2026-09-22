# Contributing to avt-bot

Contributions are welcome. A few ground rules:

## Getting started

1. Fork the repository and create a branch from `main`.
2. `npm install` and make sure `npm test` passes before you open a PR.
3. Keep changes focused — one feature or fix per PR.

## Code style

- CommonJS modules (`require`/`module.exports`) to stay consistent with the codebase.
- 4-space indentation in backend code, 2-space in `public/`.
- Log with the shared winston logger (`util/logger.js`); never `console.log` in game-loop code.
- Never commit secrets. Anything credential-related belongs in `.env` (see `.env.example`).

## Money-safety rules for changes

This bot makes decisions that cost real money, so:

- **Never log a win without confirmation from the site.** When in doubt, book conservatively as a loss.
- Always check balance before placing a bet.
- Risk limits (`stopLoss`, `takeProfit`, 5-loss breaker) must never be bypassed by new code paths.
- The monitoring cycle must stay re-entrancy-safe (no overlapping cycles, no double bets).

## Pull request checklist

- [ ] `npm test` passes
- [ ] New behavior is covered by a test where practical
- [ ] README/docs updated if user-facing behavior changed
- [ ] No secrets, no `node_modules`, no `.idea` in the diff
