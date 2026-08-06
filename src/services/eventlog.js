'use strict';

/**
 * Хранилище игровых событий, приходящих от мода-моста.
 *
 * События идут потоком: на живом сервере это десятки строк в секунду, а смотреть
 * их нужно и «вживую», и задним числом («что делал этот игрок два часа назад»).
 * Отсюда две части:
 *
 *   - файлы по дням: logs/events/<serverId>/<ГГГГ-ММ-ДД>.jsonl — по строке JSON
 *     на событие. Формат построчный специально: дописывать дёшево, читать можно
 *     с конца, и файл не портится, если панель убить на полуслове;
 *   - кольцо в памяти на последние N событий каждого сервера — из него мгновенно
 *     отвечают живая лента и карточка игрока.
 *
 * Запросы всегда идут от свежих к старым: сначала кольцо, потом файлы за нужные
 * дни. Так «последние 200 событий игрока» не читают с диска ничего.
 */

const fs = require('fs');
const path = require('path');

const logger = require('../logger');

const SOURCE = 'events';

const ROOT = path.join(__dirname, '..', '..', 'logs', 'events');

/** Сколько событий каждого сервера держим в памяти. */
const MEMORY_LIMIT = 5000;

/** Сколько дней хранить файлы. */
const KEEP_DAYS = 30;

/** serverId -> { ring: object[], counter: number, stream, streamDay } */
const stores = new Map();

function storeOf(serverId) {
  if (!stores.has(serverId)) {
    stores.set(serverId, { ring: [], counter: 0, stream: null, streamDay: '' });
  }
  return stores.get(serverId);
}

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

function fileFor(serverId, day) {
  return path.join(ROOT, safeId(serverId), `${day}.jsonl`);
}

/** ID сервера приходит из конфига панели, но в путь пусть попадает только простое. */
const safeId = (serverId) => String(serverId).replace(/[^\w-]/g, '_') || 'server';

/* ------------------------------------------------------------------- запись */

/** Поток на текущий день; при смене суток переоткрывается. */
function streamFor(serverId, day) {
  const store = storeOf(serverId);
  if (store.stream && store.streamDay === day) return store.stream;

  if (store.stream) {
    store.stream.end();
    store.stream = null;
  }

  const file = fileFor(serverId, day);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  store.stream = fs.createWriteStream(file, { flags: 'a' });
  store.stream.on('error', (err) => logger.warn(SOURCE, `Не удалось писать ${file}: ${err.message}`));
  store.streamDay = day;
  return store.stream;
}

/**
 * Добавить события. Возвращает их же, но с присвоенными id — по ним интерфейс
 * отличает уже показанные события от новых.
 *
 * @param {string} serverId
 * @param {object[]} events события в формате протокола моста
 */
function append(serverId, events) {
  if (!Array.isArray(events) || !events.length) return [];

  const store = storeOf(serverId);
  const stored = [];
  const lines = new Map(); // день -> строки

  for (const raw of events) {
    const event = normalize(raw, ++store.counter);
    stored.push(event);

    const day = dayOf(event.ts);
    if (!lines.has(day)) lines.set(day, []);
    lines.get(day).push(JSON.stringify(event));
  }

  for (const [day, dayLines] of lines) {
    try {
      streamFor(serverId, day).write(`${dayLines.join('\n')}\n`);
    } catch (err) {
      logger.warn(SOURCE, `События за ${day} не записаны: ${err.message}`);
    }
  }

  store.ring.push(...stored);
  if (store.ring.length > MEMORY_LIMIT) store.ring.splice(0, store.ring.length - MEMORY_LIMIT);

  return stored;
}

/**
 * Приводим событие к общему виду.
 *
 * Мод — внешний код, и полагаться на то, что все поля на месте и нужного типа,
 * нельзя: одно битое событие не должно ломать ленту в браузере.
 */
function normalize(raw, id) {
  const event = raw && typeof raw === 'object' ? raw : {};
  const ts = Number(event.ts);
  const player = normalizeActor(event.player);
  const target = normalizeActor(event.target);

  return {
    id,
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    type: String(event.type || 'unknown').slice(0, 40),
    playerId: player ? player.id : '',
    playerName: player ? player.name : '',
    targetId: target ? target.id : '',
    targetName: target ? target.name : '',
    pos: Array.isArray(event.pos) ? event.pos.slice(0, 3).map((n) => Number(n) || 0) : null,
    data: event.data && typeof event.data === 'object' ? event.data : {}
  };
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return null;
  const id = String(actor.id || actor.steam64 || '').slice(0, 40);
  return { id, name: String(actor.name || '').slice(0, 64) };
}

/* -------------------------------------------------------------------- чтение */

/**
 * Выборка событий, от свежих к старым.
 *
 * @param {string} serverId
 * @param {{limit?: number, before?: number, types?: string[], playerId?: string,
 *          search?: string, since?: number, days?: number}} [query]
 *        before — брать события старше этой метки (постраничная прокрутка);
 *        since — только новее метки (живая лента);
 *        days — сколько дней истории просматривать в файлах (по умолчанию 3).
 */
function list(serverId, query = {}) {
  const limit = clamp(parseInt(query.limit, 10) || 200, 1, 2000);
  const filter = buildFilter(query);
  const out = [];

  // 1. Память: самые свежие события.
  const ring = storeOf(serverId).ring;
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    if (filter(ring[i])) out.push(ring[i]);
  }

  const oldestInMemory = ring.length ? ring[0].ts : Infinity;
  const needMore = out.length < limit;
  const wantsHistory = query.before !== undefined && Number(query.before) <= oldestInMemory;

  // 2. Файлы — только если памяти не хватило или спрашивают заведомо старое.
  if (needMore && (wantsHistory || ring.length === 0 || out.length < limit)) {
    const days = clamp(parseInt(query.days, 10) || 3, 1, KEEP_DAYS);
    for (const day of recentDays(days)) {
      if (out.length >= limit) break;

      for (const event of readDay(serverId, day)) {
        if (event.ts >= oldestInMemory) continue; // уже есть из памяти
        if (!filter(event)) continue;
        out.push(event);
        if (out.length >= limit) break;
      }
    }
  }

  out.sort((a, b) => b.ts - a.ts || b.id - a.id);
  return { events: out.slice(0, limit), limit };
}

function buildFilter(query) {
  const types = Array.isArray(query.types)
    ? query.types.filter(Boolean)
    : query.types
      ? String(query.types).split(',').map((t) => t.trim()).filter(Boolean)
      : null;

  const playerId = query.playerId ? String(query.playerId) : '';
  const search = query.search ? String(query.search).toLowerCase() : '';
  const before = Number(query.before) || 0;
  const since = Number(query.since) || 0;

  return (event) => {
    if (types && !types.includes(event.type)) return false;
    // Игрок «участвует» и как действующий, и как цель: в карточке игрока важно
    // видеть и то, что он сделал, и то, что сделали с ним.
    if (playerId && event.playerId !== playerId && event.targetId !== playerId) return false;
    if (before && event.ts >= before) return false;
    if (since && event.ts <= since) return false;

    if (search) {
      const haystack = `${event.type} ${event.playerName} ${event.targetName} ${JSON.stringify(event.data)}`;
      if (!haystack.toLowerCase().includes(search)) return false;
    }
    return true;
  };
}

/** Дни от сегодняшнего назад. */
function recentDays(count) {
  const days = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) days.push(dayOf(now - i * 86_400_000));
  return days;
}

/** Прочитать файл дня, от последних строк к первым. */
function readDay(serverId, day) {
  const file = fileFor(serverId, day);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }

  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      /* обрезанная строка — пропускаем */
    }
  }
  return out;
}

/** Сколько событий по типам за последние часы — для сводки в интерфейсе. */
function summary(serverId, hours = 24) {
  const since = Date.now() - clamp(hours, 1, 168) * 3600_000;
  const counts = {};
  let total = 0;

  const seen = new Set();
  const add = (event) => {
    if (event.ts < since || seen.has(event.id)) return;
    seen.add(event.id);
    counts[event.type] = (counts[event.type] || 0) + 1;
    total++;
  };

  for (const event of storeOf(serverId).ring) add(event);
  for (const day of recentDays(Math.ceil(hours / 24) + 1)) {
    for (const event of readDay(serverId, day)) add(event);
  }

  return { total, counts, hours, since };
}

/** Файлы истории — чтобы показать, что можно скачать или удалить. */
function files(serverId) {
  const dir = path.join(ROOT, safeId(serverId));
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .reverse()
      .map((name) => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return { day: name.replace('.jsonl', ''), path: full, sizeBytes: stat.size, mtime: stat.mtimeMs };
      });
  } catch (_) {
    return [];
  }
}

/** Удалить файлы старше KEEP_DAYS. */
function cleanup(serverId) {
  const keep = new Set(recentDays(KEEP_DAYS));
  let removed = 0;

  for (const file of files(serverId)) {
    if (keep.has(file.day)) continue;
    try {
      fs.rmSync(file.path, { force: true });
      removed++;
    } catch (_) {
      /* не критично */
    }
  }
  if (removed) logger.info(SOURCE, `Удалено старых файлов событий: ${removed}`, { serverId });
  return removed;
}

/** Закрыть потоки (при остановке панели). */
function close() {
  for (const store of stores.values()) {
    if (store.stream) store.stream.end();
    store.stream = null;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { append, list, summary, files, cleanup, close, ROOT, MEMORY_LIMIT, KEEP_DAYS };
