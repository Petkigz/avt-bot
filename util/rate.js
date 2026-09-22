/**
 * Rolling-window round-rate helpers (pure functions — fully testable).
 *
 * A "window" is an array of { t, roundId } samples, newest last. The bot
 * records one sample per heartbeat; the dashboard uses the derived
 * rounds/hour to spot silent monitor stalls.
 */

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;   // keep 10 minutes of samples
const DEFAULT_STALL_AFTER_MS = 5 * 60 * 1000; // flat for 5 minutes = stalled

/**
 * Adds a sample and prunes anything older than maxAgeMs. Returns the window.
 */
function recordSample(window, roundId, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
    window.push({ t: now, roundId });
    while (window.length > 0 && now - window[0].t > maxAgeMs) window.shift();
    return window;
}

/**
 * Rounds per hour over the window (0 when it cannot be computed).
 */
function roundsPerHour(window) {
    if (!Array.isArray(window) || window.length < 2) return 0;
    const first = window[0];
    const last = window[window.length - 1];
    const dtMs = last.t - first.t;
    if (dtMs <= 0) return 0;
    const dRounds = last.roundId - first.roundId;
    if (dRounds < 0) return 0; // roundId reset (new session/page) — no rate yet
    return (dRounds / dtMs) * 3600000;
}

/**
 * True when the window spans at least stalledAfterMs WITHOUT any new round —
 * i.e. the monitor is attached but the game is not producing data.
 */
function isStalled(window, stalledAfterMs = DEFAULT_STALL_AFTER_MS) {
    if (!Array.isArray(window) || window.length < 2) return false;
    const first = window[0];
    const last = window[window.length - 1];
    return last.roundId === first.roundId && (last.t - first.t) >= stalledAfterMs;
}

module.exports = { recordSample, roundsPerHour, isStalled };
