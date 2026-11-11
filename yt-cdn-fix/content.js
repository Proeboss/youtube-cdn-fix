'use strict';

/*
 * Content script (YouTube).
 *
 * Задача: заметить, что видео встало, и сказать service worker'у, какие узлы
 * googlevideo сейчас в игре. Расширение не может читать сетевые ошибки
 * (webRequest не видит медиа-запросы), но может смотреть на сам <video>
 * и на тайминги ресурсов через performance API.
 */

(() => {
  const TICK_MS = 1000;
  const REPORT_AFTER_MS = 3000;   // столько ждём прогресса, прежде чем жаловаться
  const REPORT_COOLDOWN_MS = 6000;
  const ENTRY_WINDOW_MS = 25000;  // окно «свежих» запросов к googlevideo
  const MAX_HOSTS = 6;

  let prevCt = -1;
  let stallSince = 0;
  let lastReportAt = 0;

  function pickVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    const playing = vids.filter((v) => !v.paused && !v.ended);
    const pool = playing.length ? playing : vids;
    pool.sort((a, b) => {
      const sa = (a.clientWidth || 0) * (a.clientHeight || 0);
      const sb = (b.clientWidth || 0) * (b.clientHeight || 0);
      return sb - sa;
    });
    return pool[0] || null;
  }

  function bufferedSeconds(v) {
    let total = 0;
    try {
      for (let i = 0; i < v.buffered.length; i++) {
        total += v.buffered.end(i) - v.buffered.start(i);
      }
    } catch {
      /* ignore */
    }
    return total;
  }

  // Свежие хосты googlevideo, от самого нового к старому.
  function recentHosts() {
    let entries;
    try {
      entries = performance.getEntriesByType('resource') || [];
    } catch {
      return [];
    }
    const now = performance.now();
    const seen = new Set();
    const out = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e || !e.name || e.name.indexOf('googlevideo.com') === -1) continue;
      const age = now - e.startTime;
      if (age > ENTRY_WINDOW_MS) break;
      let host = '';
      try {
        host = new URL(e.name).hostname;
      } catch {
        continue;
      }
      if (!host || !host.endsWith('googlevideo.com')) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      out.push({
        host,
        duration: Math.round(e.duration || 0),
        age: Math.round(age)
      });
      if (out.length >= MAX_HOSTS) break;
    }
    return out;
  }

  function send(msg) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* контекст расширения устарел после обновления */
    }
  }

  function tick() {
    const v = pickVideo();
    if (!v) {
      prevCt = -1;
      stallSince = 0;
      return;
    }

    const ct = v.currentTime;

    // время идёт — прогресс есть
    if (ct !== prevCt) {
      prevCt = ct;
      stallSince = 0;
      return;
    }

    // пауза, конец или уже достаточно данных в буфере — это не зависание
    if (v.paused || v.ended || v.readyState >= 3) {
      stallSince = 0;
      return;
    }

    if (!stallSince) stallSince = Date.now();
    const forMs = Date.now() - stallSince;
    if (forMs < REPORT_AFTER_MS) return;

    const now = Date.now();
    if (now - lastReportAt < REPORT_COOLDOWN_MS) return;

    const hosts = recentHosts();
    if (!hosts.length) return;

    lastReportAt = now;
    send({
      action: 'stall',
      url: location.href,
      stalledMs: forMs,
      readyState: v.readyState,
      currentTime: Number(ct.toFixed(2)),
      hosts
    });
  }

  function heartbeat() {
    const v = pickVideo();
    if (!v) return;
    const hosts = recentHosts();
    send({
      action: 'live',
      url: location.href,
      paused: v.paused,
      currentTime: Number(v.currentTime.toFixed(1)),
      readyState: v.readyState,
      buffered: Number(bufferedSeconds(v).toFixed(1)),
      host: hosts.length ? hosts[0].host : ''
    });
  }

  setInterval(tick, TICK_MS);
  setInterval(heartbeat, 5000);
})();
