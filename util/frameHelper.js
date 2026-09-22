const sleep = require('./sleep');

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
}

module.exports = FrameHelper;
