/* Dashboard client: renders crash history, bankroll, tier and model state
 * from the events broadcast by server.js over socket.io. */

const socket = io();

// Connection status chip
socket.on('connect', () => {
  document.getElementById('connText').textContent = 'connected';
  document.getElementById('connChip').classList.add('ok');
  const b = document.getElementById('fatalBanner');
  if (b) b.classList.add('hidden');
});
socket.on('disconnect', () => {
  document.getElementById('connText').textContent = 'disconnected';
  document.getElementById('connChip').classList.remove('ok');
  showFatal('Connection to the bot lost — is the black bot window still running? Restart it, then reload this page (Ctrl+R).');
});


// Safe listener: a missing (e.g. stale-cached) element must NEVER kill the
// whole dashboard script — that silently empties every panel.
function onEvent(id, ev, fn) {
  const node = el(id);
  if (node) node.addEventListener(ev, fn);
  else console.warn(`UI element #${id} not found — page may be stale; press Ctrl+F5`);
}

function showFatal(msg) {
  const b = document.getElementById('fatalBanner');
  if (!b) return;
  b.textContent = msg;
  b.classList.remove('hidden');
}
window.addEventListener('error', (e) => {
  showFatal(`Dashboard error: ${e.message} — press Ctrl+F5 to force-reload the latest UI.`);
});

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
    setText('bestTarget', bt ? `${bt.target}x (in-sample hist. EV ${fmt(bt.ev, 3)} — curiosity metric, not a bet input)` : 'not enough data');
  }

  // Walk-forward signal verdict (does this stream show OOS predictive signal?)
  const sv = b.signal;
  const svEl = document.getElementById('signalVerdict');
  if (svEl) {
    if (sv && sv.verdict) {
      const v = sv.verdict;
      svEl.textContent = v.signalDetected
        ? `🔓 SIGNAL DETECTED (${v.rounds} rds @${v.target}x) — feature-model research unlocked`
        : `no OOS signal (${v.rounds} rds @${v.target}x) — discipline-only`;
      svEl.className = 'value small ' + (v.signalDetected ? 'pos' : '');
      if (v.signalDetected) {
        svEl.style.color = '#38c172';
        svEl.style.fontWeight = '700';
      }
    } else if (sv) {
      svEl.textContent = `awaiting 400+ rounds (${sv.policy})`;
      svEl.className = 'value small';
    } else {
      svEl.textContent = '—';
    }
  }

  // Research phase ladder (round-gated roadmap, per site)
  const rpEl = document.getElementById('researchPhase');
  if (rpEl) {
    const studied = (b.model && Number.isFinite(b.model.roundsStudied)) ? b.model.roundsStudied : null;
    let phase;
    if (sv && sv.verdict && sv.verdict.signalDetected) {
      phase = { txt: '3 · SIGNAL — feature-model research unlocked', color: '#38c172' };
    } else if (sv && sv.verdict) {
      phase = { txt: `2 · VALIDATED on ${sv.verdict.rounds} rds — discipline-only betting`, color: '#4ea1ff' };
    } else if (studied !== null && studied < 150) {
      phase = { txt: `0 · WARM-UP (${studied}/150 rds) — observing, no bets`, color: 'var(--muted)' };
    } else if (sv) {
      const extra = studied !== null ? ` (${studied} rds recorded)` : '';
      phase = { txt: `1 · COLLECTING DATA${extra} — validation unlocks at 400+ rounds`, color: '#f0ad4e' };
    } else {
      phase = { txt: '—', color: '' };
    }
    rpEl.textContent = phase.txt;
    rpEl.style.color = phase.color;
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

onEvent('siteSelect', 'change', refreshAccountSelect);

onEvent('switchBtn', 'click', () => {
  const siteId = el('siteSelect').value;
  const accountId = el('accountSelect').value || null;
  el('siteStatus').textContent = 'Switching…';
  socket.emit('switchSite', { siteId, accountId });
});

onEvent('newAccountBtn', 'click', async () => {
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

onEvent('loginConfirmBtn', 'click', () => {
  socket.emit('confirmLogin');
  el('loginConfirmBtn').classList.add('hidden');
  el('siteStatus').textContent = 'Continuing to the game…';
});

socket.on('siteStatus', (s) => {
  if (!s) return;
  const label = s.siteName || s.siteId || '';
  const account = s.accountLabel ? ` / "${s.accountLabel}"` : '';
  if (s.phase === 'loginRequired') {
    const fail = s.loginFailed
      ? '⚠ Login NOT detected on the page (wrong PIN? expired code?). '
      : '';
    el('siteStatus').textContent = `${fail}Log in to ${label}${account} in the browser window, then click continue.`;
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

onEvent('logRoundsBtn', 'click', () => { logType = 'rounds'; loadLogs(); });
onEvent('logTradesBtn', 'click', () => { logType = 'trades'; loadLogs(); });
onEvent('logRefreshBtn', 'click', loadLogs);

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
  // Explainable silence: session open but nothing observed yet
  const hint = el('sessionsHint');
  const quiet = list.filter((s) => !s.monitoring && s.phase !== 'loginRequired');
  if (quiet.length > 0) {
    hint.classList.remove('hidden');
    hint.textContent =
      'Observation is automatic — no extra steps needed. If Monitoring stays "—" for a while: ' +
      'make sure the Aviator game itself is visible in the bot\'s browser window (if the site ' +
      'shows a preview or PLAY button, press PLAY once). Numbers update after each completed ' +
      'round (~10–20 seconds each).';
  } else {
    hint.classList.add('hidden');
  }
  for (const s of list) {
    const tr = document.createElement('tr');
    const phaseCls = s.phase === 'monitoring' ? 'live' : (s.phase === 'loginRequired' ? 'paper' : '');
    const rate = Number.isFinite(s.roundsPerHour) && s.roundsPerHour > 0 ? s.roundsPerHour.toFixed(0) : '—';
    const stall = s.stalled ? ' <span class="neg" title="no new rounds for 5+ minutes — the monitor likely lost the game page">⚠ STALLED</span>' : '';
    const balance = s.balance !== null && s.balance !== undefined ? esc(s.balance) + ' ' + esc(s.currency || '') : '—';
    tr.innerHTML =
      `<td>${esc(s.siteName || s.siteId)}</td>` +
      `<td>${esc(s.accountLabel)}</td>` +
      `<td><span class="${phaseCls}">${esc(s.phase)}</span></td>` +
      `<td>${s.monitoring ? '✅' : '—'}${stall}</td>` +
      `<td>${esc(s.roundsSeen)}</td>` +
      `<td>${rate}</td>` +
      `<td>${balance}</td>`;
    const tdView = document.createElement('td');
    const viewBtn = document.createElement('button');
    viewBtn.textContent = '👁';
    viewBtn.title = 'Open the live view of this session in the dashboard';
    viewBtn.addEventListener('click', () => startMirrorView(s.accountId, s.accountLabel));
    tdView.appendChild(viewBtn);
    tr.appendChild(tdView);
    body.appendChild(tr);
  }
}

socket.on('sessions', renderSessions);
fetch('/api/sessions').then((r) => r.json()).then(renderSessions).catch(() => {});

// ---------------------------------------------------------------------------
// Profits & losses panel (paper simulation + live trades)
// ---------------------------------------------------------------------------
function pnlHtml(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const color = v > 0 ? '#38c172' : v < 0 ? '#e05561' : 'inherit';
  return `<span style="color:${color};font-weight:600;">${v > 0 ? '+' : ''}${fmt(v)}</span>`;
}

function sparkline(curve, capital, w = 640, h = 90) {
  if (!Array.isArray(curve) || curve.length < 2) {
    return '<p class="small">The balance curve appears after the first rounds.</p>';
  }
  const min = Math.min(...curve);
  const max = Math.max(...curve);
  const span = (max - min) || 1;
  const y = (v) => (h - 5 - ((v - min) / span) * (h - 10)).toFixed(1);
  const pts = curve.map((v, i) => `${((i / (curve.length - 1)) * w).toFixed(1)},${y(v)}`).join(' ');
  const rising = curve[curve.length - 1] >= capital;
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;" preserveAspectRatio="none">` +
    `<line x1="0" y1="${y(capital)}" x2="${w}" y2="${y(capital)}" stroke="#5a6b7f" stroke-dasharray="4 4" stroke-width="1"/>` +
    `<polyline points="${pts}" fill="none" stroke="${rising ? '#38c172' : '#e05561'}" stroke-width="1.8"/></svg>`;
}

function statCards(st) {
  const rows = [
    ['Capital', fmt(st.capital, 0)],
    ['Balance', fmt(st.balance, 0)],
    ['Net P/L', pnlHtml(st.pnl)],
    ['Wins / Losses', st.bets > 0 ? `<span style="color:#38c172">${st.wins}</span> / <span style="color:#e05561">${st.losses}</span>` : '—'],
    ['Win rate', st.winRate === null || st.winRate === undefined ? '—' : `${fmt(st.winRate, 1)}%`],
    ['Bets', `${st.bets}${st.skipped ? ` (+${st.skipped} skipped)` : ''}`],
    ['Max drawdown', fmt(st.maxDrawdown, 0)]
  ];
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px;margin:8px 0;">` +
    rows.map(([k, v]) =>
      `<div style="background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:6px 8px;">` +
      `<div class="small" style="color:var(--muted);">${k}</div>` +
      `<div style="font-weight:600;">${v}</div></div>`).join('') +
    '</div>';
}

function renderProfits(data) {
  const badge = el('profitsModeBadge');
  const wrap = el('profitsSites');
  const note = el('profitsNote');
  if (!badge || !wrap) return;
  if (!data || !Array.isArray(data.sites) || data.sites.length === 0) {
    badge.textContent = '—';
    if (note) note.textContent = '';
    wrap.innerHTML = '<p class="small">Launch a session and the profit/loss simulation starts here automatically.</p>';
    return;
  }
  badge.textContent = data.paperMode ? 'PAPER SIMULATION' : 'LIVE';
  badge.style.color = data.paperMode ? '#4ea1ff' : '#e05561';
  if (note) note.textContent = data.paperMode
    ? 'Paper mode: EVERY round is simulated as if the bet really happened, using the selected strategy\'s stake and its assumed capital (100× initial bet, or PAPER_BANKROLL). The dashed line is the starting capital. Nothing real is wagered.'
    : 'Live mode: the figures below are REAL trades placed by the bot. The paper baseline stays frozen as your counterfactual.';
  let html = '';
  for (const s of data.sites) {
    html += `<div class="card" style="margin-bottom:10px;"><h3>${esc(s.site)}</h3>`;
    if (data.paperMode && s.baseline) {
      html += `<h4 style="margin:4px 0 0;color:var(--muted);">🎲 BLIND BASELINE — bets every round, no thinking (the counterfactual)</h4>`;
      html += statCards(s.baseline);
      html += sparkline(s.baseline.curve, s.baseline.capital);
      const e = s.engine;
      html += `<h4 style="margin:10px 0 0;color:var(--muted);">🧠 ENGINE — only bets when its gates approve</h4>`;
      if (e && e.bets > 0) {
        html += statCards(e);
        // The aim, made measurable: loss per bet vs blind betting.
        const blindPerBet = s.baseline.pnl / s.baseline.bets;
        const engPerBet = e.pnl / e.bets;
        const edge = engPerBet - blindPerBet;
        html += `<p class="small">🎯 <b>The aim:</b> lose less than blind betting (or win). Blind loses ${fmt(blindPerBet)} per bet; engine is at ${fmt(engPerBet)} per bet → discipline is <b style="color:${edge > 0 ? '#38c172' : '#e05561'}">${edge > 0 ? 'beating' : 'behind'} blind by ${fmt(Math.abs(edge))}/bet</b>.</p>`;
      } else {
        html += `<p class="small">No gated bets yet — the engine only bets after warm-up, when its confidence + regime gates approve.</p>`;
      }
      html += `<p class="small" style="color:var(--muted);">The red baseline line is EXPECTED to fall: flat betting at ${fmt(s.baseline.stake, 0)} @ ${s.baseline.target}x loses ~3% per bet to the house edge — that is the math of the game, not a bot failure. It exists so you can see exactly what discipline saves.</p>`;
    } else if (s.live && s.live.bets > 0) {
      html += statCards(s.live);
      html += sparkline(s.live.curve, s.live.capital);
    } else {
      html += '<p class="small">No live trades recorded for this site yet.</p>';
    }
    html += '</div>';
  }
  wrap.innerHTML = html;
}

socket.on('profits', renderProfits);
fetch('/api/profits').then((r) => r.json()).then(renderProfits).catch(() => {});
onEvent('profitsResetBtn', 'click', () => {
  socket.emit('resetPaperLedgers', {});
});

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
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open alongside';
      openBtn.style.marginLeft = '6px';
      openBtn.title = 'Open this account in parallel with the current session (cap: MAX_SESSIONS)';
      openBtn.addEventListener('click', () => {
        el('siteStatus').textContent = `Opening "${a.label}" alongside…`;
        socket.emit('openSession', { siteId: a.site, accountId: a.id });
      });
      td.appendChild(btn);
      td.appendChild(openBtn);
      tr.appendChild(td);
      body.appendChild(tr);
    }
  } catch (e) { /* server not ready */ }
}

loadAccountsPanel();
setInterval(loadAccountsPanel, 15000);
onEvent('openAllBtn', 'click', () => {
  el('siteStatus').textContent = 'Opening all saved profiles in parallel…';
  socket.emit('openAllSessions');
});

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

// ---------------------------------------------------------------------------
// Mission control: strategy list, launch-from-UI, pause/resume betting
// ---------------------------------------------------------------------------
async function loadStrategies() {
  try {
    const res = await fetch('/api/strategies');
    const strategies = await res.json();
    const sel = el('strategySelect');
    sel.innerHTML = '';
    for (const s of strategies) {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = `${s.name} — stake ${s.initialBet}, min ${s.minBet}, max ${s.maxBet}, target ${s.targetMultiplier}x`;
      sel.appendChild(opt);
    }
    if (!sel.value || !sel.querySelector(`option[value="${sel.value}"]`)) sel.value = 'MICRO';
  } catch (e) { /* server not ready */ }
}

function applyControlState(cs) {
  if (!cs) return;
  const launchBtn = el('launchBtn');
  const switchBtn = el('switchBtn');
  const strategySelect = el('strategySelect');
  const status = el('controlStatus');
  strategySelect.disabled = false; // strategy is switchable at any time via Apply
  if (cs.awaitingLaunch) {
    launchBtn.classList.remove('hidden');
    switchBtn.classList.add('hidden');
    status.textContent = 'Bot is waiting — pick site, account and strategy, then LAUNCH.';
  } else {
    launchBtn.classList.add('hidden');
    switchBtn.classList.remove('hidden');
    status.textContent = cs.strategy ? `Running — strategy ${cs.strategy} (${cs.mode || 'paper'})` : 'Running';
  }
  // Keep the selector in sync with the strategy actually in use
  if (cs.strategy && strategySelect.querySelector(`option[value="${cs.strategy}"]`)) {
    strategySelect.value = cs.strategy;
  }
  const pauseBtn = el('pauseBtn');
  const resumeBtn = el('resumeBtn');
  const pauseChip = el('pauseChip');
  if (cs.strategy) {
    pauseChip.classList.toggle('paused', cs.paused);
    pauseChip.classList.toggle('hidden', !cs.paused);
    pauseBtn.classList.toggle('hidden', cs.paused);
    resumeBtn.classList.toggle('hidden', !cs.paused);
  } else {
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.add('hidden');
    pauseChip.classList.add('hidden');
  }
  const modeBadge = el('modeBadge');
  if (cs.mode === 'live') { modeBadge.textContent = 'LIVE MODE'; modeBadge.className = 'live'; }
  else { modeBadge.textContent = 'OBSERVE MODE (paper)'; modeBadge.className = 'paper'; }
  // Explicit Start/Stop live-betting buttons
  const startLive = el('startLiveBtn');
  const stopLive = el('stopLiveBtn');
  if (startLive && stopLive) {
    const live = cs.mode === 'live';
    startLive.classList.toggle('hidden', cs.awaitingLaunch || (live && !cs.paused));
    stopLive.classList.toggle('hidden', cs.awaitingLaunch || !live || cs.paused);
  }
  applyModeToggle(cs);
}

socket.on('controlState', applyControlState);

onEvent('launchBtn', 'click', () => {
  socket.emit('startSession', {
    siteId: el('siteSelect').value,
    accountId: el('accountSelect').value || null,
    strategy: el('strategySelect').value
  });
  el('controlStatus').textContent = 'Launching… log in when the browser window opens.';
  el('launchBtn').disabled = true;
  setTimeout(() => { el('launchBtn').disabled = false; }, 3000);
});

onEvent('pauseBtn', 'click', () => socket.emit('pauseBetting'));
onEvent('resumeBtn', 'click', () => socket.emit('resumeBetting'));
onEvent('renavigateBtn', 'click', () => {
  socket.emit('renavigate', { accountId: el('accountSelect').value || null });
  el('controlStatus').textContent = 'Navigating to the Aviator page…';
});

onEvent('debugGameBtn', 'click', async () => {
  const btn = el('debugGameBtn');
  btn.disabled = true;
  btn.textContent = '🩺 Diagnosing…';
  try {
    const res = await fetch(`/api/debug/game?accountId=${encodeURIComponent(el('accountSelect').value || '')}`);
    const data = await res.json();
    const pre = el('debugOut');
    pre.textContent = JSON.stringify(data, null, 2);
    pre.classList.remove('hidden');
    pre.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    el('debugOut').textContent = `Diagnose failed: ${e.message}`;
    el('debugOut').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '🩺 Diagnose game frame';
  }
});

onEvent('provablyFairBtn', 'click', async () => {
  const btn = el('provablyFairBtn');
  btn.disabled = true;
  btn.textContent = '🔍 Scanning…';
  try {
    const res = await fetch(`/api/debug/provablyfair?accountId=${encodeURIComponent(el('accountSelect').value || '')}`);
    const data = await res.json();
    const pre = el('debugOut');
    let header = 'PROVABLY-FAIR SCAN\n\n';
    if (data.error) {
      header += `Error: ${data.error}\n`;
    } else {
      header += `Site: ${data.site} | frames scanned: ${data.framesScanned} | frames with fair-data: ${data.found.length}\n`;
      header += `Records stored: ${data.analysis.records} | distinct 64-hex values: ${data.analysis.distinctHex64}\n`;
      if (data.analysis.nonceRange) header += `Nonce range seen: ${data.analysis.nonceRange.min} – ${data.analysis.nonceRange.max}\n`;
      if (data.analysis.anomalies.length) header += `\n⚠ ANOMALIES:\n${data.analysis.anomalies.map((a) => '  • ' + a).join('\n')}\n`;
      if (data.found.length === 0) {
        header += '\nNothing found yet. In the game window, open the shield / "Provably Fair" panel (it shows the server-seed hash, client seed and nonce), then click Scan again. Each scan is stored, so evidence accumulates.';
      }
    }
    pre.textContent = header + '\n\n' + JSON.stringify(data, null, 2);
    pre.classList.remove('hidden');
    pre.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    el('debugOut').textContent = `Provably-fair scan failed: ${e.message}`;
    el('debugOut').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Scan provably-fair data';
  }
});

onEvent('strategyApplyBtn', 'click', async () => {
  const name = el('strategySelect').value;
  const status = el('controlStatus');
  try {
    const res = await fetch(`/api/strategies/${encodeURIComponent(name)}`, { method: 'PUT' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    status.textContent = `Strategy set to ${body.name} ✓`;
  } catch (e) {
    status.textContent = `Strategy change failed: ${e.message}`;
  }
});

// Observe-only <-> live betting toggle (hard confirmation for LIVE)
let currentMode = 'paper';
function requestModeToggle() {
  if (currentMode === 'paper') {
    const sure = confirm(
      'Switch to LIVE betting?\n\n' +
      'The bot will place REAL bets with REAL funds (loss limits still enforced).\n' +
      'Make sure you trust what you saw in observe mode first.'
    );
    if (!sure) return;
    socket.emit('setMode', { mode: 'live' });
  } else {
    socket.emit('setMode', { mode: 'paper' });
  }
}
onEvent('modeToggleBtn', 'click', requestModeToggle);
onEvent('modeToggleBtnStatus', 'click', requestModeToggle);

onEvent('startLiveBtn', 'click', () => {
  const sure = confirm(
    'Start LIVE betting?\n\n' +
    'REAL bets with REAL funds. The warm-up gate, session/daily loss caps and stake caps stay enforced.'
  );
  if (!sure) return;
  socket.emit('resumeBetting');
  socket.emit('setMode', { mode: 'live' });
  el('controlStatus').textContent = 'LIVE betting started — loss limits remain enforced.';
});
onEvent('stopLiveBtn', 'click', () => {
  socket.emit('pauseBetting');
  socket.emit('setMode', { mode: 'paper' });
  el('controlStatus').textContent = 'Betting stopped — back to observe-only (paper) mode.';
});

function applyModeToggle(cs) {
  currentMode = cs.mode || 'paper';
  const btns = [el('modeToggleBtn'), el('modeToggleBtnStatus')];
  for (const btn of btns) {
    // Available as soon as a session is running — strategy is irrelevant here.
    btn.classList.toggle('hidden', !!cs.awaitingLaunch);
    if (currentMode === 'paper') {
      btn.textContent = '🔴 Switch to LIVE betting';
      btn.className = btn.id === 'modeToggleBtnStatus' ? 'danger' : 'danger';
    } else {
      btn.textContent = '🟢 Switch back to observe-only';
      btn.className = 'primary';
    }
    if (cs.awaitingLaunch) btn.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Live game view: mirrored screenshots of the session + click-through
// ---------------------------------------------------------------------------
let mirrorAccount = null;

function startMirrorView(accountId, label) {
  mirrorAccount = accountId;
  socket.emit('mirrorStart', { accountId });
  el('mirrorPanel').classList.remove('hidden');
  el('mirrorImg').style.display = 'block';
  el('mirrorNote').textContent = `Streaming "${label}"… (updates ~1/s; clicks are forwarded while the box is ticked)`;
  el('mirrorPanel').scrollIntoView({ behavior: 'smooth' });
}

function stopMirrorView() {
  if (mirrorAccount) socket.emit('mirrorStop', { accountId: mirrorAccount });
  mirrorAccount = null;
  el('mirrorPanel').classList.add('hidden');
  el('mirrorImg').style.display = 'none';
  el('mirrorImg').src = '';
}

onEvent('mirrorStopBtn', 'click', stopMirrorView);

socket.on('mirrorFrame', (f) => {
  if (!f || f.accountId !== mirrorAccount) return;
  const img = el('mirrorImg');
  img.dataset.w = f.w;
  img.dataset.h = f.h;
  img.src = 'data:image/jpeg;base64,' + f.img;
});

onEvent('mirrorImg', 'click', (ev) => {
  if (!mirrorAccount || !el('mirrorClickChk').checked) return;
  const img = ev.currentTarget;
  const rect = img.getBoundingClientRect();
  const w = parseFloat(img.dataset.w || '0');
  const h = parseFloat(img.dataset.h || '0');
  if (!w || !h || !rect.width || !rect.height) return;
  const x = ((ev.clientX - rect.left) / rect.width) * w;
  const y = ((ev.clientY - rect.top) / rect.height) * h;
  socket.emit('mirrorClick', { accountId: mirrorAccount, x, y });
});

// ---------------------------------------------------------------------------
// Sites manager: list registered sites, add user sites, remove them
// ---------------------------------------------------------------------------
async function loadSitesPanel() {
  try {
    const res = await fetch('/api/sites');
    const data = await res.json();
    const body = el('sitesTableBody');
    body.innerHTML = '';
    for (const s of data.sites) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${esc(s.id)}</td>` +
        `<td>${esc(s.name)}</td>` +
        `<td>${esc(s.currency)}</td>` +
        `<td class="small">${s.gameUrl ? esc(s.gameUrl) : 'manual navigation'}</td>` +
        `<td>${esc(s.minStake)}</td>` +
        `<td>${s.userDefined ? '<span class="warn">user</span>' : '<span class="small">built-in</span>'}</td>`;
      const td = document.createElement('td');
      if (s.userDefined) {
        const btn = document.createElement('button');
        btn.textContent = '🗑';
        btn.title = 'Remove this site';
        btn.addEventListener('click', async () => {
          if (!confirm(`Remove site "${s.name}" (${s.id})?`)) return;
          await fetch(`/api/sites/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
          loadSitesPanel();
          loadSiteControls();
        });
        td.appendChild(btn);
      }
      tr.appendChild(td);
      body.appendChild(tr);
    }
  } catch (e) { /* server not ready */ }
}

onEvent('addSiteBtn', 'click', async () => {
  const status = el('addSiteStatus');
  const payload = {
    name: el('nsName').value.trim(),
    baseUrl: el('nsBaseUrl').value.trim(),
    gameUrl: el('nsGameUrl').value.trim(),
    loginUrl: el('nsLoginUrl').value.trim(),
    currency: el('nsCurrency').value.trim(),
    minStake: el('nsMinStake').value.trim(),
    notes: el('nsNotes').value.trim()
  };
  if (!payload.name || !payload.baseUrl) {
    status.textContent = 'Name and Base URL are required.';
    return;
  }
  try {
    const res = await fetch('/api/sites/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const out = await res.json();
    if (!res.ok) {
      status.textContent = `⚠ ${out.error || 'could not add site'}`;
      return;
    }
    status.textContent = `✅ Added "${out.name}" (${out.id}) — it is now in the site selector.`;
    ['nsName', 'nsBaseUrl', 'nsGameUrl', 'nsLoginUrl', 'nsCurrency', 'nsMinStake', 'nsNotes']
      .forEach((id) => { el(id).value = ''; });
    loadSitesPanel();
    loadSiteControls();
  } catch (e) {
    status.textContent = `⚠ ${e.message}`;
  }
});

loadSitesPanel();

loadStrategies();

loadSiteControls();
loadLogs();
setInterval(loadLogs, 15000);
