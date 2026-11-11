'use strict';

/*
 * YouTube CDN Fix — MV3 service worker (v2).
 *
 * Почему так: webRequest в Chrome не видит медиа-запросы YouTube, поэтому
 * ловить ошибки сети из расширения нельзя. Зато content-script на странице
 * видит сам <video> и тайминги запросов к googlevideo. Он сообщает о
 * зависании, а мы временно блокируем через declarativeNetRequest тот узел,
 * на котором плеер застрял. Плеер получает ошибку и уходит на другой узел.
 *
 * Проверено: блокировка сломанного локального узла переводит воспроизведение
 * на рабочий узел и не мешает видео, которые лежат в кэше этого узла
 * (кэшированные не зависают, значит и блокировки не будет).
 */

const DEFAULTS = {
  enabled: true,
  blockTtlMs: 90000,      // через сколько отпускать узел
  maxBlocked: 2,          // предохранитель: больше узлов одновременно не блокируем
  minBlockIntervalMs: 25000 // не блокируем чаще, чем раз в 25 секунд
};

const MIN_HANG_MS = 1200; // запрос короче — считаем, что узел ответил нормально

let settings = { ...DEFAULTS };
let hosts = {};          // host -> { blocked, ruleId, blockedAt, reason, hits, lastError }
let stats = { stalls: 0, lastStallAt: 0, lastBlockAt: 0, lastHosts: [], lastUrl: '' };
let live = { at: 0, url: '', paused: true, currentTime: 0, readyState: 0, buffered: 0, host: '' };
let nextRuleId = 1000;
let loaded = null;
let queue = Promise.resolve();

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

function load() {
  if (loaded) return loaded;
  loaded = chrome.storage.local
    .get(['settings', 'hosts', 'stats', 'live', 'nextRuleId'])
    .then((data) => {
      settings = { ...DEFAULTS, ...(data.settings || {}) };
      hosts = data.hosts || {};
      stats = { ...stats, ...(data.stats || {}) };
      live = { ...live, ...(data.live || {}) };
      nextRuleId = Number(data.nextRuleId) || 1000;
    })
    .catch(() => {});
  return loaded;
}

function save() {
  return chrome.storage.local
    .set({ settings, hosts, stats, live, nextRuleId })
    .catch(() => {});
}

function locked(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function blockedEntries() {
  return Object.entries(hosts).filter(([, r]) => r && r.blocked);
}

async function updateBadge() {
  try {
    const n = blockedEntries().length;
    await chrome.action.setBadgeBackgroundColor({ color: n ? '#c0392b' : '#2e7d32' });
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* blocking                                                            */
/* ------------------------------------------------------------------ */

async function blockHost(host, reason) {
  if (!host || !host.endsWith('googlevideo.com')) return false;
  const rec = hosts[host] || (hosts[host] = {});
  if (rec.blocked) return false;

  // предохранитель: не блокируем всё подряд
  const blocked = blockedEntries();
  if (blocked.length >= settings.maxBlocked) {
    blocked.sort((a, b) => (a[1].blockedAt || 0) - (b[1].blockedAt || 0));
    await unblockHost(blocked[0][0]);
  }

  const id = nextRuleId++;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id,
          priority: 100,
          action: { type: 'block' },
          condition: { urlFilter: `||${host}^` }
        }
      ]
    });
  } catch (e) {
    rec.lastError = 'rule: ' + String(e && e.message ? e.message : e);
    await save();
    return false;
  }

  rec.blocked = true;
  rec.ruleId = id;
  rec.blockedAt = Date.now();
  rec.reason = reason || '';
  rec.hits = (rec.hits || 0) + 1;
  await save();
  await updateBadge();
  return true;
}

async function unblockHost(host) {
  const rec = hosts[host];
  if (!rec || !rec.blocked) return false;
  if (rec.ruleId) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [rec.ruleId] });
    } catch {
      /* ignore */
    }
  }
  rec.blocked = false;
  rec.ruleId = null;
  rec.blockedAt = 0;
  await save();
  await updateBadge();
  return true;
}

async function unblockAll() {
  for (const [host] of blockedEntries()) {
    await unblockHost(host);
  }
}

async function releaseExpired() {
  const ttl = Number(settings.blockTtlMs) || 0;
  if (ttl <= 0) return;
  const now = Date.now();
  for (const [host, rec] of blockedEntries()) {
    if (rec.blockedAt && now - rec.blockedAt >= ttl) {
      await unblockHost(host);
    }
  }
}

// Если в хранилище остались правила, а записей нет — подчистим.
// И наоборот: записи о блокировке, которых нет среди правил, снимаем.
async function reconcileRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = new Set(existing.map((r) => r.id));
    const known = new Set(
      Object.values(hosts)
        .filter((r) => r && r.ruleId)
        .map((r) => r.ruleId)
    );
    const orphan = existing.map((r) => r.id).filter((id) => !known.has(id));
    if (orphan.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: orphan });
    }

    let dirty = false;
    for (const rec of Object.values(hosts)) {
      if (!rec || !rec.blocked) continue;
      if (!rec.ruleId || !existingIds.has(rec.ruleId)) {
        rec.blocked = false;
        rec.ruleId = null;
        rec.blockedAt = 0;
        dirty = true;
      }
    }
    if (dirty) await save();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* stall handling                                                      */
/* ------------------------------------------------------------------ */

function pickHostToBlock(candidates) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && typeof c.host === 'string' && c.host.endsWith('googlevideo.com'))
    .map((c) => ({
      host: c.host,
      duration: Number(c.duration) || 0,
      age: Number(c.age) || 0
    }))
    // самый «висящий» запрос — первым
    .sort((a, b) => b.duration - a.duration || a.age - b.age);

  for (const c of list) {
    if (hosts[c.host] && hosts[c.host].blocked) continue;
    if (c.duration && c.duration < MIN_HANG_MS) continue;
    return c.host;
  }
  // запасной вариант: самый свежий незаблокированный
  for (const c of list) {
    if (hosts[c.host] && hosts[c.host].blocked) continue;
    return c.host;
  }
  return '';
}

async function handleStall(msg) {
  if (!settings.enabled) return { blocked: [] };
  stats.stalls = (stats.stalls || 0) + 1;
  stats.lastStallAt = Date.now();
  stats.lastUrl = String(msg.url || '').slice(0, 200);
  stats.lastHosts = (msg.hosts || []).map((h) => h && h.host).filter(Boolean);

  const blocked = [];
  const now = Date.now();
  const sinceLast = now - (stats.lastBlockAt || 0);
  // Не частим с блокировками: плееру нужно время, чтобы перепробовать узлы.
  if (sinceLast >= (Number(settings.minBlockIntervalMs) || 0)) {
    const host = pickHostToBlock(msg.hosts);
    if (host && (await blockHost(host, 'stall'))) {
      blocked.push(host);
      stats.lastBlockAt = now;
    }
  }
  await save();
  return { blocked };
}

/* ------------------------------------------------------------------ */
/* messaging                                                           */
/* ------------------------------------------------------------------ */

function publicState() {
  const now = Date.now();
  const list = Object.entries(hosts)
    .filter(([, r]) => r && (r.blocked || r.hits || r.lastError))
    .map(([host, r]) => ({
      host,
      blocked: !!r.blocked,
      reason: r.reason || '',
      hits: r.hits || 0,
      lastError: r.lastError || '',
      blockedAt: r.blockedAt || 0,
      remainingMs: r.blocked && r.blockedAt && settings.blockTtlMs > 0
        ? Math.max(0, r.blockedAt + settings.blockTtlMs - now)
        : 0
    }));
  list.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
    return (b.blockedAt || 0) - (a.blockedAt || 0);
  });

  const liveFresh = live && live.at && now - live.at < 15000;
  return {
    settings,
    hosts: list,
    blockedCount: list.filter((x) => x.blocked).length,
    stats,
    live: liveFresh ? live : null
  };
}

async function handleMessage(msg) {
  await load();
  const action = msg && msg.action;

  if (action === 'stall') {
    return handleStall(msg);
  }

  if (action === 'live') {
    live = {
      at: Date.now(),
      url: String(msg.url || '').slice(0, 200),
      paused: !!msg.paused,
      currentTime: Number(msg.currentTime) || 0,
      readyState: Number(msg.readyState) || 0,
      buffered: Number(msg.buffered) || 0,
      host: String(msg.host || '')
    };
    await chrome.storage.local.set({ live }).catch(() => {});
    return { ok: true };
  }

  if (action === 'getState') {
    return publicState();
  }

  if (action === 'setSettings') {
    const next = { ...settings, ...(msg.settings || {}) };
    next.enabled = next.enabled !== false;
    next.blockTtlMs = Math.max(0, Math.min(3600000, Number(next.blockTtlMs) || 0));
    next.maxBlocked = Math.max(1, Math.min(20, Number(next.maxBlocked) || 2));
    next.minBlockIntervalMs = Math.max(0, Math.min(300000, Number(next.minBlockIntervalMs) || 0));
    settings = next;
    await save();
    if (!settings.enabled) {
      await unblockAll();
    }
    return publicState();
  }

  if (action === 'unblock') {
    await unblockHost(String(msg.host || ''));
    return publicState();
  }

  if (action === 'unblockAll') {
    await unblockAll();
    return publicState();
  }

  if (action === 'reset') {
    await unblockAll();
    hosts = {};
    stats = { stalls: 0, lastStallAt: 0, lastBlockAt: 0, lastHosts: [], lastUrl: '' };
    live = { at: 0, url: '', paused: true, currentTime: 0, readyState: 0, buffered: 0, host: '' };
    nextRuleId = 1000;
    await save();
    await updateBadge();
    return publicState();
  }

  return { error: 'unknown action' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || (msg.action !== 'stall' && msg.action !== 'live' && msg.action !== 'getState' &&
      msg.action !== 'setSettings' && msg.action !== 'unblock' && msg.action !== 'unblockAll' &&
      msg.action !== 'reset')) {
    return false;
  }
  locked(() => handleMessage(msg))
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ error: String(e && e.message ? e.message : e) }));
  return true;
});

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

function ensureAlarm() {
  try {
    chrome.alarms.create('cdffix-release', { periodInMinutes: 1 });
  } catch {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  load().then(async () => {
    ensureAlarm();
    await reconcileRules();
    await updateBadge();
  });
});

chrome.runtime.onStartup.addListener(() => {
  load().then(async () => {
    ensureAlarm();
    await reconcileRules();
    await updateBadge();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cdffix-release') {
    locked(async () => {
      await load();
      await releaseExpired();
    }).catch(() => {});
  }
});

load().then(async () => {
  ensureAlarm();
  await reconcileRules();
  await releaseExpired();
  await updateBadge();
});
