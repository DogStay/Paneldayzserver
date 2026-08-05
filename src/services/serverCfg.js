'use strict';

/**
 * Чтение и точечная правка serverDZ.cfg.
 *
 * Панель синхронизирует в конфиг сервера только те значения, которые
 * редактируются в интерфейсе (название, пароли, слоты, query-порт, время,
 * карта). Всё остальное содержимое файла остаётся нетронутым — можно смело
 * править .cfg руками.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');

const SOURCE = 'servercfg';

/** Карты, доступные в мастере создания сервера. */
const MISSIONS = [
  { value: 'dayzOffline.chernarusplus', label: 'Chernarus+ (Черноруссия)' },
  { value: 'dayzOffline.enoch', label: 'Livonia (Ливония)' },
  { value: 'dayzOffline.sakhal', label: 'Sakhal (Сахал)' }
];

function template(v) {
  return `// serverDZ.cfg — создан панелью DayZ Panel
hostname = "${v.server.name}";            // Название сервера в браузере
password = "${v.server.password}";        // Пароль на вход (пусто — открытый сервер)
passwordAdmin = "${v.server.adminPassword}"; // Пароль администратора
maxPlayers = ${v.server.maxPlayers};      // Максимум игроков

verifySignatures = ${v.server.verifySignatures}; // Проверка подписей модов
forceSameBuild = 1;
disableVoN = ${v.server.disableVoN};
vonCodecQuality = 20;
disable3rdPerson = ${v.server.disable3rdPerson};
disableCrosshair = 0;

serverTime = "SystemTime";
serverTimeAcceleration = ${v.server.timeAcceleration};
serverNightTimeAcceleration = ${v.server.nightTimeAcceleration};
serverTimePersistent = ${v.server.timePersistent};  // 1 — время продолжается после перезапуска

guaranteedUpdates = 1;
loginQueueConcurrentPlayers = 5;
loginQueueMaxPlayers = 500;
instanceId = 1;
storageAutoFix = 1;

steamQueryPort = ${v.server.steamQueryPort};  // Порт Steam-запросов

class Missions
{
    class DayZ
    {
        template="${v.server.mission}";
    };
};
`;
}

function read(serverId) {
  const v = config.active(serverId);
  const file = config.serverCfgPath(v);
  if (!fs.existsSync(file)) return { path: file, exists: false, content: '' };
  return { path: file, exists: true, content: fs.readFileSync(file, 'utf8') };
}

function write(content, serverId) {
  const file = config.serverCfgPath(config.active(serverId));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  logger.info(SOURCE, `Сохранён ${file}`);
  return { path: file };
}

/** Создать файл из шаблона, если его нет. */
function ensureExists(serverId) {
  const v = config.active(serverId);
  const file = config.serverCfgPath(v);
  if (fs.existsSync(file)) return { path: file, created: false };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, template(v), 'utf8');
  logger.info(SOURCE, `Создан ${file}`);
  return { path: file, created: true };
}

/** Заменить значение ключа верхнего уровня; если ключа нет — добавить в начало. */
function setValue(content, key, value, quoted) {
  const rendered = quoted ? `"${String(value).replace(/"/g, '')}"` : String(value);
  const re = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)([^;\\r\\n]*)(;.*)$`, 'mi');

  if (re.test(content)) return content.replace(re, (_m, head, _old, tail) => `${head}${rendered}${tail}`);
  return `${key} = ${rendered};\n${content}`;
}

/** Заменить template="…" внутри class Missions. */
function setMission(content, mission) {
  const re = /(template\s*=\s*")([^"]*)(")/i;
  if (re.test(content)) return content.replace(re, (_m, a, _old, c) => `${a}${mission}${c}`);
  return `${content}\n\nclass Missions\n{\n    class DayZ\n    {\n        template="${mission}";\n    };\n};\n`;
}

/**
 * Синхронизировать serverDZ.cfg с настройками панели.
 * @returns {{path: string, changed: boolean, applied: object}}
 */
function sync(serverId) {
  const v = config.active(serverId);
  ensureExists(serverId);

  const file = config.serverCfgPath(v);
  const original = fs.readFileSync(file, 'utf8');
  let content = original;

  content = setValue(content, 'hostname', v.server.name, true);
  content = setValue(content, 'password', v.server.password, true);
  content = setValue(content, 'passwordAdmin', v.server.adminPassword, true);
  content = setValue(content, 'maxPlayers', v.server.maxPlayers, false);
  content = setValue(content, 'steamQueryPort', v.server.steamQueryPort, false);
  content = setValue(content, 'verifySignatures', v.server.verifySignatures, false);
  content = setValue(content, 'disable3rdPerson', v.server.disable3rdPerson, false);
  content = setValue(content, 'disableVoN', v.server.disableVoN, false);
  content = setValue(content, 'serverTimeAcceleration', v.server.timeAcceleration, false);
  content = setValue(content, 'serverNightTimeAcceleration', v.server.nightTimeAcceleration, false);
  content = setValue(content, 'serverTimePersistent', v.server.timePersistent, false);
  content = setMission(content, v.server.mission);

  const changed = content !== original;
  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
    logger.info(
      SOURCE,
      `serverDZ.cfg обновлён: hostname="${v.server.name}", maxPlayers=${v.server.maxPlayers}, ` +
        `steamQueryPort=${v.server.steamQueryPort}, карта=${v.server.mission}`
    );
  }

  return {
    path: file,
    changed,
    applied: {
      hostname: v.server.name,
      maxPlayers: v.server.maxPlayers,
      steamQueryPort: v.server.steamQueryPort,
      mission: v.server.mission,
      timePersistent: v.server.timePersistent
    }
  };
}

module.exports = { read, write, sync, ensureExists, template, MISSIONS };
