'use strict';

/**
 * Журнал действий администраторов.
 *
 * Своими действиями панель отчитывается сама (см. note() — её вызывают маршруты
 * и мост), но админы работают не только через панель: спавн, телепорт, годмод,
 * кик и баны обычно делаются из VPPAdminTools прямо в игре. Этот сервис читает
 * логи VPP и складывает их в тот же журнал событий, что и всё остальное, —
 * чтобы «кто заспавнил» и «кто телепортировался» искались в одном месте.
 *
 * Формат логов VPP (проверено по исходникам VanillaPlusPlus/VPP-Admin-Tools,
 * 4_World/VPPAdminTools/Plugins/PluginBase/LogManager/LogManager.c):
 *
 *   файл:   <профиль>/VPPAdminTools/Logging/Log_ГГГГ-М-Д_Ч-М-С.txt
 *   строка: «Ч:М:С | текст» либо «Г/М/Д, Ч:М:С | текст» (LongTimeStamp)
 *   текст:  «"Имя" (steamid=76561…) действие» и далее по действию —
 *           цель «"Имя" (steamid=…)», место «(pos=<x y z>)», параметр «(…)»
 *
 * Файл читается «хвостом»: панель помнит смещение и разбирает только новые
 * строки. При первом запуске история не втягивается — иначе журнал заполнился
 * бы всем, что было до установки панели.
 */

const fs = require('fs');
const path = require('path');

const config = require('./../config');
const logger = require('./../logger');
const eventlog = require('./eventlog');

const SOURCE = 'adminlog';

/** Как часто заглядывать в файл. Действия админа не требуют реального времени. */
const POLL_MS = 3000;

/** За раз разбираем не больше — чтобы огромный файл не съел память. */
const MAX_CHUNK = 512 * 1024;

/** Сколько хвоста читать у файла, который увидели впервые. */
const FIRST_READ_BYTES = 128 * 1024;

const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'adminlog-state.json');

/** serverId -> {file, offset} */
let offsets = {};
let timer = null;

/* ------------------------------------------------------------------- пути */

function loggingDir(serverId) {
  // profilesPath ждёт «плоский вид» сервера, а не его id.
  return path.join(config.profilesPath(config.active(serverId)), 'VPPAdminTools', 'Logging');
}

/**
 * Поиск файлов логов VPP.
 *
 * Обычное место — <профиль>/VPPAdminTools/Logging, но сборок VPP много (у людей
 * стоят и форки), поэтому если там ничего нет, обходим профиль целиком и берём
 * всё, что похоже на Log_*.txt внутри папок с «VPP» в названии. Глубина
 * ограничена: в профиле лежат ещё и логи сервера на гигабайты.
 */
const SEARCH_DEPTH = 4;

function findLogs(serverId) {
  const root = path.join(config.profilesPath(config.active(serverId)));
  const found = [];

  const walk = (dir, depth) => {
    if (depth > SEARCH_DEPTH) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }

      if (!/^Log_.*\.txt$/i.test(entry.name)) continue;
      // Отсекаем случайные Log_*.txt вне папок VPP.
      if (!/vpp/i.test(dir)) continue;

      try {
        const stat = fs.statSync(full);
        found.push({ file: full, mtime: stat.mtimeMs, size: stat.size });
      } catch (_) {
        /* исчез */
      }
    }
  };

  walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

/** Самый свежий файл логов VPP: он создаёт новый при каждом запуске сервера. */
function newestLog(serverId) {
  const list = findLogs(serverId);
  return list.length ? list[0].file : '';
}

/* ---------------------------------------------------------------- разбор */

/**
 * Строка лога -> событие для журнала.
 * @returns {object|null} null — служебная строка (заголовок, сообщение плагина)
 */
function parseLine(line, fallbackTs) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('=') || text.startsWith('Logs Started')) return null;

  const split = text.indexOf('|');
  if (split < 0) return null;

  const stamp = text.slice(0, split).trim();
  const message = text.slice(split + 1).trim();
  if (!message) return null;

  // Строки вида «[BansManager]:: Save(): …» — это отладка плагинов, не действия.
  if (/^\[[A-Za-z ]+\](::|\s)/.test(message) && !/steamid=/.test(message)) return null;

  const actor = message.match(/^"([^"]*)"\s*\(steamid=([^)]*)\)\s*(.*)$/);
  const rest = actor ? actor[3] : message;

  const target = rest.match(/"([^"]*)"\s*\(steamid=([^)]*)\)/) || rest.match(/\(steamid=([^)]*)\)/);
  const targetId = target ? (target.length === 3 ? target[2] : target[1]) : '';
  const targetName = target && target.length === 3 ? target[1] : '';

  const position = rest.match(/pos=<?([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)>?/);

  return {
    ts: timestampOf(stamp, fallbackTs),
    type: 'admin',
    player: actor ? { id: actor[2].trim(), name: actor[1] } : null,
    target: targetId ? { id: String(targetId).trim(), name: targetName } : null,
    pos: position ? [Number(position[1]), Number(position[2]), Number(position[3])] : null,
    data: {
      source: 'vpp',
      action: actionOf(rest),
      // Короткая фраза для журнала: кто действовал, уже видно в колонке игрока,
      // а steamid цели заменяем на имя, если VPP его назвал.
      phrase: phraseOf(rest),
      // Исходная строка остаётся: это аудит, и терять его формулировку нельзя.
      text: message
    }
  };
}

/**
 * Короткое название действия — по нему в журнале ставится фильтр.
 *
 * Список составлен по строкам логов VPP: они устойчивые, потому что задаются
 * в исходниках мода как шаблоны string.Format.
 */
const ACTIONS = [
  [/teleport|\/goto|\/bring|\/return|\/tpp|\/tpt/i, 'телепорт'],
  [/spawned item|spawned preset|spawned a|\/spawncar|\/spi|\/spg|\/sph/i, 'спавн'],
  [/deleted object|deleted objects|moved an object/i, 'объекты'],
  [/godmode/i, 'годмод'],
  [/unlimited ammo|\/ammo/i, 'патроны'],
  [/heal|stopped bleeding|health stat/i, 'лечение'],
  [/kill|executed kill/i, 'убийство'],
  [/kick/i, 'кик'],
  [/ban/i, 'бан'],
  [/froze player|freeze/i, 'заморозка'],
  [/cleared inventory|\/strip/i, 'инвентарь'],
  [/sent message/i, 'сообщение'],
  [/spectate|freecam/i, 'наблюдение'],
  [/building set|preset/i, 'наборы'],
  [/server restart/i, 'перезапуск'],
  [/permission|group/i, 'права']
];

/** «"Вася" (steamid=765…)» -> «Вася»; одинокий steamid оставляем как есть. */
function phraseOf(text) {
  return String(text)
    .replace(/"([^"]*)"\s*\(steamid=[^)]*\)/g, '$1')
    .replace(/\(steamid=([^)]*)\)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function actionOf(text) {
  for (const [pattern, name] of ACTIONS) {
    if (pattern.test(text)) return name;
  }
  return 'действие';
}

/**
 * Время события.
 *
 * VPP пишет только время суток по UTC, поэтому дату берём текущую. Если
 * получилось «из будущего», значит запись сделана до полуночи — сдвигаем на день
 * назад, иначе события после полуночи уезжали бы вперёд на сутки.
 */
function timestampOf(stamp, fallbackTs) {
  const long = stamp.match(/^(\d+)\/(\d+)\/(\d+),\s*(\d+):(\d+):(\d+)$/);
  if (long) {
    return Date.UTC(Number(long[1]), Number(long[2]) - 1, Number(long[3]), Number(long[4]), Number(long[5]), Number(long[6]));
  }

  const short = stamp.match(/^(\d+):(\d+):(\d+)$/);
  if (!short) return fallbackTs;

  const now = new Date(fallbackTs);
  let ts = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    Number(short[1]),
    Number(short[2]),
    Number(short[3])
  );

  if (ts - fallbackTs > 60_000) ts -= 24 * 3600 * 1000;
  return ts;
}

/* ------------------------------------------------------------------ чтение */

function readState() {
  try {
    const stored = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (stored && typeof stored === 'object') offsets = stored;
  } catch (_) {
    offsets = {};
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(offsets, null, 2), 'utf8');
  } catch (err) {
    logger.warn(SOURCE, `Не удалось запомнить место чтения админ-логов: ${err.message}`);
  }
}

/** Ближайшее начало строки после offset — иначе разберём половину записи. */
function nextLineStart(file, offset, size) {
  const length = Math.min(4096, size - offset);
  if (length <= 0) return offset;

  try {
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, offset);
    fs.closeSync(handle);

    const at = buffer.indexOf(0x0a);
    return at < 0 ? offset : offset + at + 1;
  } catch (_) {
    return offset;
  }
}

function tail(serverId) {
  const file = newestLog(serverId);
  if (!file) return 0;

  let size;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    return 0;
  }

  const state = offsets[serverId] || {};
  let offset = state.file === file ? Number(state.offset) || 0 : -1;

  /*
   * Файл видим впервые. Начинать с конца нельзя: журнал остался бы пустым до
   * первого нового действия админа, и выглядело бы это как «ничего не работает».
   * Поэтому подхватываем хвост — последние FIRST_READ_BYTES, этого хватает на
   * несколько сотен последних действий, а всю историю сервера не тянем.
   */
  if (offset < 0) offset = Math.max(0, size - FIRST_READ_BYTES);

  // Файл укоротился (пересоздали с тем же именем) — читаем с начала.
  if (offset > size) offset = 0;

  // С середины строки начинать нельзя: сдвигаемся к началу следующей.
  if (offset > 0 && state.file !== file) offset = nextLineStart(file, offset, size);

  if (offset >= size) {
    offsets[serverId] = { file, offset: size };
    return 0;
  }

  const length = Math.min(size - offset, MAX_CHUNK);
  let text = '';
  try {
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, offset);
    fs.closeSync(handle);
    text = buffer.toString('utf8');
  } catch (err) {
    logger.warn(SOURCE, `Не читается ${path.basename(file)}: ${err.message}`, { serverId });
    return 0;
  }

  // Последняя строка может быть недописана — оставляем её на следующий раз.
  const lines = text.split(/\r?\n/);
  const tailPart = lines.pop() || '';
  const consumed = length - Buffer.byteLength(tailPart, 'utf8');

  offsets[serverId] = { file, offset: offset + consumed };

  const now = Date.now();
  const events = [];
  for (const line of lines) {
    const event = parseLine(line, now);
    if (event) events.push(event);
  }

  if (events.length) eventlog.append(serverId, events);
  return events.length;
}

function tick() {
  let total = 0;
  for (const server of config.servers()) {
    try {
      total += tail(server.id);
    } catch (err) {
      logger.warn(SOURCE, `Ошибка чтения админ-логов: ${err.message}`, { serverId: server.id });
    }
  }
  if (total) saveState();
}

/* ------------------------------------------------ действия самой панели */

/**
 * Записать в журнал действие, сделанное через панель.
 *
 * Вызывается из маршрутов: у панели нет своего игрового «кто», поэтому админом
 * считается сама панель, а в data.source стоит «panel» — в журнале видно, что
 * сделано отсюда, а не из игры.
 */
function note(serverId, action, text, extra = {}) {
  if (!serverId) return;

  eventlog.append(serverId, [
    {
      ts: Date.now(),
      type: 'admin',
      player: { id: '', name: extra.by || 'панель' },
      target: extra.target || null,
      pos: extra.pos || null,
      data: { source: 'panel', action, text, ...(extra.data || {}) }
    }
  ]);
}

/* ------------------------------------------------------------------ статус */

function status(serverId) {
  const dir = loggingDir(serverId);
  const profile = config.profilesPath(config.active(serverId));
  const list = findLogs(serverId);
  const state = offsets[serverId] || {};

  return {
    dir,
    profile,
    installed: list.length > 0,
    file: list.length ? path.basename(list[0].file) : '',
    path: list.length ? list[0].file : '',
    offset: Number(state.offset) || 0,
    // Все найденные файлы: по ним видно, туда ли смотрит панель.
    found: list.slice(0, 10).map((item) => ({
      file: item.file,
      size: item.size,
      changedAt: Math.round(item.mtime)
    })),
    reason: list.length
      ? ''
      : `логи VPPAdminTools не найдены. Панель искала файлы Log_*.txt в папках с «VPP» внутри ${profile} ` +
        '(до 4 уровней). Проверьте, что путь к профилю в настройках сервера совпадает с -profiles= в строке запуска'
  };
}

/** Забыть место чтения и перечитать хвост логов заново. */
function rescan(serverId) {
  delete offsets[serverId];
  const added = tail(serverId);
  saveState();

  logger.info(SOURCE, `Перечитал админ-логи: добавлено событий ${added}`, { serverId });
  return { added, ...status(serverId) };
}

function start() {
  if (timer) return;
  readState();

  timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref();
  tick();

  for (const server of config.servers()) {
    const st = status(server.id);
    if (st.installed) logger.info(SOURCE, `Читаю админ-логи VPPAdminTools: ${st.dir}`, { serverId: server.id });
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  saveState();
}

module.exports = { start, stop, status, rescan, findLogs, note, parseLine, actionOf, phraseOf, timestampOf };
