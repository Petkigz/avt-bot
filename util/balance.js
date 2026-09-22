/**
 * Robust balance parsing.
 * Betting sites render money in many ways: "KSh 1,234.56", "1 000,50",
 * "€ 500", "1.234,56", plain "500"...
 * Returns a finite number or null when unparseable.
 */
function parseBalance(text) {
    if (text === null || text === undefined) return null;
    let s = String(text).trim();
    if (!s) return null;

    // Strip everything except digits, dots, commas and minus
    s = s.replace(/[^\d.,-]/g, '');
    if (!s || !/\d/.test(s)) return null;

    const hasComma = s.includes(',');
    const hasDot = s.includes('.');

    if (hasComma && hasDot) {
        if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
            // European style: 1.234,56
            s = s.replace(/\./g, '').replace(',', '.');
        } else {
            // US/UK style: 1,234.56
            s = s.replace(/,/g, '');
        }
    } else if (hasComma) {
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length <= 2) {
            // Decimal comma: 1000,50
            s = s.replace(',', '.');
        } else {
            // Thousands separators: 1,000,000
            s = s.replace(/,/g, '');
        }
    }

    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

module.exports = { parseBalance };
