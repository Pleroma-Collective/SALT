/* CE Dynamic Event rate monitor — /dashboard/dynamic-event-rates */
'use strict';

let currentServerId = null;
let selectedDays = 30;
let trendChart = null;
let lastData = null;

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value ?? '—';
}

function showBanner(message, type = 'error') {
  const el = byId('statusBanner');
  el.className = `mb-4 rounded-lg border p-4 text-sm ${type === 'error' ? 'border-red-700 bg-red-950 text-red-200' : 'border-yellow-700 bg-yellow-950 text-yellow-200'}`;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideBanner() {
  const el = byId('statusBanner');
  el.textContent = '';
  el.classList.add('hidden');
}

async function loadServers() {
  const select = byId('serverSelect');
  try {
    const response = await fetch('/api/nitrado/registered-servers');
    const data = await response.json();
    select.innerHTML = '<option value="">-- Select a server --</option>';
    for (const server of data.servers || []) {
      const option = document.createElement('option');
      option.value = server.id;
      option.textContent = server.server_name || server.name || `Server ${server.id}`;
      select.appendChild(option);
    }
    if ((data.servers || []).length === 1) {
      select.value = String(data.servers[0].id);
      select.dispatchEvent(new Event('change'));
    }
  } catch (error) {
    console.error('Error loading servers:', error);
    showBanner('Failed to load servers');
  }
}

byId('serverSelect').addEventListener('change', async event => {
  currentServerId = event.target.value;
  if (!currentServerId) {
    byId('emptyState').classList.remove('hidden');
    byId('ratesContent').classList.add('hidden');
    return;
  }
  await loadRates();
});

document.querySelectorAll('.range-btn').forEach(button => {
  button.addEventListener('click', async () => {
    selectedDays = Number(button.dataset.days);
    document.querySelectorAll('.range-btn').forEach(b => {
      b.classList.toggle('bg-blue-600', b === button);
      b.classList.toggle('text-white', b === button);
      b.setAttribute('aria-pressed', b === button ? 'true' : 'false');
    });
    if (currentServerId) await loadRates();
  });
});

byId('refreshButton').addEventListener('click', () => {
  if (currentServerId) loadRates();
});

async function loadRates() {
  byId('refreshButton').disabled = true;
  hideBanner();
  try {
    const response = await fetch(`/api/dynamic-event-rates/${encodeURIComponent(currentServerId)}?days=${selectedDays}`);
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    lastData = data;
    render(data);
    byId('emptyState').classList.add('hidden');
    byId('ratesContent').classList.remove('hidden');
  } catch (error) {
    console.error('Error loading dynamic event rates:', error);
    showBanner(error.message === 'Resource not found'
      ? 'Access denied for this server (admin role required), or it no longer exists.'
      : `Failed to load rates: ${error.message}`);
    byId('emptyState').classList.remove('hidden');
    byId('ratesContent').classList.add('hidden');
  } finally {
    byId('refreshButton').disabled = false;
  }
}

function render(data) {
  setText('totalSpawns', data.total);
  setText('avgPerDay', data.avgPerDay);
  setText('activeDays', `${data.activeDays} / ${data.windowDays}`);
  setText('typeCount', data.perType.length);
  setText('windowLabel', `Last ${data.windowDays} UTC days · updated ${new Date(data.generatedAt).toLocaleString()}`);

  const body = byId('perTypeBody');
  body.innerHTML = '';
  if (data.perType.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="5" class="px-4 py-6 text-center text-gray-400">No dynamic events in this window. Logs start contributing after the next log scan of a CE server.</td>';
    body.appendChild(row);
  }
  for (const t of data.perType) {
    const row = document.createElement('tr');
    row.className = 'border-b border-gray-700/60 last:border-b-0';
    // innerHTML is safe here: every interpolated value is escapeHtml()'d (strings) or a Number.
    row.innerHTML = `
      <td class="px-4 py-3 font-medium">${escapeHtml(t.humanName)}</td>
      <td class="px-4 py-3 text-right tabular-nums">${t.count}</td>
      <td class="px-4 py-3 text-right tabular-nums">${t.perDay}</td>
      <td class="px-4 py-3 text-xs text-gray-400">${escapeHtml(t.deType)}</td>
      <td class="px-4 py-3 text-xs text-gray-400">${t.lastSeen ? new Date(t.lastSeen).toLocaleString() : '—'}</td>`;
    body.appendChild(row);
  }

  renderTrendChart(data);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TYPE_COLORS = [
  '#60a5fa', '#f87171', '#4ade80', '#fbbf24', '#c084fc', '#22d3ee',
  '#fb923c', '#a3e635', '#f472b6', '#34d399', '#818cf8', '#e879f9',
  '#facc15', '#2dd4bf', '#fca5a5', '#93c5fd', '#bef264', '#d8b4fe', '#fdba74',
];

function renderTrendChart(data) {
  const labels = data.daily.map(d => d.day.slice(5));
  const datasets = data.perType.map((t, i) => ({
    label: t.humanName,
    data: data.daily.map(d => d.byType[t.deType] || 0),
    borderColor: TYPE_COLORS[i % TYPE_COLORS.length],
    backgroundColor: 'transparent',
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.25,
  }));
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(byId('trendChart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#9ca3af', boxWidth: 12 } },
        tooltip: { enabled: true },
      },
      scales: {
        x: { ticks: { color: '#9ca3af', maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,0.07)' } },
        y: { beginAtZero: true, ticks: { color: '#9ca3af', precision: 0 }, grid: { color: 'rgba(255,255,255,0.07)' } },
      },
    },
  });
}

loadServers();
