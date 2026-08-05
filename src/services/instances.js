'use strict';

/**
 * Создание и удаление серверов панели.
 *
 * «Создать сервер» в интерфейсе — это два шага:
 *   1. create()  — запись о сервере появляется в конфиге (мгновенно);
 *   2. install() — SteamCMD скачивает файлы DayZ-сервера в указанную папку,
 *      создаётся serverDZ.cfg и .bat запуска (длительная операция с прогрессом).
 *
 * Такое разделение позволяет переустановить/дозакачать сервер позже, не
 * создавая его заново.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');
const steamcmd = require('./steamcmd');
const serverCfg = require('./serverCfg');
const batgen = require('./batgen');

const SOURCE = 'install';

/* ------------------------------------------------------------- подсказки */

/** Свободный игровой порт для нового сервера (2302, 2402, 2502, …). */
function suggestPorts() {
  const used = new Set();
  for (const s of config.servers()) {
    used.add(s.server.gamePort);
    used.add(s.server.steamQueryPort);
  }
  let gamePort = 2302;
  while (used.has(gamePort)) gamePort += 100;

  let steamQueryPort = 27016;
  while (used.has(steamQueryPort)) steamQueryPort += 1;

  return { gamePort, steamQueryPort };
}

/** Путь установки по умолчанию — рядом с уже существующими серверами. */
function suggestPath(name) {
  const servers = config.servers();
  const base = servers.length && servers[0].paths.serverPath
    ? path.dirname(servers[0].paths.serverPath)
    : process.platform === 'win32'
      ? 'C:\\DayZServers'
      : path.join(process.env.HOME || '/opt', 'dayz-servers');

  return path.join(base, safeFolder(name || 'DayZServer'));
}

const safeFolder = (value) =>
  String(value)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 40) || 'DayZServer';

/* ----------------------------------------------------------------- создание */

/**
 * Создать запись о сервере (файлы ещё не скачиваются).
 * @param {object} input данные из мастера
 */
function create(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Укажите название сервера');

  const serverPath = String(input.serverPath || '').trim() || suggestPath(name);
  const ports = suggestPorts();
  const gamePort = toInt(input.gamePort, ports.gamePort);
  const steamQueryPort = toInt(input.steamQueryPort, ports.steamQueryPort);

  for (const other of config.servers()) {
    if (other.server.gamePort === gamePort) {
      throw new Error(`Игровой порт ${gamePort} уже занят сервером «${other.name}»`);
    }
    if (other.server.steamQueryPort === steamQueryPort) {
      throw new Error(`Query-порт ${steamQueryPort} уже занят сервером «${other.name}»`);
    }
    if (path.resolve(other.paths.serverPath || '') === path.resolve(serverPath)) {
      throw new Error(`Папка ${serverPath} уже используется сервером «${other.name}»`);
    }
  }

  const instance = config.addServer({
    name,
    createdAt: new Date().toISOString(),
    installed: false,
    paths: { serverPath },
    server: {
      name,
      password: String(input.password || ''),
      adminPassword: String(input.adminPassword || ''),
      maxPlayers: toInt(input.maxPlayers, 60),
      gamePort,
      steamQueryPort,
      mission: input.mission || 'dayzOffline.chernarusplus',
      timeAcceleration: input.timeAcceleration ?? 12,
      nightTimeAcceleration: input.nightTimeAcceleration ?? 1,
      disable3rdPerson: input.disable3rdPerson ? 1 : 0,
      verifySignatures: input.verifySignatures === 0 ? 0 : 2,
      extraPorts: buildExtraPorts(gamePort, steamQueryPort)
    }
  });

  logger.info(SOURCE, `Создан сервер «${name}» → ${serverPath} (порт ${gamePort})`);
  return instance;
}

/** Соседние служебные порты считаем от игрового — так они не конфликтуют между серверами. */
function buildExtraPorts(gamePort, steamQueryPort) {
  return [
    { protocol: 'UDP', from: gamePort + 1, to: gamePort + 3, comment: 'Голосовой чат и служебные порты DayZ' },
    { protocol: 'UDP', from: 8766, to: 8766, comment: 'Steam master' },
    { protocol: 'TCP', from: steamQueryPort, to: steamQueryPort, comment: 'Steam query TCP' }
  ];
}

/* --------------------------------------------------------------- установка */

/**
 * Скачать файлы сервера через SteamCMD и подготовить его к запуску.
 * @param {string} serverId
 * @param {{onProgress?: (p: {percent: number, step: string}) => void, validate?: boolean}} [opts]
 */
async function install(serverId, opts = {}) {
  const server = config.getServer(serverId);
  if (!server) throw new Error(`Сервер ${serverId} не найден`);

  const v = config.active(serverId);
  const target = v.paths.serverPath;
  const notify = (percent, step) => opts.onProgress && opts.onProgress({ percent, step });

  if (!v.paths.steamcmdExe || !fs.existsSync(v.paths.steamcmdExe)) {
    throw new Error(
      `steamcmd.exe не найден (${v.paths.steamcmdExe || 'путь не задан'}). ` +
        'Укажите путь к SteamCMD в настройках панели.'
    );
  }
  if (!target) throw new Error('Не указана папка установки сервера');

  logger.info(SOURCE, `Установка файлов сервера «${server.name}» в ${target}`);
  notify(2, 'Проверяю папку установки');

  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`Нет доступа на запись в ${target}: ${err.message}`);
  }

  notify(5, 'SteamCMD скачивает файлы сервера DayZ');
  await steamcmd.installServerApp(target, {
    validate: opts.validate !== false,
    onProgress: (p) => {
      if (p.percent === null) return notify(null, p.phase);
      notify(5 + p.percent * 0.85, `${p.phase}: ${Math.round(p.percent)}%`);
    }
  });

  const exe = config.serverExePath(config.active(serverId));
  if (!fs.existsSync(exe)) {
    throw new Error(
      `SteamCMD отработал, но ${path.basename(exe)} не появился в ${target}. ` +
        'Проверьте лог SteamCMD выше — чаще всего это неверный аккаунт Steam или нехватка места.'
    );
  }

  notify(92, 'Создаю serverDZ.cfg');
  serverCfg.ensureExists(serverId);
  serverCfg.sync(serverId);

  notify(96, 'Генерирую .bat запуска');
  try {
    batgen.generate(config.active(serverId));
  } catch (err) {
    logger.warn(SOURCE, `.bat не сгенерирован: ${err.message}`);
  }

  const updated = config.updateServer(serverId, { installed: true });
  notify(100, 'Сервер установлен');
  logger.info(SOURCE, `Сервер «${server.name}» готов к запуску`);

  return updated;
}

/* ----------------------------------------------------------------- удаление */

/**
 * Удалить сервер из панели.
 * @param {string} serverId
 * @param {{deleteFiles?: boolean}} [opts]
 */
function remove(serverId, opts = {}) {
  const server = config.getServer(serverId);
  if (!server) throw new Error(`Сервер ${serverId} не найден`);

  const serverPath = server.paths.serverPath;
  const removed = config.removeServer(serverId);

  if (opts.deleteFiles && serverPath && fs.existsSync(serverPath)) {
    try {
      fs.rmSync(serverPath, { recursive: true, force: true });
      logger.warn(SOURCE, `Удалена папка сервера: ${serverPath}`);
    } catch (err) {
      logger.error(SOURCE, `Не удалось удалить ${serverPath}: ${err.message}`);
    }
  }

  logger.info(SOURCE, `Сервер «${server.name}» удалён из панели`);
  return removed;
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { create, install, remove, suggestPorts, suggestPath, safeFolder };
