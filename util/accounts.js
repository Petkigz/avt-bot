const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');

/**
 * Account manager — saved login profiles for multi-account sessions.
 *
 * Stores ACCOUNT METADATA ONLY — never passwords. Each account gets its own
 * persistent browser profile (data/profiles/<id>), so logging in once per
 * account keeps the session alive between runs. Multiple accounts = multiple
 * profiles; concurrent sessions are capped by MAX_SESSIONS.
 *
 * data/accounts.json format (v2):
 *   { accounts: [{ id, site, label, notes, lastLoginAt, createdAt }],
 *     state:    { lastActive: { siteId, accountId, ts } | null } }
 * The legacy plain-array format is still read for backward compatibility.
 */
class AccountsManager {
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, 'accounts.json');
        this.profilesDir = path.join(dir, 'profiles');
        this.accounts = [];
        this.state = { lastActive: null };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (Array.isArray(raw)) {
                    this.accounts = raw; // legacy format
                } else if (raw && Array.isArray(raw.accounts)) {
                    this.accounts = raw.accounts;
                    this.state = { lastActive: (raw.state && raw.state.lastActive) || null };
                }
            }
        } catch (error) {
            logger.warn(`Could not load accounts (${error.message}) — starting fresh`);
            this.accounts = [];
            this.state = { lastActive: null };
        }
    }

    save() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify({
                accounts: this.accounts,
                state: this.state
            }, null, 2));
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

    /**
     * Creates a new saved login profile. Only whitelisted metadata is kept —
     * anything else (e.g. credentials passed by mistake) is dropped.
     */
    add({ site, label, notes = '' }) {
        const id = `${site}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const account = {
            id,
            site,
            label: label || site,
            notes,
            lastLoginAt: null,
            createdAt: new Date().toISOString()
        };
        this.accounts.push(account);
        this.save();
        return account;
    }

    /**
     * Whitelisted metadata update (label/notes only).
     */
    update(id, patch = {}) {
        const account = this.get(id);
        if (!account) return null;
        if (typeof patch.label === 'string') account.label = patch.label;
        if (typeof patch.notes === 'string') account.notes = patch.notes;
        this.save();
        return account;
    }

    /**
     * Marks the account's login profile as freshly logged in.
     */
    touchLogin(id) {
        const account = this.get(id);
        if (!account) return null;
        account.lastLoginAt = new Date().toISOString();
        this.save();
        return account;
    }

    remove(id) {
        const before = this.accounts.length;
        this.accounts = this.accounts.filter((a) => a.id !== id);
        if (this.state.lastActive && this.state.lastActive.accountId === id) {
            this.state.lastActive = null;
        }
        if (this.accounts.length !== before) this.save();
    }

    /**
     * Remembers which site/account was active so the next start can restore
     * the same session (used when SITE env is not set explicitly).
     */
    setLastActive(siteId, accountId) {
        this.state.lastActive = { siteId, accountId, ts: new Date().toISOString() };
        this.save();
    }

    getLastActive() {
        return this.state.lastActive;
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
