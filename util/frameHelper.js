const sleep = require('./sleep');

/**
 * In-page script: locates the round-history strip by CONTENT, not class
 * names. Finds the container whose children hold several short multiplier
 * texts ("1.23x", "x2.50", "15.00") and returns a unique CSS path to it.
 * Works across Spribe client generations ("classic" and "aviator-next").
 */
const STRIP_DISCOVERY_SCRIPT = () => {
    // Multiplier chip: digits with optional dot/comma groups ("1.23x",
    // "x2.50", "15x", "1,105.31x" — big crashes carry a thousands comma).
    const isMult = (t) => /^\s*x?\d[\d.,]*x?\s*$/i.test(t || '');
    const best = { el: null, count: 0 };
    const all = document.querySelectorAll('*');
    for (const el of all) {
        const n = el.childElementCount;
        if (n < 4 || n > 250) continue;
        let hits = 0;
        for (const c of el.children) {
            const t = c.textContent;
            if (t && t.length <= 12 && isMult(t)) hits++;
            if (hits > 15) break;
        }
        if (hits > best.count) { best.count = hits; best.el = el; }
        if (best.count >= 8) break; // clearly the strip — stop scanning
    }
    if (!best.el || best.count < 4) return null;
    // Build a unique selector path (id short-circuits, else nth-of-type chain)
    const parts = [];
    let cur = best.el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 6) {
        if (cur.id) { parts.unshift(`#${cur.id}`); break; }
        let idx = 1;
        let sib = cur.previousElementSibling;
        while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${idx})`);
        cur = cur.parentElement;
        depth++;
    }
    return parts.join(' > ');
};

/**
 * Helpers to locate elements across the main page and all iframes.
 */
class FrameHelper {
    /**
     * Immediate (non-waiting) scan of every frame for a selector.
     * Returns the first frame containing the selector, or null.
     */
    static async findFrameWithSelector(page, selector) {
        for (const frame of page.frames()) {
            try {
                const el = await frame.$(selector);
                if (el) return frame;
            } catch (error) {
                // Frame may have been detached mid-scan — ignore and continue.
            }
        }
        return null;
    }

    /**
     * Poll every frame until the selector appears somewhere.
     */
    static async waitForSelectorInFrames(page, selector, timeout = 10000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const frame = await FrameHelper.findFrameWithSelector(page, selector);
            if (frame) return frame;
            await sleep(500);
        }
        throw new Error(`Selector "${selector}" not found in any frame within ${timeout}ms`);
    }

    /**
     * Boolean convenience used to detect whether a page hosts the game.
     */
    static async hasSelector(page, selector) {
        return (await FrameHelper.findFrameWithSelector(page, selector)) !== null;
    }

    /**
     * Content-based fallback: discovers the round-history strip in any frame
     * by its multiplier texts. Returns { frame, path } or null.
     */
    static async findMultiplierStrip(page) {
        for (const frame of page.frames()) {
            try {
                const path = await frame.evaluate(STRIP_DISCOVERY_SCRIPT);
                if (path) return { frame, path };
            } catch (error) {
                // frame detached or context destroyed — try the next one
            }
        }
        return null;
    }

    /**
     * "Is the game here?" — classic selector first, then content discovery.
     * Returns { frame, stripPath } (stripPath null when the classic
     * selector matched) or null when neither matched.
     */
    static async findGameMarker(page, selector) {
        try {
            const frame = await FrameHelper.findFrameWithSelector(page, selector);
            if (frame) return { frame, stripPath: null };
        } catch (error) { /* fall through to discovery */ }
        const strip = await FrameHelper.findMultiplierStrip(page);
        return strip ? { frame: strip.frame, stripPath: strip.path } : null;
    }
}

module.exports = FrameHelper;
