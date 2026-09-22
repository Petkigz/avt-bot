/* Dashboard client: renders crash history, bankroll, tier and model state
 * from the events broadcast by server.js over socket.io. */

const socket = io();

function setText(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = 'value ' + cls;
}

function fmt(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

// ---------------------------------------------------------------------------
// Live bot / model / bankroll state (driven by 'status' events)
// ---------------------------------------------------------------------------
socket.on('status', (s) => {
  if (!s) return;

  // Mode badge
  const badge = document.getElementById('modeBadge');
  const mode = s.brain && s.brain.mode;
  if (mode === 'live') { badge.textContent = 'LIVE MODE'; badge.className = 'live'; }
  else { badge.textContent = 'PAPER MODE'; badge.className = 'paper'; }

  // Bot state
  let state = 'watching';
  let cls = '';
  if (s.tradingHalted) { state = 'HALTED'; cls = 'neg'; }
  else if (s.cooldownRounds > 0) { state = `cooldown (${s.cooldownRounds})`; cls = 'warn'; }
  else if (s.inFlight) { state = 'round in flight'; }
  setText('botState', state, cls);

  setText('balance', fmt(s.balance, 0));
  const net = s.stats ? s.stats.netProfit : 0;
  setText('netProfit', (net >= 0 ? '+' : '') + fmt(net), net >= 0 ? 'pos' : 'neg');
  setText('winRate', s.stats && s.stats.totalTrades > 0 ? fmt(s.stats.winRate, 1) + '%' : '—');
  setText('roundsStudied', String(s.roundId ?? 0));

  // Strategy profile (all configs are first-class — show which one is active)
  if (s.strategy) {
    const st = s.strategy;
    document.getElementById('strategyProfile').textContent =
      `Strategy: ${st.name} — next stake ${fmt(st.nextStake, 0)} (min ${fmt(st.minBet, 0)} / max ${fmt(st.maxBet, 0)}) · ` +
      `target ${st.targetMultiplier}x · martingale ×${st.martingaleMultiplier} · ` +
      `stop-loss ${fmt(st.stopLoss, 0)} · take-profit ${fmt(st.takeProfit, 0)}`;
  }

  const b = s.brain;
  if (b) {
    const tierEl = document.getElementById('tier');
    tierEl.textContent = b.tier;
    tierEl.className = 'value ' + (b.tier === 'ARMED' ? 'pos' : b.tier === 'MICRO' ? 'warn' : '');
    document.getElementById('tierNote').textContent =
      b.microOnly ? '— MICRO_ONLY safety profile: stakes capped at micro size'
        : b.tier === 'OBSERVING' ? '— warm-up: no bets until enough rounds are studied'
          : b.tier === 'MICRO' ? '— unproven: micro-bets only'
            : '— proven hit-rate: strategy stakes (bankroll-capped)';

    setText('hitRate', b.hitRate !== null && b.hitRate !== undefined ? fmt(b.hitRate * 100, 1) + '%' : '—');

    const m = b.model;
    if (m) {
      const regime = m.regime || '—';
      setText('regime', regime, regime === 'cold' ? 'neg' : regime === 'hot' ? 'pos' : '');
      setText('modelProb', fmt(m.probability), m.probability !== null && m.probability >= m.entryProbability ? 'pos' : 'warn');
      setText('entryThreshold', fmt(m.entryProbability));
      setText('roundsStudied', String(m.roundsStudied ?? 0));
    }

    const p = b.patterns && b.patterns.current;
    setText('pattern', p ? `${p.pattern} (P=${fmt(p.probability)})` : 'none', p ? (p.risky ? 'neg' : '') : '');

    const br = b.bankroll;
    if (br) {
      setText('dailyPnl', (br.dailyPnl >= 0 ? '+' : '') + fmt(br.dailyPnl, 0), br.dailyPnl >= 0 ? 'pos' : 'neg');
      document.getElementById('sessionLimit').textContent =
        `${fmt(-Math.min(0, br.sessionPnl), 0)} / ${fmt(br.sessionLossLimit, 0)}`;
      document.getElementById('dailyLimit').textContent =
        `${fmt(-Math.min(0, br.dailyPnl), 0)} / ${fmt(br.dailyLossLimit, 0)}`;
      document.getElementById('sessionBar').style.width = (br.sessionLimitUsed * 100).toFixed(1) + '%';
      document.getElementById('dailyBar').style.width = (br.dailyLimitUsed * 100).toFixed(1) + '%';
    }

    if (b.lastReasons && b.lastReasons.length) {
      document.getElementById('lastReasons').textContent = 'Last decision: ' + b.lastReasons.join('; ');
    }

    renderLearning(b);
  }
});

socket.on('tradingStopped', () => {
  setText('botState', 'HALTED', 'neg');
});

// ---------------------------------------------------------------------------
// Live learning panel: all-time memory (REST) + patterns & decisions (socket)
// ---------------------------------------------------------------------------
fetch('/api/history')
  .then((r) => r.json())
  .then((data) => {
    const s = data.stats || {};
    setText('memCount', String(s.count ?? 0));
    setText('memAvg', Number.isFinite(s.avg) ? s.avg.toFixed(2) + 'x' : '—');
    setText('memLow', Number.isFinite(s.pctBelow15) ? s.pctBelow15.toFixed(1) : '—');
  })
  .catch(() => setText('memCount', 'unavailable'));

function renderLearning(b) {
  if (!b) return;

  // Entry threshold trend (baseline 0.60 family -> learned value)
  const m = b.model;
  if (m) {
    const learned = m.entryProbability;
    const base = 0.55; // family default; learning only moves it up or down a little
    const trend = learned > base + 0.005 ? '↑ tightened (losses taught caution)'
      : learned < base - 0.005 ? '↓ loosened (wins earned trust)'
        : '→ baseline';
    setText('thresholdTrend', `${fmt(learned)} ${trend}`);
    const bt = m.bestTarget;
    setText('bestTarget', bt ? `${bt.target}x (hist. EV ${fmt(bt.ev, 3)})` : 'not enough data');
  }

  // Strongest pattern families
  const p = b.patterns;
  const pBody = document.getElementById('patternTableBody');
  if (pBody && p && p.topPatterns) {
    pBody.innerHTML = '';
    if (p.topPatterns.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = 'no pattern has enough support yet';
      cell.className = 'small';
      row.appendChild(cell);
      pBody.appendChild(row);
    }
    for (const tp of p.topPatterns) {
      const row = document.createElement('tr');
      const cells = [
        tp.pattern, String(tp.length), String(tp.seen), String(tp.used),
        (tp.probability * 100).toFixed(1) + '%' + (tp.benched ? ' (benched)' : '')
      ];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }
      pBody.appendChild(row);
    }
  }

  // Decision feed (newest first)
  const dBody = document.getElementById('decisionTableBody');
  if (dBody && b.decisionFeed) {
    dBody.innerHTML = '';
    const items = [...b.decisionFeed].reverse().slice(0, 8);
    if (items.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = 'waiting for decisions…';
      cell.className = 'small';
      row.appendChild(cell);
      dBody.appendChild(row);
    }
    for (const d of items) {
      const row = document.createElement('tr');
      const time = new Date(d.ts).toLocaleTimeString();
      const action = d.bet ? `BET` : 'skip';
      const cells = [time, action, d.bet ? String(d.stake) : '', d.tier, d.reason];
      cells.forEach((value, idx) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (idx === 1) cell.className = d.bet ? 'pos' : 'small';
        row.appendChild(cell);
      });
      dBody.appendChild(row);
    }
  }
}

// ---------------------------------------------------------------------------
// Crash chart + prediction accuracy (driven by 'newData' events)
// ---------------------------------------------------------------------------
const chartElement = document.getElementById('lineChart').getContext('2d');

const chartData = {
  labels: [],
  datasets: [{
    label: 'Crash multiplier',
    data: [],
    borderColor: 'rgba(75, 192, 192, 1)',
    backgroundColor: 'rgba(75, 192, 192, 0.2)',
    borderWidth: 2,
    pointRadius: 3,
    pointBackgroundColor: 'rgba(255, 255, 255, 1)',
    pointBorderColor: 'rgba(75, 192, 192, 1)',
    pointBorderWidth: 1
  }]
};

const lineChart = new Chart(chartElement, {
  type: 'line',
  data: chartData,
  options: {
    scales: {
      x: {
        type: 'time',
        time: { unit: 'second', displayFormats: { second: 'HH:mm:ss' } },
        grid: { display: false },
        ticks: {
          color: 'rgba(75, 192, 192, 1)',
          callback: function (value) {
            const currentTime = new Date().getTime();
            const valueTime = new Date(value).getTime();
            const diffInSeconds = Math.round((currentTime - valueTime) / 1000);
            if (diffInSeconds < 60) return diffInSeconds + ' secs ago';
            if (diffInSeconds < 3600) return Math.floor(diffInSeconds / 60) + ' min ago';
            return Math.floor(diffInSeconds / 3600) + ' hours ago';
          }
        }
      },
      y: {
        grid: { color: 'rgba(75, 192, 192, 0.1)' },
        ticks: { color: 'rgba(75, 192, 192, 1)' }
      }
    },
    plugins: {
      legend: { labels: { color: 'rgba(75, 192, 192, 1)' } }
    }
  }
});

function updatePredictionTable(predictions) {
  const tableBody = document.getElementById('predictionTableBody');
  tableBody.innerHTML = '';
  predictions.forEach((prediction, index) => {
    const row = document.createElement('tr');
    for (const value of [index + 1, prediction.predicted.toFixed(2), prediction.actual.toFixed(2), prediction.correct ? 'Yes' : 'No']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    tableBody.appendChild(row);
  });
}

let lastValue = null;
let currentPrediction = null;
let correctPredictions = 0;
let totalPredictions = 0;
const latestPredictions = [];
const MAX_POINTS = 500;

socket.on('newData', (dataPoint) => {
  if (!dataPoint || typeof dataPoint.value !== 'number') return;
  const { value, created_at } = dataPoint;

  if (lastValue !== null && lastValue === value) return;

  chartData.labels.push(created_at);
  chartData.datasets[0].data.push(value);
  if (chartData.labels.length > MAX_POINTS) {
    chartData.labels.shift();
    chartData.datasets[0].data.shift();
  }

  if (currentPrediction !== null) {
    document.getElementById('predictedValue').textContent =
      'Predicted value: ' + (Number.isFinite(currentPrediction) ? currentPrediction.toFixed(2) : 'N/A');

    const isCorrect = currentPrediction <= value;
    correctPredictions += isCorrect ? 1 : 0;
    totalPredictions += 1;

    latestPredictions.push({ predicted: currentPrediction, actual: value, correct: isCorrect });
    if (latestPredictions.length > 10) latestPredictions.shift();
    updatePredictionTable(latestPredictions);

    const accuracyRate = (correctPredictions / totalPredictions) * 100;
    document.getElementById('accuracyRate').textContent = 'Accuracy rate: ' + accuracyRate.toFixed(2) + '%';
  }

  currentPrediction = Number.isFinite(dataPoint.predictedValue) ? dataPoint.predictedValue : null;
  lineChart.update();
  lastValue = value;
});

// ---------------------------------------------------------------------------
// Site & account switching
// ---------------------------------------------------------------------------
let sitesCache = [];
let accountsCache = [];

function el(id) { return document.getElementById(id); }

// HTML-escape anything interpolated into innerHTML (account labels and CSV
// fields are user-supplied data — never trust them).
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function loadSiteControls() {
  try {
    const [sitesRes, accountsRes] = await Promise.all([fetch('/api/sites'), fetch('/api/accounts')]);
    const sitesData = await sitesRes.json();
    accountsCache = await accountsRes.json();
    sitesCache = sitesData.sites || [];

    const siteSelect = el('siteSelect');
    siteSelect.innerHTML = '';
    for (const s of sitesCache) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.currency})`;
      siteSelect.appendChild(opt);
    }
    if (sitesData.active) {
      siteSelect.value = sitesData.active.id;
      el('siteHeader').textContent = `— ${sitesData.active.name}`;
      el('siteStatus').textContent = `Current: ${sitesData.active.name}`;
    }
    refreshAccountSelect();
  } catch (e) { /* server not ready */ }
}

function refreshAccountSelect() {
  const siteId = el('siteSelect').value;
  const select = el('accountSelect');
  select.innerHTML = '';
  const forSite = accountsCache.filter((a) => a.site === siteId);
  if (forSite.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'default (auto-created)';
    select.appendChild(opt);
  }
  for (const a of forSite) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.label;
    select.appendChild(opt);
  }
}

el('siteSelect').addEventListener('change', refreshAccountSelect);

el('switchBtn').addEventListener('click', () => {
  const siteId = el('siteSelect').value;
  const accountId = el('accountSelect').value || null;
  el('siteStatus').textContent = 'Switching…';
  socket.emit('switchSite', { siteId, accountId });
});

el('newAccountBtn').addEventListener('click', async () => {
  const siteId = el('siteSelect').value;
  const label = prompt('Label for the new account on ' + siteId + ':', siteId + ' account 2');
  if (!label) return;
  try {
    await fetch('/api/accounts/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: siteId, label })
    });
    const res = await fetch('/api/accounts');
    accountsCache = await res.json();
    refreshAccountSelect();
  } catch (e) { alert('Could not create account: ' + e.message); }
});

el('loginConfirmBtn').addEventListener('click', () => {
  socket.emit('confirmLogin');
  el('loginConfirmBtn').classList.add('hidden');
  el('siteStatus').textContent = 'Continuing to the game…';
});

socket.on('siteStatus', (s) => {
  if (!s) return;
  const label = s.siteName || s.siteId || '';
  const account = s.accountLabel ? ` / "${s.accountLabel}"` : '';
  if (s.phase === 'loginRequired') {
    el('siteStatus').textContent = `Log in to ${label}${account} in the browser window, then click continue.`;
    el('loginConfirmBtn').classList.remove('hidden');
  } else if (s.phase === 'switching') {
    el('siteStatus').textContent = `Switching to ${label}${account}…`;
    el('loginConfirmBtn').classList.add('hidden');
  } else if (s.phase === 'findGame') {
    el('siteStatus').textContent = `${label}: open Aviator from the site menu — the bot will find it automatically.`;
    el('loginConfirmBtn').classList.add('hidden');
  } else if (s.phase === 'active') {
    el('siteStatus').textContent = `Current: ${label}${account}`;
    el('siteHeader').textContent = `— ${label}`;
    el('loginConfirmBtn').classList.add('hidden');
  } else if (s.phase === 'error') {
    el('siteStatus').textContent = `Switch failed: ${s.message || 'unknown error'}`;
  }
});

// ---------------------------------------------------------------------------
// Log history viewer (rounds.csv / trades.csv via REST)
// ---------------------------------------------------------------------------
let logType = 'rounds';

async function loadLogs() {
  try {
    const res = await fetch(`/api/logs?type=${logType}&limit=40`);
    const data = await res.json();
    const head = el('logTableHead');
    const body = el('logTableBody');
    head.innerHTML = '';
    body.innerHTML = '';
    const rows = data.rows || [];
    el('logInfo').textContent = `${rows.length} most recent ${logType} rows (newest first)`;
    if (rows.length === 0) {
      const th = document.createElement('th');
      th.textContent = 'no stored logs yet';
      head.appendChild(th);
      return;
    }
    for (const key of Object.keys(rows[0])) {
      const th = document.createElement('th');
      th.textContent = key;
      head.appendChild(th);
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const key of Object.keys(rows[0])) {
        const td = document.createElement('td');
        td.textContent = row[key];
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  } catch (e) { /* ignore */ }
}

el('logRoundsBtn').addEventListener('click', () => { logType = 'rounds'; loadLogs(); });
el('logTradesBtn').addEventListener('click', () => { logType = 'trades'; loadLogs(); });
el('logRefreshBtn').addEventListener('click', loadLogs);

// ---------------------------------------------------------------------------
// Live bot sessions (connected to real session state via socket + REST)
// ---------------------------------------------------------------------------
function renderSessions(list) {
  const body = el('sessionsTableBody');
  body.innerHTML = '';
  const note = el('sessionsNote');
  if (!list || list.length === 0) {
    note.textContent = 'No browser sessions open right now.';
    return;
  }
  note.textContent = `${list.length} session(s) open (cap set by MAX_SESSIONS).`;
  for (const s of list) {
    const tr = document.createElement('tr');
    const phaseCls = s.phase === 'monitoring' ? 'live' : (s.phase === 'loginRequired' ? 'paper' : '');
    tr.innerHTML =
      `<td>${esc(s.siteName || s.siteId)}</td>` +
      `<td>${esc(s.accountLabel)}</td>` +
      `<td><span class="${phaseCls}">${esc(s.phase)}</span></td>` +
      `<td>${s.monitoring ? '✅' : '—'}</td>` +
      `<td>${esc(s.roundsSeen)}</td>`;
    body.appendChild(tr);
  }
}

socket.on('sessions', renderSessions);
fetch('/api/sessions').then((r) => r.json()).then(renderSessions).catch(() => {});

// ---------------------------------------------------------------------------
// Saved login profiles (multi-account) — with per-account switch buttons
// ---------------------------------------------------------------------------
async function loadAccountsPanel() {
  try {
    const res = await fetch('/api/accounts');
    const accountsList = await res.json();
    const body = el('accountsTableBody');
    body.innerHTML = '';
    if (accountsList.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4">No saved profiles yet — add one with "+ account".</td>';
      body.appendChild(tr);
      return;
    }
    for (const a of accountsList) {
      const tr = document.createElement('tr');
      const lastLogin = a.lastLoginAt ? a.lastLoginAt.slice(0, 10) : 'never';
      tr.innerHTML = `<td>${esc(a.site)}</td><td>${esc(a.label)}</td><td>${esc(lastLogin)}</td>`;
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.textContent = 'Switch to';
      btn.addEventListener('click', () => {
        el('siteStatus').textContent = `Switching to "${a.label}"…`;
        socket.emit('switchAccount', { siteId: a.site, accountId: a.id });
      });
      td.appendChild(btn);
      tr.appendChild(td);
      body.appendChild(tr);
    }
  } catch (e) { /* server not ready */ }
}

loadAccountsPanel();
setInterval(loadAccountsPanel, 15000);

// ---------------------------------------------------------------------------
// Cross-site history charts (from /api/history/bySite)
// ---------------------------------------------------------------------------
let siteRoundsChart = null;
let siteRecentChart = null;
const sitePalette = ['#4bc0c0', '#ff6384', '#ffce56', '#8e7cff', '#7bd88f', '#ff9f40'];

async function loadSiteHistory() {
  try {
    const res = await fetch('/api/history/bySite');
    const data = await res.json();
    const sites = data.sites || [];

    const statsBody = el('siteStatsBody');
    statsBody.innerHTML = '';
    for (const s of sites) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${esc(s.siteName)}</td>` +
        `<td>${esc(s.rounds)}</td>` +
        `<td>${s.avg.toFixed(2)}x</td>` +
        `<td>${s.pctBelow15.toFixed(1)}%</td>` +
        `<td>${s.accounts.map((a) => `${esc(a.label)} (${esc(a.rounds)})`).join(', ') || '—'}</td>` +
        `<td>${esc(s.lastTs ? s.lastTs.slice(0, 16).replace('T', ' ') : '—')}</td>`;
      statsBody.appendChild(tr);
    }

    if (sites.length === 0) return;

    if (siteRoundsChart) siteRoundsChart.destroy();
    siteRoundsChart = new Chart(el('siteRoundsChart'), {
      type: 'bar',
      data: {
        labels: sites.map((s) => s.siteName),
        datasets: [{
          label: 'Stored rounds',
          data: sites.map((s) => s.rounds),
          backgroundColor: sites.map((_, i) => sitePalette[i % sitePalette.length])
        }]
      },
      options: {
        responsive: true,
        plugins: { title: { display: true, text: 'Rounds recorded per site', color: '#8a97a3' }, legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8a97a3' }, grid: { color: '#333' } },
          y: { ticks: { color: '#8a97a3' }, grid: { color: '#333' }, beginAtZero: true }
        }
      }
    });

    if (siteRecentChart) siteRecentChart.destroy();
    siteRecentChart = new Chart(el('siteRecentChart'), {
      type: 'line',
      data: {
        labels: Array.from({ length: Math.max(...sites.map((s) => s.recent.length)) }, (_, i) => i + 1),
        datasets: sites.map((s, i) => ({
          label: s.siteName,
          data: s.recent,
          borderColor: sitePalette[i % sitePalette.length],
          backgroundColor: 'transparent',
          pointRadius: 1,
          tension: 0.2
        }))
      },
      options: {
        responsive: true,
        plugins: { title: { display: true, text: 'Last 30 crashes per site (same global feed)', color: '#8a97a3' } },
        scales: {
          x: { ticks: { color: '#8a97a3', maxTicksLimit: 10 }, grid: { color: '#333' } },
          y: { ticks: { color: '#8a97a3' }, grid: { color: '#333' } }
        }
      }
    });
  } catch (e) { /* ignore */ }
}

loadSiteHistory();
setInterval(loadSiteHistory, 20000);

loadSiteControls();
loadLogs();
setInterval(loadLogs, 15000);
