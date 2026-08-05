'use strict';

/**
 * Слежение за логами DayZ-сервера в папке профиля.
 *
 * Сам DayZServer_x64.exe почти ничего не пишет в stdout — вся полезная
 * информация уходит в файлы профиля (*.RPT, *.ADM, script*.log). Панель
 * находит самые свежие из них и дочитывает появившиеся строки, отдавая их
 * в общий лог, который транслируется в браузер.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');

const SOURCE = 'server';
const POLL_MS = 1000;
const PATTERNS = [/\.RPT$/i, /\.ADM$/i, /^script.*\.log$/i, /\.log$/i];

let timer = null;
const offsets = new Map(); // путь -> прочитано байт
let watchedDir = '';

function matches(name) {
  return PATTERNS.some((re) => re.test(name));
}

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
        const stat = fs.statSync(full);
        if (startedAt && stat.mtimeMs < startedAt - 60_000) continue; // старый лог
        out.push(full);
      } catch (_) {
        /* файл исчез */
      }
    }
  };

  walk(dir, 0);
  return out;
}

function readNewBytes(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return '';
  }

  const known = offsets.get(file);
  if (known === undefined) {
    // Первый заход: начинаем с конца, чтобы не вывалить в панель весь старый лог.
    offsets.set(file, stat.size);
    return '';
  }
  if (stat.size < known) {
    offsets.set(file, 0); // файл пересоздан
  }
  if (stat.size === offsets.get(file)) return '';

  const from = offsets.get(file);
  const length = stat.size - from;
  const buffer = Buffer.alloc(length);

  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buffer, 0, length, from);
    offsets.set(file, from + read);
    return buffer.slice(0, read).toString('utf8');
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

function poll(startedAt) {
  const files = findLogFiles(watchedDir, startedAt);
  for (const file of files) {
    const chunk = readNewBytes(file);
    if (!chunk.trim()) continue;
    const label = path.basename(file);
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) logger.info(SOURCE, `[${label}] ${line}`);
    }
  }
}

/** Начать слежение за папкой профиля. */
function start(startedAt = Date.now()) {
  stop();
  watchedDir = config.profilesPath();
  offsets.clear();

  if (!fs.existsSync(watchedDir)) {
    logger.warn(SOURCE, `Папка профиля не найдена, лог сервера читаться не будет: ${watchedDir}`);
    return false;
  }

  logger.info(SOURCE, `Слежу за логами в ${watchedDir}`);
  timer = setInterval(() => poll(startedAt), POLL_MS);
  if (timer.unref) timer.unref();
  return true;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function isRunning() {
  return Boolean(timer);
}

module.exports = { start, stop, isRunning, findLogFiles };
