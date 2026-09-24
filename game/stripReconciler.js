'use strict';

/**
 * stripReconciler — reconciles newly observed multiplier strips against
 * the previously observed strip to prevent missing intermediate rounds.
 *
 * When the polling cycle (or network latency) spans multiple quick crashes,
 * observing only the newest bubble drops all intermediate rounds. By finding
 * the alignment between the previous strip and the new strip, all new rounds
 * are recovered in exact chronological sequence.
 */

/**
 * Reconcile a newly observed multiplier strip against the previous strip.
 * Both strips are newest-first arrays of numbers (e.g. [3.09, 1.20, 5.50]).
 *
 * @param {number[]} prevStrip - Previous strip (newest first)
 * @param {number[]} newStrip  - Current strip (newest first)
 * @param {number} [minMatchLength=2] - Minimum matching elements to confirm alignment
 * @returns {{
 *   newRounds: number[],       // chronological order (oldest -> newest) of rounds that ended
 *   recoveredCount: number,    // intermediate rounds saved (>0 means multiple rounds between polls)
 *   overlapped: boolean,       // true if alignment was found; false if strip rolled over completely
 *   droppedOldCount: number
 * }}
 */
function reconcileStrip(prevStrip, newStrip, minMatchLength = 2) {
    if (!Array.isArray(newStrip) || newStrip.length === 0) {
        return { newRounds: [], recoveredCount: 0, overlapped: true, droppedOldCount: 0 };
    }
    if (!Array.isArray(prevStrip) || prevStrip.length === 0) {
        return { newRounds: [newStrip[0]], recoveredCount: 0, overlapped: true, droppedOldCount: 0 };
    }

    // Fast path: strip did not change at all
    if (prevStrip[0] === newStrip[0] && prevStrip.length === newStrip.length) {
        let identical = true;
        for (let i = 0; i < prevStrip.length; i++) {
            if (prevStrip[i] !== newStrip[i]) { identical = false; break; }
        }
        if (identical) {
            return { newRounds: [], recoveredCount: 0, overlapped: true, droppedOldCount: 0 };
        }
    }

    // Search for where prevStrip's head appears inside newStrip
    // Example: newStrip = [4.72, 3.10, 1.18, 1.40, 1.12], prevStrip = [1.40, 1.12, 2.31]
    // prevStrip[0] (1.40) appears at index 3 in newStrip.
    let matchIdx = -1;
    for (let i = 1; i < newStrip.length; i++) {
        if (newStrip[i] === prevStrip[0]) {
            const checkLen = Math.min(newStrip.length - i, prevStrip.length);
            let verified = 0;
            let matches = true;
            for (let k = 0; k < checkLen; k++) {
                if (newStrip[i + k] === prevStrip[k]) {
                    verified++;
                } else {
                    matches = false;
                    break;
                }
            }
            if (matches && verified >= Math.min(minMatchLength, checkLen)) {
                matchIdx = i;
                break;
            }
        }
    }

    if (matchIdx > 0) {
        // Alignment found: newStrip[0 .. matchIdx - 1] are the new rounds.
        // Slice and reverse so they are returned in CHRONOLOGICAL order (oldest -> newest).
        const newRounds = newStrip.slice(0, matchIdx).reverse();
        return {
            newRounds,
            recoveredCount: Math.max(0, newRounds.length - 1),
            overlapped: true,
            droppedOldCount: matchIdx
        };
    }

    // No alignment found (strip completely rolled over or layout reset).
    // Safely emit the newest visible round.
    return {
        newRounds: [newStrip[0]],
        recoveredCount: 0,
        overlapped: false,
        droppedOldCount: 0
    };
}

module.exports = { reconcileStrip };
