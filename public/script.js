/* Dashboard client: renders crash history + prediction accuracy from the
 * events broadcast by server.js over socket.io. */

const socket = io();

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
        time: {
          unit: 'second',
          displayFormats: { second: 'HH:mm:ss' }
        },
        grid: { display: false },
        ticks: {
          color: 'rgba(75, 192, 192, 1)',
          callback: function (value) {
            const currentTime = new Date().getTime();
            const valueTime = new Date(value).getTime();
            const diffInSeconds = Math.round((currentTime - valueTime) / 1000);

            if (diffInSeconds < 60) {
              return diffInSeconds + ' secs ago';
            } else if (diffInSeconds < 3600) {
              return Math.floor(diffInSeconds / 60) + ' min ago';
            } else {
              return Math.floor(diffInSeconds / 3600) + ' hours ago';
            }
          }
        }
      },
      y: {
        grid: { color: 'rgba(75, 192, 192, 0.1)' },
        ticks: { color: 'rgba(75, 192, 192, 1)' }
      }
    },
    plugins: {
      legend: {
        labels: { color: 'rgba(75, 192, 192, 1)' }
      }
    }
  }
});

function updatePredictionTable(predictions) {
  const tableBody = document.getElementById('predictionTableBody');
  tableBody.innerHTML = '';

  predictions.forEach((prediction, index) => {
    const row = document.createElement('tr');

    const indexCell = document.createElement('td');
    indexCell.textContent = index + 1;
    row.appendChild(indexCell);

    const predictedCell = document.createElement('td');
    predictedCell.textContent = prediction.predicted.toFixed(2);
    row.appendChild(predictedCell);

    const actualCell = document.createElement('td');
    actualCell.textContent = prediction.actual.toFixed(2);
    row.appendChild(actualCell);

    const correctCell = document.createElement('td');
    correctCell.textContent = prediction.correct ? 'Yes' : 'No';
    row.appendChild(correctCell);

    tableBody.appendChild(row);
  });
}

let lastValue = null;
let currentPrediction = null;
let correctPredictions = 0;
let totalPredictions = 0;
const latestPredictions = [];
const MAX_POINTS = 500; // cap chart memory on long runs

socket.on('newData', (dataPoint) => {
  if (!dataPoint || typeof dataPoint.value !== 'number') return;
  const { value, created_at } = dataPoint;

  // Ignore duplicate emissions of the same round
  if (lastValue !== null && lastValue === value) {
    return;
  }

  chartData.labels.push(created_at);
  chartData.datasets[0].data.push(value);
  if (chartData.labels.length > MAX_POINTS) {
    chartData.labels.shift();
    chartData.datasets[0].data.shift();
  }

  if (currentPrediction !== null) {
    const predictedValueElement = document.getElementById('predictedValue');
    predictedValueElement.textContent =
      'Predicted Value: ' + (Number.isFinite(currentPrediction) ? currentPrediction.toFixed(2) : 'N/A');

    const actualValue = value;
    const isCorrect = currentPrediction <= actualValue;
    correctPredictions += isCorrect ? 1 : 0;
    totalPredictions += 1;

    latestPredictions.push({
      predicted: currentPrediction,
      actual: actualValue,
      correct: isCorrect
    });
    if (latestPredictions.length > 10) {
      latestPredictions.shift();
    }
    updatePredictionTable(latestPredictions);

    const accuracyRate = (correctPredictions / totalPredictions) * 100;
    const accuracyElement = document.getElementById('accuracyRate');
    accuracyElement.textContent = 'Accuracy rate: ' + accuracyRate.toFixed(2) + '%';
  }

  // The server sends the prediction made for the NEXT round.
  currentPrediction = Number.isFinite(dataPoint.predictedValue) ? dataPoint.predictedValue : null;
  lineChart.update();
  lastValue = value;
});

socket.on('tradingStopped', () => {
  const status = document.getElementById('botStatus');
  status.textContent = 'Status: betting halted by risk limits (monitoring continues)';
  status.style.color = '#ff8080';
});
