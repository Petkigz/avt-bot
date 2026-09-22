# Aviator Betting Bot

## ⚠️ Important Notice

Please note: This project is open source and intended for community collaboration. I'm unable to provide free bot creation services or individual configuration support due to time constraints. This repository is meant for developers to contribute and learn together.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2014.0.0-brightgreen.svg)](https://nodejs.org/)
[![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/yourusername/aviator-bot/issues)

An intelligent automation tool for the Aviator game, leveraging Node.js, Puppeteer, and advanced betting strategies. This bot automates the betting process while implementing smart risk management and real-time analytics.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Strategies](#strategies)
- [Deprecated Features](#deprecated-support-for-major-betting-sites-like-betika)
- [Future Enhancements](#future-enhancements)
- [FAQ](#faq)
- [Contributing](#-contributing)
- [Support This Project](#-support-this-project)
- [Disclaimer](#-disclaimer)
- [License](#license)

## Features

### Core Features
- Fully automated betting with customizable strategies
- Real-time game monitoring and analysis
- Smart bankroll management
- Comprehensive statistics tracking
- Martingale and custom betting progressions
- Fast and reliable browser automation
- Detailed logging and error handling

### Advanced Features
- Multiple pre-configured betting strategies
- Automatic stop-loss and take-profit
- Optional web interface for monitoring
- Database integration for bet history
- Statistical analysis tools

## Requirements

- Node.js (version >= 14.0.0)
- npm (comes with Node.js)
- MySQL (optional, for database features)
- Modern web browser
- Stable internet connection

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Raccoon254/Aviator-Automated-Betika-Bot.git aviator-bot
   cd aviator-bot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the bot:**

   You can test the bot on the live demo site:
   ```bash
   npm run start
   ```

   Or alternatively:
   ```bash
   node index.js
   ```

4. **Configure (Optional):**

   If you wish to make modifications, edit the configuration file:
   ```bash
   # Edit util/config.js with your preferred settings
   ```

## Configuration

### Base Configuration
```javascript
// util/config.js
module.exports = {
    NAVIGATION: {
        BASE_URL: 'https://spribe.co/welcome',
        TIMEOUT: 60000
    },
    GAME: {
        POLLING_INTERVAL: 4000,
        MULTIPLIER_THRESHOLD: 1.50
    }
};
```

### Strategy Configuration
```javascript
BETTING_STRATEGIES: {
    CONSERVATIVE: {
        initialBet: 1.00,
        maxBet: 50.00,
        minBet: 1.00,
        targetMultiplier: 1.20,
        stopLoss: 20.00,
        takeProfit: 40.00
    }
    // ... other strategies
}
```

## How It Works

### 1. Game State Monitoring
```javascript
// game/gameMonitor.js
async monitorGame() {
    // Continuously monitor game state
    const gameState = await this.getGameState(frame);
    
    // Check for game phases
    if (this.isGameEnd(gameState.multiplier)) {
        // Handle game end
    }
    
    // Monitor for betting opportunities
    if (this.shouldPlaceBet(gameState)) {
        // Place bet
    }
}
```

### 2. Betting Logic
The bot implements a sophisticated betting system:

1. **Game Phase Detection**:
   - Monitors multiplier changes
   - Detects game start/end
   - Tracks betting opportunities

2. **Bet Placement**:
   ```javascript
   async placeBet(frame) {
       // Set bet amount
       await setBetAmount(frame);
       
       // Click bet button
       await clickBetButton(frame);
       
       // Monitor result
       await monitorBetResult(frame);
   }
   ```

3. **Cashout Management**:
   ```javascript
   async checkCashout(frame) {
       if (currentMultiplier >= targetMultiplier) {
           await executeCashout(frame);
       }
   }
   ```

### 3. Risk Management
- Implements stop-loss
- Tracks consecutive losses
- Manages bet sizing
- Monitors total exposure

## Deprecated Support for Major Betting Sites Like Betika

**Note**: The following features have been temporarily removed from the current version:

- **Live betting site integration** - Configuration for major betting sites (Betika, etc.) has been removed
- **Database integration** - MySQL database features are currently disabled
- **Web interface** - The monitoring dashboard is temporarily unavailable
- **Statistical analysis tools** - Predictive analytics features are under development

These features are planned for re-implementation in future releases. If you need access to legacy configurations, please open an issue on GitHub.

## How It Works
The bot operates in a series of steps as outlined below:

1. **Authentication**: Logs into the betting site using provided credentials.
2. **Navigation**: Once logged in, it navigates to the Aviator game page.
3. **Monitoring**: The bot continuously monitors the Aviator values displayed on the page, updating every 4 seconds.
4. **Analysis & Decision Making**: It analyzes the latest win values and decides whether to place a bet based on predefined conditions.
5. **Betting**: If the conditions are met, the bot places a bet.
6. **Loop**: The bot repeats the monitoring and betting process, providing real-time feedback and data logging.

> **Note**: The monitoring and betting process will continue indefinitely. To stop the bot, you will need to manually interrupt the script execution using `CTRL + C` in your terminal.


## Future Enhancements

1. **Machine Learning Integration**
   - Pattern recognition
   - Predictive analytics
   - Risk assessment

2. **Enhanced UI**
   - Real-time statistics
   - Performance graphs
   - Strategy analysis

3. **Advanced Features**
   - Multiple account support
   - API integration
   - Mobile notifications

## FAQ

**Q: How do I customize betting strategies?**
A: Edit the strategy configurations in `util/config.js` or use the interactive prompt when starting the bot.

**Q: Is this bot guaranteed to make profit?**
A: No. This is a tool for automation and should be used responsibly with proper risk management.

**Q: How do I handle errors?**
A: Check the `logs/error.log` file for detailed error information. Most common issues are related to network connectivity or selector changes.

## ⚠️ Legal Disclaimer

**IMPORTANT - PLEASE READ CAREFULLY:**

This software is provided for **educational and research purposes only**. By using this bot, you acknowledge and agree to the following:

- **Financial Risk**: Gambling involves substantial financial risk. Never bet money you cannot afford to lose.
- **Terms of Service**: Using automated bots may violate the terms of service of betting platforms. Use at your own risk.
- **No Liability**: The developers and contributors are not responsible for any financial losses, legal issues, or other damages resulting from the use of this software.
- **Age Restriction**: You must be of legal gambling age in your jurisdiction to use this software.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## 💝 Support This Project

If you find this project helpful and would like to support its development, consider making a donation:

**[Donate via KenTom](https://www.kentom.co.ke/donate)**

Your support helps maintain and improve this project. Every contribution, no matter the size, is greatly appreciated!

---
Made with ❤️ by [Raccoon254](https://www.kentom.co.ke/)
