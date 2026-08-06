'use strict';

/**
 * BattlEye RCon — бесплатный канал сообщений в игру.
 *
 * У CFTools отправка сообщений в игру доступна только на платной подписке, а
 * BattlEye слушает RCon-порт на любом сервере DayZ: именно так работают BEC и
 * другие привычные админам инструменты. Панель пользуется этим для
 * предупреждений о перезапуске и объявлений в чат.
 *
 * Пароль и порт панель берёт из настроек BattlEye самого сервера
 * (`<сервер>\battleye\beserver_x64.cfg` или созданного сервером
 * `beserver_x64_active_*.cfg`), поэтому в обычном случае настраивать ничего не
 * нужно — достаточно, чтобы файл существовал. Если его нет, панель умеет
 * создать его сама с надёжным паролем.
 *
 * Важно про пароль: BattlEye блокирует IP после нескольких неудачных входов,
 * поэтому при отказе по паролю панель прекращает попытки до того, как
 * настройки изменятся или админ нажмёт «Проверить связь».
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const logger = require('../logger');
const bercon = require('../util/bercon');

const SOURCE = 'battleye';

/** Порт RCon по умолчанию для DayZ, если в конфиге BattlEye он не указан. */
const DEFAULT_RCON_PORT = 2306;

/** Длина сообщения `say`, после которой чат в игре начинает обрезать текст. */
const MAX_LENGTH = 200;

/** serverId -> Promise: запросы к одному серверу идут по одному. */
const queues = new Map();

/** serverId -> сообщение о неверном пароле; пока стоит, попыток не делаем. */
const blocked = new Map();

/* ------------------------------------------------------- конфиг BattlEye */

/** Папки, где может лежать конфиг BattlEye. */
function configDirs(v) {
  const dirs = [];
  const explicit = v.ingame.battleye.configPath;
  if (explicit) dirs.push(explicit);
  if (v.paths.serverPath) dirs.push(path.join(v.paths.serverPath, 'battleye'));

  // При -profiles= BattlEye иногда кладёт свои файлы рядом с профилями.
  try {
    dirs.push(path.join(config.profilesPath(v), 'battleye'));
  } catch (_) {
    /* пути может не быть */
  }

  return [...new Set(dirs)].filter(Boolean);
}

/**
 * Найти файл настроек BattlEye.
 *
 * Приоритет у `beserver_x64_active_*.cfg`: этот файл создаёт сам сервер при
 * запуске, и в нём лежит пароль, который действует прямо сейчас. Правка
 * `beserver_x64.cfg` без перезапуска сервера на работающий RCon не влияет.
 */
function findConfigFile(v) {
  const candidates = [];

  for (const dir of configDirs(v)) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }

    for (const name of entries) {
      if (!/^beserver.*\.cfg$/i.test(name)) continue;
      const full = path.join(dir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch (_) {
        continue;
      }
      candidates.push({ path: full, active: /active/i.test(name), mtime });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : b.mtime - a.mtime));
  return candidates[0];
}

/** Разобрать `RConPassword` / `RConPort` из файла настроек BattlEye. */
function readConfigFile(file) {
  const out = { password: '', port: 0, restrictRCon: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return out;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;

    const m = line.match(/^(\w+)\s+(.+)$/);
    if (!m) continue;

    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'rconpassword') out.password = value;
    if (key === 'rconport') out.port = parseInt(value, 10) || 0;
    if (key === 'restrictrcon') out.restrictRCon = parseInt(value, 10);
  }
  return out;
}

/**
 * Итоговые параметры подключения: что задано в панели, дополненное файлом
 * настроек BattlEye.
 */
function resolve(serverId) {
  const v = config.active(serverId);
  const be = v.ingame.battleye;
  const file = findConfigFile(v);
  const fromFile = file ? readConfigFile(file.path) : { password: '', port: 0, restrictRCon: null };

  return {
    host: be.host || '127.0.0.1',
    port: be.port || fromFile.port || DEFAULT_RCON_PORT,
    password: be.password || fromFile.password || '',
    encoding: be.encoding === 'cp1251' ? 'cp1251' : 'utf8',
    passwordFrom: be.password ? 'настройки панели' : fromFile.password ? 'файл BattlEye' : '',
    portFrom: be.port ? 'настройки панели' : fromFile.port ? 'файл BattlEye' : 'по умолчанию',
    configFile: file ? file.path : '',
    configIsActive: file ? file.active : false,
    restrictRCon: fromFile.restrictRCon,
    serverName: v.name,
    serverId: v.id
  };
}

/** Состояние канала без обращения к сети — для интерфейса и проверок. */
function status(serverId) {
  let info;
  try {
    info = resolve(serverId);
  } catch (err) {
    return { ready: false, reason: err.message };
  }

  const problem = blocked.get(serverId);
  return {
    host: info.host,
    port: info.port,
    portFrom: info.portFrom,
    hasPassword: Boolean(info.password),
    passwordFrom: info.passwordFrom,
    configFile: info.configFile,
    configIsActive: info.configIsActive,
    encoding: info.encoding,
    maxLength: MAX_LENGTH,
    blocked: problem || null,
    ready: Boolean(info.password) && !problem,
    reason: problem
      ? problem
      : info.password
        ? ''
        : info.configFile
          ? `в ${path.basename(info.configFile)} нет строки RConPassword`
          : 'не найден файл настроек BattlEye (beserver_x64.cfg) — нажмите «Настроить BattlEye»'
  };
}

/* --------------------------------------------------------- создание конфига */

/**
 * Создать `battleye\beserver_x64.cfg` с паролем RCon.
 *
 * Без этого файла BattlEye не открывает RCon вообще, и это самая частая
 * причина, по которой «в чат ничего не приходит». Существующий файл панель не
 * трогает, если явно не попросили перезаписать.
 *
 * @param {string} serverId
 * @param {{force?: boolean, password?: string, port?: number}} [opts]
 */
function setupConfig(serverId, opts = {}) {
  const v = config.active(serverId);
  if (!v.paths.serverPath || !fs.existsSync(v.paths.serverPath)) {
    throw new Error(`Папка сервера не найдена: ${v.paths.serverPath || 'путь не задан'}`);
  }

  const existing = findConfigFile(v);
  if (existing && !opts.force) {
    return {
      created: false,
      path: existing.path,
      message: `Файл настроек BattlEye уже есть: ${existing.path}`
    };
  }

  const dir = path.join(v.paths.serverPath, 'battleye');
  const file = path.join(dir, 'beserver_x64.cfg');
  const password = String(opts.password || '').trim() || crypto.randomBytes(9).toString('base64url');
  const port = parseInt(opts.port, 10) || v.ingame.battleye.port || DEFAULT_RCON_PORT;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    [
      'RConPassword ' + password,
      'RConPort ' + port,
      // 0 — разрешены все RCon-команды с локальной машины. Панель обращается
      // к BattlEye с 127.0.0.1, наружу порт открывать не нужно.
      'RestrictRCon 0',
      ''
    ].join('\r\n'),
    'utf8'
  );

  blocked.delete(serverId);
  logger.info(SOURCE, `Создан ${file} (RConPort ${port})`, { serverId });

  return {
    created: true,
    path: file,
    port,
    password,
    message:
      'Файл создан. BattlEye читает его при запуске сервера — чтобы RCon заработал, ' +
      'перезапустите сервер.'
  };
}

/* ------------------------------------------------------------------ запросы */

/** Запросы к одному серверу выполняются строго по очереди. */
function schedule(serverId, fn) {
  const previous = queues.get(serverId) || Promise.resolve();
  const run = previous.then(fn, fn);
  queues.set(
    serverId,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

/**
 * Выполнить RCon-команду.
 * @param {string} serverId
 * @param {string} command например `say -1 привет` или `players`
 * @returns {Promise<string>} ответ сервера
 */
function command(serverId, line) {
  return schedule(serverId, async () => {
    const problem = blocked.get(serverId);
    if (problem) throw new Error(problem);

    const info = resolve(serverId);
    if (!info.password) {
      throw new Error(status(serverId).reason || 'не настроен пароль RCon BattlEye');
    }

    try {
      return await bercon.withConnection(
        { host: info.host, port: info.port, password: info.password, encoding: info.encoding },
        (send) => send(line)
      );
    } catch (err) {
      if (err.code === 'bad-password') {
        // Повторные попытки с неверным паролем BattlEye воспринимает как
        // атаку и блокирует IP, поэтому останавливаемся до правки настроек.
        const message =
          `BattlEye отклонил пароль RCon (${info.host}:${info.port}, источник пароля: ` +
          `${info.passwordFrom || 'неизвестен'}). Попытки прекращены, чтобы BattlEye не заблокировал панель ` +
          'по IP: проверьте RConPassword и нажмите «Проверить связь».';
        blocked.set(serverId, message);
        logger.error(SOURCE, message, { serverId });
        throw new Error(message);
      }
      throw err;
    }
  });
}

/** Сообщение всем игрокам в чат. */
async function say(serverId, text) {
  const message = String(text || '').trim();
  if (!message) throw new Error('Пустое сообщение');
  if (message.includes('\n')) throw new Error('BattlEye отправляет сообщение одной строкой');
  if (message.length > MAX_LENGTH) {
    throw new Error(`Сообщение длиннее ${MAX_LENGTH} символов (${message.length}) — в чате оно обрежется`);
  }

  // -1 — всем игрокам сразу; номер игрока — личное сообщение.
  await command(serverId, `say -1 ${message}`);
  return { sent: true, text: message };
}

/**
 * Игроки онлайн по данным BattlEye.
 * Формат вывода `players`:
 *   0   192.168.0.10:2304   31   abcdef…(OK) Имя игрока
 */
async function players(serverId) {
  const output = await command(serverId, 'players');
  const list = [];

  for (const raw of String(output).split(/\r?\n/)) {
    const m = raw.match(/^(\d+)\s+([\d.]+):(\d+)\s+(-?\d+)\s+([0-9a-f]+)\((\w+)\)\s*(.*)$/i);
    if (!m) continue;

    list.push({
      number: Number(m[1]),
      ip: m[2],
      port: Number(m[3]),
      ping: Number(m[4]),
      guid: m[5],
      guidStatus: m[6],
      name: (m[7] || '').replace(/\s*\(Lobby\)\s*$/i, '').trim(),
      inLobby: /\(Lobby\)/i.test(m[7] || '')
    });
  }

  return { players: list, raw: String(output) };
}

/** Выкинуть игрока по номеру из списка `players`. */
async function kick(serverId, number, reason) {
  const index = parseInt(number, 10);
  if (!Number.isFinite(index)) throw new Error('Не указан номер игрока из списка BattlEye');
  await command(serverId, `kick ${index} ${String(reason || 'Kicked by admin').slice(0, 128)}`);
  return { ok: true };
}

/**
 * Проверка связи: вход по паролю и запрос списка игроков.
 * Снимает блокировку по неверному паролю — админ сознательно пробует снова.
 */
async function test(serverId) {
  blocked.delete(serverId);

  const info = resolve(serverId);
  const result = await players(serverId);

  logger.info(
    SOURCE,
    `«${info.serverName}»: RCon отвечает (${info.host}:${info.port}), игроков онлайн: ${result.players.length}`,
    { serverId }
  );

  return {
    ok: true,
    host: info.host,
    port: info.port,
    portFrom: info.portFrom,
    passwordFrom: info.passwordFrom,
    configFile: info.configFile,
    playersOnline: result.players.length,
    players: result.players
  };
}

/** Забыть блокировку по неверному паролю (например, настройки изменились). */
function resetBlocked(serverId) {
  if (serverId) blocked.delete(serverId);
  else blocked.clear();
}

module.exports = {
  status,
  resolve,
  setupConfig,
  command,
  say,
  players,
  kick,
  test,
  resetBlocked,
  findConfigFile,
  readConfigFile,
  MAX_LENGTH,
  DEFAULT_RCON_PORT
};
