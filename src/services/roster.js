'use strict';

/**
 * Запись игрока в файлы сервера — вайтлист, фракции, свои списки.
 *
 * Это ответ на «человек прошёл проверку, а его не прописало». Причина такого
 * всегда одна: запись делается «на месте» и один раз. Не открылся файл, сервер
 * держал его, бот перезапустился в этот момент — и заявка потерялась молча.
 *
 * Здесь наоборот:
 *   - **очередь на диске**. Задание сначала записывается в data/roster-queue.json,
 *     и только потом выполняется. Панель может упасть в любой момент — после
 *     запуска она допишет то, что не успела;
 *   - **повторы**. Файл занят или диск занят — задание не теряется, а ждёт
 *     следующего круга;
 *   - **идемпотентность**. Повторная заявка на того же игрока не создаёт вторую
 *     строку: сначала проверяется, есть ли он уже;
 *   - **резервная копия** перед каждой правкой: .bak рядом с файлом;
 *   - **аккуратная запись**: во временный файл, потом замена, чтобы сервер не
 *     прочитал половину;
 *   - **журнал**. Каждая запись попадает в журнал событий как действие админа,
 *     поэтому видно, кого и когда прописали.
 *
 * Форматы целей описаны в настройках сервера (`roster.targets`), а не захардкожены:
 * у каждого свой вайтлист и свой мод на фракции.
 */

const fs = require('fs');
const path = require('path');

const config = require('./../config');
const logger = require('./../logger');
const eventlog = require('./eventlog');

const SOURCE = 'roster';

const QUEUE_FILE = path.join(__dirname, '..', '..', 'data', 'roster-queue.json');

/** Как часто разбирать очередь. Прописка не требует реального времени. */
const TICK_MS = 5000;

/** Сколько раз пробовать, прежде чем признать задание невыполнимым. */
const MAX_ATTEMPTS = 20;

let queue = [];
let timer = null;
let working = false;

/* -------------------------------------------------------------- настройки */

/**
 * Цели записи для сервера.
 *
 * Каждая цель: { id, title, file, format, group }
 *   format = "lines" — по одному значению в строке (обычный вайтлист);
 *   format = "json-array" — массив строк в JSON-файле;
 *   format = "group-spawner" — GroupSpawner.json: игрок добавляется в группу
 *     (фракцию) по имени из `group`.
 */
function targets(serverId) {
  const v = config.active(serverId);
  const list = (v.roster && Array.isArray(v.roster.targets) ? v.roster.targets : []).filter((t) => t && t.file);

  return list.map((t, index) => ({
    id: String(t.id || `target${index + 1}`),
    title: String(t.title || t.file),
    file: String(t.file),
    format: ['lines', 'json-array', 'group-spawner'].includes(t.format) ? t.format : 'lines',
    group: String(t.group || ''),
    comment: t.comment !== false
  }));
}

/** Полный путь цели: относительный считается от папки профиля сервера. */
function resolveFile(serverId, target) {
  if (path.isAbsolute(target.file)) return target.file;

  const v = config.active(serverId);
  return path.join(config.profilesPath(v), target.file);
}

/* ------------------------------------------------------------------ очередь */

function loadQueue() {
  try {
    const stored = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    queue = Array.isArray(stored) ? stored : [];
  } catch (_) {
    queue = [];
  }
}

function saveQueue() {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
  } catch (err) {
    logger.error(SOURCE, `Очередь прописки не сохранена: ${err.message}`);
  }
}

/**
 * Поставить игрока в очередь на запись.
 *
 * Возвращается сразу: вызывающему (боту, сайту) не нужно ждать, пока освободится
 * файл. Задание уже на диске, значит оно не потеряется.
 */
function enqueue(serverId, data = {}) {
  const steamId = String(data.steamId || '').trim();
  if (!/^\d{17}$/.test(steamId)) throw new Error('нужен steamId64 из 17 цифр');

  const job = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    serverId: String(serverId),
    steamId,
    name: String(data.name || '').slice(0, 64),
    discordId: String(data.discordId || ''),
    // Пустой список целей означает «во все, что настроены».
    targetIds: Array.isArray(data.targets) ? data.targets.map(String) : [],
    group: String(data.group || ''),
    createdAt: Date.now(),
    attempts: 0,
    done: [],
    failed: [],
    lastError: ''
  };

  queue.push(job);
  saveQueue();

  logger.info(SOURCE, `В очередь на прописку: ${steamId}${job.name ? ` (${job.name})` : ''}`, { serverId });

  // Пробуем сразу, но результат вызывающего не задерживает.
  setImmediate(() => tick().catch(() => {}));
  return { queued: true, id: job.id, position: queue.length };
}

/* ------------------------------------------------------------------ запись */

/** Уже прописан? Проверяем перед правкой, чтобы не плодить дубли. */
function contains(text, steamId, format, group) {
  if (format === 'group-spawner') {
    try {
      const data = JSON.parse(text || '{}');
      const groups = Array.isArray(data.Groups) ? data.Groups : [];
      const found = groups.find((g) => String(g.name || '').toLowerCase() === group.toLowerCase());
      if (!found) return false;

      return (Array.isArray(found.members) ? found.members : []).some(
        (m) => String(m && (m.steam64 || m.steamId || m) || '') === steamId
      );
    } catch (_) {
      return false;
    }
  }

  if (format === 'json-array') {
    try {
      const data = JSON.parse(text || '[]');
      return Array.isArray(data) && data.some((item) => String(item) === steamId);
    } catch (_) {
      return false;
    }
  }

  return String(text || '')
    .split(/\r?\n/)
    .some((line) => line.trim().split(/[\s;,#]/)[0] === steamId);
}

/** Новое содержимое файла с добавленным игроком. */
function withPlayer(text, job, target) {
  if (target.format === 'group-spawner') {
    const data = JSON.parse(text || '{"Groups":[]}');
    if (!Array.isArray(data.Groups)) data.Groups = [];

    const group = String(job.group || target.group || '').trim();
    if (!group) throw new Error('не указана фракция (group) для GroupSpawner');

    let found = data.Groups.find((g) => String(g.name || '').toLowerCase() === group.toLowerCase());
    if (!found) {
      found = { name: group, members: [] };
      data.Groups.push(found);
    }
    if (!Array.isArray(found.members)) found.members = [];

    found.members.push({ steam64: job.steamId, name: job.name || undefined });
    return `${JSON.stringify(data, null, 4)}\n`;
  }

  if (target.format === 'json-array') {
    const data = JSON.parse(text || '[]');
    const list = Array.isArray(data) ? data : [];
    list.push(job.steamId);
    return `${JSON.stringify(list, null, 4)}\n`;
  }

  // Обычный список: одна строка на игрока. Имя — комментарием, чтобы файл
  // оставался читаемым человеком, но при этом не мешал разбору.
  const line = target.comment && job.name ? `${job.steamId} // ${job.name}` : job.steamId;
  const base = String(text || '');
  const separator = base.length && !base.endsWith('\n') ? '\n' : '';

  return `${base}${separator}${line}\n`;
}

/** Записать одну цель. Бросает, если не получилось — задание останется в очереди. */
function writeTarget(job, target) {
  const file = resolveFile(job.serverId, target);

  let text = '';
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, 'utf8');
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const group = String(job.group || target.group || '');
  if (contains(text, job.steamId, target.format, group)) return { changed: false };

  // Копия до правки: файлы сервера правит не только панель, и терять их нельзя.
  if (text) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch (err) {
      logger.warn(SOURCE, `Копия ${path.basename(file)} не создана: ${err.message}`);
    }
  }

  const next = withPlayer(text, job, { ...target, group });
  const tmp = `${file}.tmp`;

  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);

  return { changed: true, file };
}

/* -------------------------------------------------------------------- цикл */

async function tick() {
  if (working || !queue.length) return;
  working = true;

  try {
    const rest = [];

    for (const job of queue) {
      const all = targets(job.serverId);
      const wanted = job.targetIds.length ? all.filter((t) => job.targetIds.includes(t.id)) : all;

      if (!wanted.length) {
        job.lastError = 'не настроено ни одной цели записи (roster.targets)';
        job.attempts++;
        if (job.attempts < MAX_ATTEMPTS) rest.push(job);
        else giveUp(job);
        continue;
      }

      job.attempts++;
      let pending = false;

      for (const target of wanted) {
        if (job.done.includes(target.id)) continue;

        try {
          const result = writeTarget(job, target);
          job.done.push(target.id);

          if (result.changed) {
            logger.info(SOURCE, `Прописан ${job.steamId} в «${target.title}»`, { serverId: job.serverId });
            note(job, target, 'прописан');
          }
        } catch (err) {
          job.lastError = err.message;
          pending = true;
          logger.warn(SOURCE, `Не удалось прописать ${job.steamId} в «${target.title}»: ${err.message}`, {
            serverId: job.serverId
          });
        }
      }

      if (!pending) continue;
      if (job.attempts < MAX_ATTEMPTS) rest.push(job);
      else giveUp(job);
    }

    const changed = rest.length !== queue.length;
    queue = rest;
    if (changed || queue.length) saveQueue();
  } finally {
    working = false;
  }
}

function giveUp(job) {
  logger.error(
    SOURCE,
    `Прописка ${job.steamId} не удалась за ${job.attempts} попыток: ${job.lastError}. ` +
      'Задание снято — проверьте путь к файлу в настройках',
    { serverId: job.serverId }
  );
  note(job, null, `не удалось прописать: ${job.lastError}`);
}

function note(job, target, action) {
  try {
    eventlog.append(job.serverId, [
      {
        ts: Date.now(),
        type: 'admin',
        player: { id: job.steamId, name: job.name || '' },
        data: {
          source: 'roster',
          action: 'прописка',
          phrase: `${action}${target ? ` — ${target.title}` : ''}`,
          discordId: job.discordId || undefined
        }
      }
    ]);
  } catch (_) {
    /* журнал не должен мешать прописке */
  }
}

/* ------------------------------------------------------------------ статус */

function status(serverId) {
  const list = targets(serverId);

  return {
    targets: list.map((t) => {
      const file = resolveFile(serverId, t);
      let exists = false;
      let lines = 0;

      try {
        const text = fs.readFileSync(file, 'utf8');
        exists = true;
        lines = text.split(/\r?\n/).filter((line) => line.trim()).length;
      } catch (_) {
        /* файла пока нет — это нормально, создадим при первой записи */
      }

      return { ...t, path: file, exists, lines };
    }),
    queue: queue
      .filter((job) => job.serverId === String(serverId))
      .map((job) => ({
        id: job.id,
        steamId: job.steamId,
        name: job.name,
        attempts: job.attempts,
        done: job.done,
        lastError: job.lastError
      })),
    reason: list.length
      ? ''
      : 'не настроено ни одной цели записи. Добавьте её в настройках сервера: файл вайтлиста или GroupSpawner.json'
  };
}

/**
 * Фракции из целей формата group-spawner.
 *
 * Боту нужен состав, чтобы показывать «кто в какой фракции» и не пускать
 * человека в две сразу. Читаем прямо из файла сервера: он и есть истина, а не
 * копия в базе бота, которая расходится.
 */
function groups(serverId) {
  const list = [];

  for (const target of targets(serverId).filter((t) => t.format === 'group-spawner')) {
    const file = resolveFile(serverId, target);
    let data = null;

    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      list.push({ target: target.id, title: target.title, error: `файл не прочитан: ${err.message}`, groups: [] });
      continue;
    }

    const parsed = (Array.isArray(data.Groups) ? data.Groups : []).map((group) => ({
      name: String(group.name || ''),
      members: (Array.isArray(group.members) ? group.members : []).map((m) => ({
        steamId: String(m.steam64 || m.steamId || ''),
        name: String(m.name || '')
      }))
    }));

    list.push({ target: target.id, title: target.title, error: '', groups: parsed });
  }

  return list;
}

/** Прописан ли уже игрок — по всем настроенным целям. */
function check(serverId, steamId) {
  const id = String(steamId || '').trim();

  return targets(serverId).map((target) => {
    const file = resolveFile(serverId, target);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      /* нет файла — значит и записи нет */
    }

    return { id: target.id, title: target.title, present: contains(text, id, target.format, target.group) };
  });
}

function start() {
  if (timer) return;
  loadQueue();

  timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  if (timer.unref) timer.unref();

  if (queue.length) {
    logger.info(SOURCE, `В очереди на прописку осталось заданий: ${queue.length} — продолжаю`);
    tick().catch(() => {});
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  saveQueue();
}

module.exports = { start, stop, enqueue, status, check, targets, groups, tick, contains, withPlayer };
