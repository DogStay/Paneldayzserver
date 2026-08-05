'use strict';

/**
 * Чтение и точечная правка serverDZ.cfg.
 *
 * Панель синхронизирует в конфиг сервера только те значения, которые
 * редактируются в интерфейсе: hostname, maxPlayers и steamQueryPort
 * (последний нельзя задать аргументом командной строки — только в .cfg).
 * Остальное содержимое файла не трогается.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');

const SOURCE = 'servercfg';

const TEMPLATE = `hostname = "My DayZ Server";      // Название сервера в браузере
password = "";                     // Пароль на вход (пусто — открытый сервер)
passwordAdmin = "";                // Пароль администратора
maxPlayers = 60;                   // Максимум игроков
verifySignatures = 2;              // Проверка подписей модов
forceSameBuild = 1;
disableVoN = 0;
vonCodecQuality = 20;
disable3rdPerson = 0;
disableCrosshair = 0;
serverTime = "SystemTime";
serverTimeAcceleration = 12;
serverNightTimeAcceleration = 1;
serverTimePersistent = 0;
guaranteedUpdates = 1;
loginQueueConcurrentPlayers = 5;
loginQueueMaxPlayers = 500;
instanceId = 1;
storageAutoFix = 1;
steamQueryPort = 27016;            // Порт Steam-запросов

class Missions
{
    class DayZ
    {
        template="dayzOffline.chernarusplus";
    };
};
`;

function read() {
  const file = config.serverCfgPath();
  if (!fs.existsSync(file)) return { path: file, exists: false, content: '' };
  return { path: file, exists: true, content: fs.readFileSync(file, 'utf8') };
}

function write(content) {
  const file = config.serverCfgPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  logger.info(SOURCE, `Сохранён ${file}`);
  return { path: file };
}

/** Создать файл из шаблона, если его нет. */
function ensureExists() {
  const file = config.serverCfgPath();
  if (fs.existsSync(file)) return { path: file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TEMPLATE, 'utf8');
  logger.warn(SOURCE, `serverDZ.cfg отсутствовал — создан шаблон: ${file}`);
  return { path: file, created: true };
}

/** Заменить значение ключа верхнего уровня; если ключа нет — добавить в начало. */
function setValue(content, key, value, quoted) {
  const rendered = quoted ? `"${String(value).replace(/"/g, '')}"` : String(value);
  const re = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)([^;\\r\\n]*)(;.*)$`, 'mi');

  if (re.test(content)) {
    return content.replace(re, (_m, head, _old, tail) => `${head}${rendered}${tail}`);
  }
  return `${key} = ${rendered};\n${content}`;
}

/**
 * Синхронизировать serverDZ.cfg с настройками панели.
 * @returns {{path: string, changed: boolean, applied: object}}
 */
function sync() {
  const cfg = config.load();
  ensureExists();

  const file = config.serverCfgPath();
  const original = fs.readFileSync(file, 'utf8');
  let content = original;

  content = setValue(content, 'hostname', cfg.server.name, true);
  content = setValue(content, 'maxPlayers', cfg.server.maxPlayers, false);
  content = setValue(content, 'steamQueryPort', cfg.server.steamQueryPort, false);

  const changed = content !== original;
  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
    logger.info(
      SOURCE,
      `serverDZ.cfg обновлён: hostname="${cfg.server.name}", maxPlayers=${cfg.server.maxPlayers}, ` +
        `steamQueryPort=${cfg.server.steamQueryPort}`
    );
  }

  return {
    path: file,
    changed,
    applied: {
      hostname: cfg.server.name,
      maxPlayers: cfg.server.maxPlayers,
      steamQueryPort: cfg.server.steamQueryPort
    }
  };
}

module.exports = { read, write, sync, ensureExists, TEMPLATE };
