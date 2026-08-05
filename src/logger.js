'use strict';

/**
 * Централизованный лог панели.
 *
 * - хранит кольцевой буфер последних N строк (отдаётся при открытии страницы);
 * - рассылает новые строки подписчикам (SSE-поток веб-интерфейса);
 * - пишет всё в файл logs/panel-ГГГГ-ММ-ДД.log — именно эти файлы попадают
 *   в диагностический отчёт, который можно приложить к вопросу о проблеме.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_DIR = path.join(__dirname, '..', 'logs');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let buffer = [];
let maxLines = 3000;
let seq = 0;
let stream = null;
let streamDay = '';

function today() {
  return new Date().toISOString().slice(0, 10);
}

function currentFile() {
  return path.join(LOG_DIR, `panel-${today()}.log`);
}

function ensureStream() {
  const day = today();
  if (stream && streamDay === day) return stream;

  if (stream) {
    stream.end();
    stream = null;
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(currentFile(), { flags: 'a' });
    streamDay = day;
    cleanupOldFiles();
  } catch (err) {
    console.error('[logger] не удалось открыть файл лога:', err.message);
    stream = null;
  }
  return stream;
}

/** Держим логи за последние 14 дней — этого хватает для разбора проблем. */
function cleanupOldFiles(keepDays = 14) {
  try {
    const limit = Date.now() - keepDays * 24 * 3600 * 1000;
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (!/^panel-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
      const full = path.join(LOG_DIR, file);
      if (fs.statSync(full).mtimeMs < limit) fs.unlinkSync(full);
    }
  } catch (_) {
    /* чистка логов не должна ломать работу панели */
  }
}

function setMaxLines(n) {
  if (Number.isFinite(n) && n > 100) {
    maxLines = Math.floor(n);
    trim();
  }
}

function trim() {
  if (buffer.length > maxLines) buffer = buffer.slice(buffer.length - maxLines);
}

/**
 * @param {string} source   panel | server | steamcmd | mods | firewall | bat | workshop | install
 * @param {string} message
 * @param {'info'|'warn'|'error'} [level]
 * @param {{serverId?: string, jobId?: string}} [meta]
 */
function log(source, message, level = 'info', meta = {}) {
  const text = String(message == null ? '' : message).replace(/\s+$/, '');
  if (!text) return;

  const file = ensureStream();

  for (const line of text.split(/\r?\n/)) {
    const entry = {
      id: ++seq,
      ts: new Date().toISOString(),
      source,
      level,
      message: line,
      ...(meta.serverId ? { serverId: meta.serverId } : {}),
      ...(meta.jobId ? { jobId: meta.jobId } : {})
    };
    buffer.push(entry);
    emitter.emit('line', entry);
    if (file) file.write(`${entry.ts} [${level.toUpperCase().padEnd(5)}] [${source}] ${line}\n`);
  }
  trim();

  const prefix = `[${source}]`;
  if (level === 'error') console.error(prefix, text);
  else if (level === 'warn') console.warn(prefix, text);
  else console.log(prefix, text);
}

const info = (source, msg, meta) => log(source, msg, 'info', meta);
const warn = (source, msg, meta) => log(source, msg, 'warn', meta);
const error = (source, msg, meta) => log(source, msg, 'error', meta);

/** Последние строки буфера. */
const tail = (count = 400) => buffer.slice(-count);

/** Строки, появившиеся после указанного id. */
function since(id) {
  const from = Number(id) || 0;
  return buffer.filter((e) => e.id > from);
}

function clear() {
  buffer = [];
  info('panel', 'Лог очищен');
}

function subscribe(handler) {
  emitter.on('line', handler);
  return () => emitter.off('line', handler);
}

/** Файлы логов панели (для диагностического отчёта). */
function logFiles() {
  try {
    return fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(LOG_DIR, f))
      .sort();
  } catch (_) {
    return [];
  }
}

module.exports = {
  log,
  info,
  warn,
  error,
  tail,
  since,
  clear,
  subscribe,
  setMaxLines,
  logFiles,
  currentFile,
  LOG_DIR
};
