'use strict';

/* Deaths & PVP dashboard page — death-cause distribution + PVP leaderboard.
 * Data comes from 'player.death_cause' events (ADM log scanner). */

const RANGE_DAYS = 7;
let currentServerId = null;
let selectedDays = 7;
let causeChart = null;
let loadGeneration = 0;

const CAUSE_ORDER = ['pvp', 'infected', 'vehicle', 'fall', 'suicide', 'bleed', 'drowned', 'other'];
const CAUSE_META = {
  pvp:      { label: 'PVP', color: '#ef4444' },
  infected: { label: 'Infected', color: '#22c55e' },
  vehicle:  { label: 'Vehicle', color: '#f97316' },
  fall:     { label: 'Fall damage', color: '#38bdf8' },
  suicide:  { label: 'Suicide', color: '#a855f7' },
  bleed:    { label: 'Bled out', color: '#fb7185' },
  drowned:  { label: 'Drowned', color: '#3b82f6' },
  other:    { label: 'Other', color: '#9ca3af' },
};

function causeBucket(cause) {
  return CAUSE_META[cause] ? cause : 'other';
}

function byId(id) {
  return document.getElementById(id);
}

function showBanner(message) {
  const element = byId('statusBanner');
  element.className = 'mb-4 rounded-lg border p-4 text-sm border-red-700 bg-red-950 text-red-200';
  element.textContent = message;
  element.classList.remove('hidden');
}

function hideBanner() {
  byId('statusBanner').classList.add('hidden');
}

async function loadServers() {
  const select = byId('serverSelect');
  try {
    const response = await fetch('/api/nitrado/registered-servers');
    const data = await response.json();
    if (!response.ok || !data.success || !Array.isArray(data.servers)) throw new Error(data.error || 'Failed to load servers');
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = data.servers.length ? '— Pick a server —' : 'No servers found';
    select.appendChild(placeholder);
    data.servers.forEach(server => {
      const option = document.createElement('option');
      option.value = String(server.id);
      option.textContent = `${server.server_name} (${server.platform})`;
      select.appendChild(option);
    });
    select.disabled = data.servers.length === 0;
    select.addEventListener('change', onServerChange);
  } catch (error) {
    select.replaceChildren();
    const option = document.createElement('option');
    option.textContent = 'Error loading servers';
    select.appendChild(option);
    showBanner(error.message);
  }
}

function onServerChange(event) {
  currentServerId = event.target.value || null;
  loadAll();
}

function setRange(days) {
  selectedDays = days;
  document.querySelectorAll('.range-btn').forEach(button => {
    const active = Number(button.dataset.days) === days;
    button.setAttribute('aria-pressed', String(active));
    button.className = active
      ? 'range-btn rounded bg-blue-600 px-3 py-2 text-sm font-semibold'
      : 'range-btn rounded bg-gray-700 px-3 py-2 text-sm hover:bg-gray-600';
  });
  loadAll();
}

async function loadAll() {
  const generation = ++loadGeneration;
  if (!currentServerId) {
    byId('emptyState').classList.remove('hidden');
    byId('content').classList.add('hidden');
    return;
  }
  byId('emptyState').classList.add('hidden');
  byId('content').classList.remove('hidden');
  hideBanner();
  const loadingRow = document.createElement('tr');
  const loadingCell = document.createElement('td');
  loadingCell.colSpan = 5;
  loadingCell.className = 'px-4 py-6 text-center text-gray-400';
  loadingCell.textContent = 'Loading…';
  loadingRow.appendChild(loadingCell);
  byId('leaderboardBody').replaceChildren(loadingRow);
  const topWeaponsLoading = document.createElement('p');
  topWeaponsLoading.className = 'text-sm text-gray-400';
  topWeaponsLoading.textContent = 'Loading…';
  byId('topWeapons').replaceChildren(topWeaponsLoading);

  try {
    const [causesResponse, boardResponse] = await Promise.all([
      fetch(`/api/stats/${encodeURIComponent(currentServerId)}/death-causes?days=${selectedDays}&bucket=${selectedDays <= 1 ? 'hour' : 'day'}`),
      fetch(`/api/stats/${encodeURIComponent(currentServerId)}/pvp-leaderboard?days=${selectedDays}`),
    ]);
    if (generation !== loadGeneration) return;
    const causes = await causesResponse.json();
    const board = await boardResponse.json();
    if (!causesResponse.ok) throw new Error(causes.error || 'Failed to load death causes');
    renderCauses(causes);
    renderLeaderboard(board);
    if (!boardResponse.ok) showBanner(board.error || 'Failed to load PVP leaderboard');
  } catch (error) {
    if (generation !== loadGeneration) return;
    showBanner(error.message);
  }
}

function renderCauses(data) {
  const buckets = [];
  const seenBuckets = new Set();
  for (const row of data.series || []) {
    if (!seenBuckets.has(row.bucket)) {
      seenBuckets.add(row.bucket);
      buckets.push(row.bucket);
    }
  }
  buckets.sort();
  const counts = new Map(); // bucket -> {bucketKey: n}
  for (const row of data.series || []) {
    const entry = counts.get(row.bucket) || {};
    entry[causeBucket(row.cause)] = (entry[causeBucket(row.cause)] || 0) + row.n;
    counts.set(row.bucket, entry);
  }

  const totals = {};
  for (const row of data.series || []) totals[causeBucket(row.cause)] = (totals[causeBucket(row.cause)] || 0) + row.n;

  const chips = byId('causeChips');
  chips.replaceChildren();
  CAUSE_ORDER.forEach(cause => {
    const count = totals[cause] || 0;
    if (count === 0) return;
    const chip = document.createElement('span');
    chip.className = 'inline-flex items-center gap-2 rounded-full border border-gray-600 bg-gray-700 px-3 py-1 text-xs font-semibold';
    const dot = document.createElement('span');
    dot.className = 'h-2.5 w-2.5 rounded-full';
    dot.style.backgroundColor = CAUSE_META[cause].color;
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(`${CAUSE_META[cause].label} ${count}`));
    chips.appendChild(chip);
  });

  byId('causeSummary').textContent = `${data.total || 0} death(s) in the last ${data.days} day(s)`;

  if (causeChart) {
    causeChart.destroy();
    causeChart = null;
  }
  if (buckets.length === 0) {
    if ((data.total || 0) === 0) {
      byId('causeSummary').textContent = `No deaths recorded in the last ${data.days} day(s)`;
    }
    return;
  }
  const labels = buckets.map(b => (data.bucket === 'hour' ? b.slice(5, 16) : b));
  const datasets = CAUSE_ORDER
    .filter(cause => totals[cause])
    .map(cause => ({
      label: CAUSE_META[cause].label,
      data: buckets.map(b => (counts.get(b) || {})[cause] || 0),
      backgroundColor: CAUSE_META[cause].color,
      stack: 'deaths',
    }));

  causeChart = new Chart(byId('causeChart'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#9ca3af' } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0, color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.07)' } },
      },
      plugins: { legend: { labels: { color: '#e5e7eb' } } },
    },
  });
}

function renderLeaderboard(data) {
  const body = byId('leaderboardBody');
  body.replaceChildren();
  if (!data.leaderboard || data.leaderboard.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'px-4 py-6 text-center text-gray-400';
    cell.textContent = `No PVP kills in the last ${data.days || 30} day(s).`;
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    data.leaderboard.forEach((entry, index) => {
      const row = document.createElement('tr');
      row.className = 'border-b border-gray-700/60 last:border-0';
      const cells = [
        { text: String(index + 1), cls: 'px-4 py-3 text-gray-400 tabular-nums' },
        { text: entry.killer || 'Unknown', cls: 'px-4 py-3 font-semibold' },
        { text: String(entry.kills), cls: 'px-4 py-3 text-right tabular-nums' },
        { text: entry.topWeapon || '—', cls: 'px-4 py-3 text-gray-300' },
        { text: entry.avgDistance != null ? `${entry.avgDistance} m` : '—', cls: 'px-4 py-3 text-right tabular-nums text-gray-300' },
      ];
      cells.forEach(cellDef => {
        const td = document.createElement('td');
        td.className = cellDef.cls;
        td.textContent = cellDef.text;
        row.appendChild(td);
      });
      body.appendChild(row);
    });
  }

  const weapons = byId('topWeapons');
  weapons.replaceChildren();
  if (!data.topWeapons || data.topWeapons.length === 0) {
    const note = document.createElement('p');
    note.className = 'text-sm text-gray-400';
    note.textContent = 'No weapon data in this range.';
    weapons.appendChild(note);
    return;
  }
  const max = data.topWeapons[0].kills;
  data.topWeapons.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 py-1 text-sm';
    const label = document.createElement('span');
    label.className = 'w-32 shrink-0 truncate text-gray-300';
    label.textContent = entry.weapon;
    const bar = document.createElement('div');
    bar.className = 'h-2 rounded bg-blue-500';
    bar.style.width = `${Math.max(6, Math.round((entry.kills / max) * 100))}%`;
    const count = document.createElement('span');
    count.className = 'w-8 shrink-0 text-right tabular-nums text-gray-400';
    count.textContent = String(entry.kills);
    row.append(label, bar, count);
    weapons.appendChild(row);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.range-btn').forEach(button => {
    button.addEventListener('click', () => setRange(Number(button.dataset.days)));
  });
  loadServers();
});
