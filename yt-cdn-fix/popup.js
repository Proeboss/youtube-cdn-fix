'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  dot: $('statusDot'),
  summary: $('summary'),
  enabled: $('enabled'),
  liveState: $('liveState'),
  liveHost: $('liveHost'),
  liveBuffer: $('liveBuffer'),
  counts: $('counts'),
  hosts: $('hosts'),
  empty: $('empty'),
  blockTtl: $('blockTtl'),
  maxBlocked: $('maxBlocked'),
  statsInfo: $('statsInfo')
};

let settingsLoaded = false;
let busy = false;

function send(action, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action, ...(payload || {}) }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(res || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function shortHost(host) {
  return String(host || '').replace('.googlevideo.com', '');
}

function humanTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' с';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} мин ${r} с` : `${m} мин`;
}

// Компактный таймер для строки узла: 1:16
function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

function renderLive(state) {
  const live = state.live;
  if (!live) {
    els.liveState.textContent = 'нет данных';
    els.liveState.style.color = '';
    els.liveHost.textContent = '—';
    els.liveBuffer.textContent = '—';
    return;
  }

  const stalled = !live.paused && live.readyState <= 2;
  els.liveState.textContent = live.paused
    ? 'пауза'
    : stalled
      ? 'буферизация…'
      : 'воспроизводится';
  els.liveState.style.color = stalled ? 'var(--bad)' : 'var(--ok)';

  els.liveHost.textContent = live.host ? shortHost(live.host) : '—';
  els.liveHost.title = live.host || '';
  els.liveBuffer.textContent = live.buffered > 0
    ? `${live.buffered} с буфер · ${live.currentTime} с`
    : `${live.currentTime} с`;
}

function renderHosts(state) {
  const list = state.hosts || [];
  els.hosts.textContent = '';

  const blocked = list.filter((h) => h.blocked);
  els.counts.textContent = blocked.length ? `${blocked.length} активно` : 'нет';
  els.empty.style.display = list.length ? 'none' : '';

  for (const h of list.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'host';

    const name = document.createElement('span');
    name.className = 'host-name';
    name.textContent = shortHost(h.host);
    name.title = h.host;

    const meta = document.createElement('span');
    meta.className = 'host-meta';
    meta.textContent = h.blocked
      ? (h.remainingMs > 0 ? clock(h.remainingMs) : '∞')
      : `×${h.hits}`;

    row.appendChild(name);
    row.appendChild(meta);

    if (h.blocked) {
      const btn = document.createElement('button');
      btn.textContent = 'снять';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await send('unblock', { host: h.host });
        refresh();
      });
      row.appendChild(btn);
    }

    els.hosts.appendChild(row);
  }
}

function render(state) {
  if (!state) {
    els.summary.textContent = 'расширение не отвечает';
    els.dot.className = 'dot bad';
    return;
  }

  const on = !!(state.settings && state.settings.enabled);
  els.enabled.checked = on;

  const blocked = state.blockedCount || 0;
  els.dot.className = 'dot ' + (!on ? '' : blocked ? 'bad' : 'ok');
  els.summary.textContent = !on
    ? 'выключено'
    : blocked
      ? `блокирует ${blocked} узел(а)`
      : 'следит за видео';

  if (!settingsLoaded && state.settings) {
    els.blockTtl.value = Math.round((Number(state.settings.blockTtlMs) || 0) / 60000);
    els.maxBlocked.value = Number(state.settings.maxBlocked) || 2;
    settingsLoaded = true;
  }

  renderLive(state);
  renderHosts(state);

  const st = state.stats || {};
  if (st.stalls) {
    const ago = st.lastStallAt ? humanTime(Date.now() - st.lastStallAt) + ' назад' : '';
    els.statsInfo.textContent = `зависаний: ${st.stalls}${ago ? ' · последнее ' + ago : ''}`;
  } else {
    els.statsInfo.textContent = 'зависаний не было';
  }
}

async function refresh() {
  if (busy) return;
  const state = await send('getState');
  render(state);
}

async function pushSettings() {
  const blockTtlMs = Math.max(0, Math.min(60, Number(els.blockTtl.value) || 0)) * 60000;
  const maxBlocked = Math.max(1, Math.min(20, Number(els.maxBlocked.value) || 2));
  const state = await send('setSettings', {
    settings: { blockTtlMs, maxBlocked }
  });
  render(state);
}

els.enabled.addEventListener('change', async () => {
  const state = await send('setSettings', {
    settings: { enabled: els.enabled.checked }
  });
  render(state);
});

els.blockTtl.addEventListener('change', pushSettings);
els.maxBlocked.addEventListener('change', pushSettings);

$('unblockAllBtn').addEventListener('click', async () => {
  busy = true;
  const state = await send('unblockAll');
  busy = false;
  render(state);
});

$('resetBtn').addEventListener('click', async () => {
  busy = true;
  const state = await send('reset');
  busy = false;
  settingsLoaded = false;
  render(state);
});

refresh();
setInterval(refresh, 1000);
