/**
 * In-memory trade statistics.
 */
class StatsTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this.trades = [];
        this.totalTrades = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
        this.totalProfit = 0;
        this.totalLoss = 0; // accumulated as negative numbers
        this.largestWin = 0;
        this.largestLoss = 0;
        this.currentStreak = 0;
        this.longestWinStreak = 0;
        this.longestLossStreak = 0;
    }

    addTrade(trade) {
        this.trades.push(trade);
        // Cap the trade log so a 24h run doesn't grow memory without bound.
        if (this.trades.length > 1000) this.trades.shift();
        this.totalTrades++;

        if (trade.won) {
            this.winningTrades++;
            this.totalProfit += trade.profit;
            this.largestWin = Math.max(this.largestWin, trade.profit);
            this.currentStreak = this.currentStreak > 0 ? this.currentStreak + 1 : 1;
            this.longestWinStreak = Math.max(this.longestWinStreak, this.currentStreak);
        } else {
            this.losingTrades++;
            this.totalLoss += trade.loss; // trade.loss is negative
            this.largestLoss = Math.min(this.largestLoss, trade.loss);
            this.currentStreak = this.currentStreak < 0 ? this.currentStreak - 1 : -1;
            this.longestLossStreak = Math.min(this.longestLossStreak, this.currentStreak);
        }
    }

    getStats() {
        return {
            totalTrades: this.totalTrades,
            winRate: this.totalTrades > 0 ? (this.winningTrades / this.totalTrades) * 100 : 0,
            winningTrades: this.winningTrades,
            losingTrades: this.losingTrades,
            totalProfit: this.totalProfit,
            totalLoss: this.totalLoss,
            netProfit: this.totalProfit + this.totalLoss,
            largestWin: this.largestWin,
            largestLoss: this.largestLoss,
            averageWin: this.winningTrades > 0 ? this.totalProfit / this.winningTrades : 0,
            averageLoss: this.losingTrades > 0 ? this.totalLoss / this.losingTrades : 0,
            longestWinStreak: this.longestWinStreak,
            longestLossStreak: Math.abs(this.longestLossStreak)
        };
    }
}

module.exports = StatsTracker;
