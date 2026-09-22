const fs = require('fs');
const path = require('path');

/**
 * Minimal CSV append logger (round-by-round + trade logs, simulation output).
 */
class CsvLog {
    constructor(file, headers) {
        this.file = file;
        this.headers = headers;
        this.initialized = fs.existsSync(file);
    }

    write(rowObj) {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            let out = '';
            if (!this.initialized) {
                out += this.headers.join(',') + '\n';
                this.initialized = true;
            }
            out += this.headers.map((h) => CsvLog.escape(rowObj[h])).join(',') + '\n';
            fs.appendFileSync(this.file, out);
        } catch (error) {
            // Logging must never break the loop.
        }
    }

    static escape(value) {
        if (value === null || value === undefined) return '';
        const s = String(value);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }
}

module.exports = CsvLog;
