/* Dashboard client: renders crash history, model state and trade stats from
 * the events broadcast by server.js over socket.io. */

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
// Live bot / model state (driven by 'status' events)
// ---------------------------------------------------------------------------
socket.on('status', (s) => {
  if (!s) return;

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
  setText('roundCount', String(s.roundId ?? 0));

  const m = s.model;
  if (m) {
    const regime = m.regime || '—';
    setText('regime', regime, regime === 'cold' ? 'neg' : regime === 'hot' ? 'pos' : '');
    setText('modelProb', fmt(m.probability), m.probability !== null && m.probability >= m.entryProbability ? 'pos' : 'warn');
    setText('entryThreshold', fmt(m.entryProbability));
    setText('roundsStudied', String(m.roundsStudied ?? 0));
  }
});

socket.on('tradingStopped', () => {
  setText('botState', 'HALTED', 'neg');
});

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

  if (lastValue !== null && lastValue === value) return; // duplicate emission

  chartData.labels.push(created_at);
  chartData.datasets[0].data.push(value);
  if (chartData.labels.length > MAX_POINTS) {
    chartData.labels.shift();
    chartData.datasets[0].data.shift();
  }

  if (currentPrediction !== null) {
    document.getElementById('predictedValue').textContent =
      'Predicted Value: ' + (Number.isFinite(currentPrediction) ? currentPrediction.toFixed(2) : 'N/A');

    const isCorrect = currentPrediction <= value;
    correctPredictions += isCorrect ? 1 : 0;
    totalPredictions += 1;

    latestPredictions.push({ predicted: currentPrediction, actual: value, correct: isCorrect });
    if (latestPredictions.length > 10) latestPredictions.shift();
    updatePredictionTable(latestPredictions);

    const accuracyRate = (correctPredictions / totalPredictions) * 100;
    document.getElementById('accuracyRate').textContent = 'Accuracy rate: ' + accuracyRate.toFixed(2) + '%';
  }

  // The server sends the prediction made for the NEXT round.
  currentPrediction = Number.isFinite(dataPoint.predictedValue) ? dataPoint.predictedValue : null;
  lineChart.update();
  lastValue = value;
});
