const mysql = require('mysql2');
const logger = require('../util/logger');

/**
 * Optional MySQL persistence (enabled via DATABASE_ENABLED=true / .env).
 *
 * Fixes over the original:
 *  - Uses the maintained `mysql2` driver (the legacy `mysql` package was removed).
 *  - Auto-creates its schema on first connect (no more INSERT into a missing table).
 *  - Auto-reconnects after connection loss.
 *  - Failures are logged, never thrown into the game loop.
 */
class Database {
    constructor(config) {
        this.options = config.DATABASE;
        this.connection = null;
        this.ready = false;
        this.reconnecting = false;
    }

    connect() {
        if (!this.options.ENABLED) {
            logger.info('Database disabled (set DATABASE_ENABLED=true to enable)');
            return;
        }
        try {
            this.connection = mysql.createConnection({
                host: this.options.host,
                port: this.options.port,
                user: this.options.user,
                password: this.options.password,
                database: this.options.database
            });

            this.connection.connect((err) => {
                if (err) {
                    logger.error(`Database connection error: ${err.message}`);
                    this.ready = false;
                    return;
                }
                logger.info('Database connected');
                this.ready = true;
                this.ensureSchema();
            });

            this.connection.on('error', (err) => {
                logger.error(`Database error: ${err.message}`);
                this.ready = false;
                if (err.code === 'PROTOCOL_CONNECTION_LOST' && !this.reconnecting) {
                    this.reconnecting = true;
                    setTimeout(() => {
                        this.reconnecting = false;
                        logger.info('Attempting database reconnect...');
                        this.connect();
                    }, 5000);
                }
            });
        } catch (error) {
            logger.error(`Database setup failed: ${error.message}`);
        }
    }

    ensureSchema() {
        this.query(`
            CREATE TABLE IF NOT EXISTS rounds (
                id INT AUTO_INCREMENT PRIMARY KEY,
                multiplier DOUBLE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        this.query(`
            CREATE TABLE IF NOT EXISTS trades (
                id INT AUTO_INCREMENT PRIMARY KEY,
                bet_amount DOUBLE NOT NULL,
                multiplier DOUBLE NULL,
                profit DOUBLE NOT NULL DEFAULT 0,
                loss DOUBLE NOT NULL DEFAULT 0,
                won TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    saveRound(multiplier) {
        if (!Number.isFinite(multiplier)) return;
        this.query('INSERT INTO rounds (multiplier) VALUES (?)', [multiplier]);
    }

    saveTrade(trade) {
        if (!trade) return;
        this.query(
            'INSERT INTO trades (bet_amount, multiplier, profit, loss, won) VALUES (?, ?, ?, ?, ?)',
            [
                trade.betAmount,
                Number.isFinite(trade.multiplier) ? trade.multiplier : null,
                trade.profit || 0,
                trade.loss || 0,
                trade.won ? 1 : 0
            ]
        );
    }

    query(sql, params = []) {
        if (!this.ready || !this.connection) return;
        this.connection.query(sql, params, (err) => {
            if (err) logger.error(`Database query failed: ${err.message}`);
        });
    }

    disconnect() {
        if (this.connection) {
            try { this.connection.end(); } catch (error) { /* already gone */ }
            this.connection = null;
            this.ready = false;
            logger.info('Database connection closed');
        }
    }
}

module.exports = Database;
