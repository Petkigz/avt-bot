const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');

/**
 * Account manager.
 *
 * Stores ACCOUNT METADATA ONLY — never passwords. Each account gets its own
 * persistent browser profile (data/profiles/<id>), so logging in once per
 * account keeps the session alive between runs. Multiple accounts = multiple
 * profiles; concurrent sessions are capped by MAX_SESSIONS.
 *
 * data/accounts.json format:
 *   [{ id, site, label, notes, createdAt }]
 */
class AccountsManager {
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, 'accounts.json');
        this.profilesDir = path.join(dir, 'profiles');
        this.accounts = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (Array.isArray(raw)) this.accounts = raw;
            }
        } catch (error) {
            logger.warn(`Could not load accounts (${error.message}) — starting fresh`);
            this.accounts = [];
        }
    }

    save() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.accounts, null, 2));
        } catch (error) {
            logger.warn(`Could not persist accounts: ${error.message}`);
        }
    }

    list(siteId = null) {
        return siteId ? this.accounts.filter((a) => a.site === siteId) : [...this.accounts];
    }

    get(id) {
        return this.accounts.find((a) => a.id === id) || null;
    }

    /**
     * Returns the account, creating a default one for the site if needed.
     */
    ensureDefault(siteId) {
        const existing = this.list(siteId);
        if (existing.length > 0) return existing[0];
        return this.add({ site: siteId, label: `${siteId} account` });
    }

    add({ site, label, notes = '' }) {
        const id = `${site}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const account = { id, site, label: label || site, notes, createdAt: new Date().toISOString() };
        this.accounts.push(account);
        this.save();
        return account;
    }

    remove(id) {
        const before = this.accounts.length;
        this.accounts = this.accounts.filter((a) => a.id !== id);
        if (this.accounts.length !== before) this.save();
    }

    /**
     * Persistent browser profile directory for this account (keeps the login
     * session between runs).
     */
    profileDir(accountId) {
        return path.join(this.profilesDir, accountId);
    }
}

module.exports = AccountsManager;
