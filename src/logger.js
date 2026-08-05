'use strict';

/**
 * Централизованный лог панели.
 *
 * - хранит кольцевой буфер последних N строк (для отдачи при открытии страницы);
 * - рассылает новые строки всем подписчикам (SSE-подключения веб-интерфейса);
 * - дублирует всё в консоль и в файл logs/panel.log.
 *
 * Модуль намеренно не зависит ни от Express, ни от конфига, чтобы его можно
 * было подключать из любого сервиса без циклических зависимостей.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'panel.log');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let buffer = [];
let maxLines = 2000;
let seq = 0;
let fileStream = null;

function ensureFileStream() {
  if (fileStream) return fileStream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch (err) {
    // Логи в файл — не критично, продолжаем без них.
    console.error('[logger] не удалось открыть файл лога:', err.message);
    fileStream = null;
  }
  return fileStream;
}

function setMaxLines(n) {
  if (Number.isFinite(n) && n > 50) {
    maxLines = Math.floor(n);
    trim();
  }
}

function trim() {
  if (buffer.length > maxLines) {
    buffer = buffer.slice(buffer.length - maxLines);
  }
}

/**
 * @param {'info'|'warn'|'error'|'server'|'steamcmd'|'firewall'|'mods'} source
 * @param {string} message
 * @param {'info'|'warn'|'error'} [level]
 */
function log(source, message, level = 'info') {
  const text = String(message == null ? '' : message).replace(/\s+$/, '');
  if (!text) return;

  for (const line of text.split(/\r?\n/)) {
    const entry = {
      id: ++seq,
      ts: new Date().toISOString(),
      source,
      level,
      message: line
    };
    buffer.push(entry);
    emitter.emit('line', entry);

    const stream = ensureFileStream();
    if (stream) stream.write(`${entry.ts} [${source}] ${line}\n`);
  }
  trim();

  const prefix = `[${source}]`;
  if (level === 'error') console.error(prefix, text);
  else if (level === 'warn') console.warn(prefix, text);
  else console.log(prefix, text);
}

const info = (source, msg) => log(source, msg, 'info');
const warn = (source, msg) => log(source, msg, 'warn');
const error = (source, msg) => log(source, msg, 'error');

/** Последние строки буфера (для первичной загрузки страницы). */
function tail(count = 300) {
  return buffer.slice(-count);
}

/** Строки, появившиеся после указанного id (для дозагрузки после реконнекта). */
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

module.exports = { log, info, warn, error, tail, since, clear, subscribe, setMaxLines, LOG_FILE };
