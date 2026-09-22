/**
 * Promise-based sleep — replaces the deprecated `page.waitForTimeout()`
 * which was removed in Puppeteer >= 22.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = sleep;
