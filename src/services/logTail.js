'use strict';

/**
 * Слежение за логами DayZ-сервера в папке профиля.
 *
 * Сам DayZServer_x64.exe почти ничего не пишет в stdout — вся полезная
 * информация уходит в файлы профиля (*.RPT, *.ADM, script*.log). Панель
 * находит свежие файлы и дочитывает появившиеся строки, отдавая их в общий
 * лог, который транслируется в браузер.
 *
 * Модуль — фабрика: у каждого сервера свой независимый «хвостовик».
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');

const SOURCE = 'server';
const POLL_MS = 1000;
const PATTERNS = [/\.RPT$/i, /\.ADM$/i, /^script.*\.log$/i, /crash.*\.log$/i];

const matches = (name) => PATTERNS.some((re) => re.test(name));

/** Свежие лог-файлы профиля (созданные не раньше запуска сервера). */
function findLogFiles(dir, startedAt) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];

  const walk = (current, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) walk(full, depth + 1);
        continue;
      }
      if (!matches(entry.name)) continue;
      try {
        if (startedAt && fs.statSync(full).mtimeMs < startedAt - 60_000) continue;
        out.push(full);
      } catch (_) {
        /* файл исчез */
      }
    }
  };

  walk(dir, 0);
  return out;
}

/**
 * @param {string} serverId
 * @param {{onLine?: (line: string, file: string) => void}} [opts]
 */
function createTailer(serverId, opts = {}) {
  let timer = null;
  let watchedDir = '';
  let startedAt = 0;
  const offsets = new Map();

  function readNewBytes(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      return '';
    }

    if (!offsets.has(file)) {
      // Первый заход: начинаем с конца, чтобы не вывалить весь старый лог.
      offsets.set(file, stat.size);
      return '';
    }
    if (stat.size < offsets.get(file)) offsets.set(file, 0); // файл пересоздан
    if (stat.size === offsets.get(file)) return '';

    const from = offsets.get(file);
    const length = stat.size - from;
    const buffer = Buffer.alloc(length);

    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const read = fs.readSync(fd, buffer, 0, length, from);
      offsets.set(file, from + read);
      return buffer.subarray(0, read).toString('utf8');
    } catch (_) {
      return '';
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* уже закрыт */
        }
      }
    }
  }

  function poll() {
    for (const file of findLogFiles(watchedDir, startedAt)) {
      const chunk = readNewBytes(file);
      if (!chunk.trim()) continue;
      const label = path.basename(file);
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const level = /error|exception|fail|cannot|unable/i.test(line) ? 'warn' : 'info';
        logger.log(SOURCE, `[${label}] ${line}`, level, { serverId });
        if (opts.onLine) opts.onLine(line, label);
      }
    }
  }

  function start(from = Date.now()) {
    stop();
    startedAt = from;
    offsets.clear();

    try {
      watchedDir = config.profilesPath(config.active(serverId));
    } catch (_) {
      return false;
    }

    if (!fs.existsSync(watchedDir)) {
      logger.warn(SOURCE, `Папка профиля не найдена, лог сервера читаться не будет: ${watchedDir}`, { serverId });
      return false;
    }

    logger.info(SOURCE, `Слежу за логами в ${watchedDir}`, { serverId });
    timer = setInterval(poll, POLL_MS);
    if (timer.unref) timer.unref();
    return true;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, isRunning: () => Boolean(timer), poll };
}

module.exports = { createTailer, findLogFiles };
