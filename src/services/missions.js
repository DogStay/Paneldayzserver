'use strict';

/**
 * Карта сервера = миссия из mpmissions.
 *
 * Движок DayZ не знает слова «карта»: он читает из serverDZ.cfg строку
 * template="dayzOffline.chernarusplus" и запускает миссию с таким именем из
 * папки <сервер>/mpmissions. Поэтому «выбрать карту» — это выбрать одну из
 * миссий, которые реально лежат на диске: ванильные Черноруссия, Ливония и
 * Сахал, а вместе с модами — Namalsk, DeerIsle, Banov и любые свои сборки
 * («hardcore.chernarusplus», «empty.enoch» и прочие).
 *
 * Панель не придумывает список из головы, а сканирует mpmissions выбранного
 * сервера: у каждого сервера своя папка, а значит и свой набор карт.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');
const serverCfg = require('./serverCfg');

const SOURCE = 'missions';

/** Папка с миссиями внутри каталога сервера. */
const MISSIONS_FOLDER = 'mpmissions';

/**
 * Названия карт по имени мира (часть имени миссии после последней точки).
 * Список подсказочный: неизвестную карту панель всё равно покажет — просто
 * подпишет её именем папки.
 */
const MAP_LABELS = {
  chernarusplus: 'Chernarus+ (Черноруссия)',
  enoch: 'Livonia (Ливония)',
  sakhal: 'Sakhal (Сахал)',
  chernarus: 'Chernarus (старая, без Live)',
  namalsk: 'Namalsk (мод)',
  deerisle: 'DeerIsle (мод)',
  banov: 'Banov (мод)',
  esseker: 'Esseker (мод)',
  chiemsee: 'Chiemsee (мод)',
  takistanplus: 'Takistan+ (мод)',
  valning: 'Valning (мод)',
  rostow: 'Rostow (мод)',
  pripyat: 'Pripyat (мод)',
  alteria: 'Alteria (мод)',
  swansisland: "Swan's Island (мод)"
};

/** Карты из самой игры — они появляются сразу после установки файлов сервера. */
const VANILLA_MAPS = new Set(['chernarusplus', 'enoch', 'sakhal']);

/**
 * Список для мастера создания сервера: файлов на диске ещё нет, а карту
 * выбрать уже нужно. После установки сервера список берётся из mpmissions.
 */
function catalogue() {
  return [...VANILLA_MAPS].map((map) => ({
    value: `dayzOffline.${map}`,
    label: MAP_LABELS[map] || map
  }));
}

/* ------------------------------------------------------------------ разбор имени */

/** Папка с миссиями конкретного сервера. */
function missionsDir(v = config.active()) {
  return v.paths.serverPath ? path.join(v.paths.serverPath, MISSIONS_FOLDER) : '';
}

/** «hardcore.chernarusplus» -> { prefix: 'hardcore', map: 'chernarusplus' }. */
function parseFolder(folder) {
  const name = String(folder || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { prefix: name, map: '' };
  return { prefix: name.slice(0, dot), map: name.slice(dot + 1).toLowerCase() };
}

/**
 * Человеческое название миссии.
 *
 * Стандартный префикс dayzOffline ничего не говорит игроку, поэтому его не
 * показываем; любой другой («hardcore», «empty», своя сборка) наоборот важен —
 * это разные наборы лута на одной и той же карте.
 */
function labelFor(folder) {
  const { prefix, map } = parseFolder(folder);
  const mapLabel = MAP_LABELS[map] || (map ? map : folder);
  return prefix && prefix.toLowerCase() !== 'dayzoffline' ? `${mapLabel} — ${prefix}` : mapLabel;
}

/**
 * Имя миссии, пригодное для записи в serverDZ.cfg.
 * Внутрь template="…" попадает только имя папки — ни путей, ни кавычек.
 */
function sanitize(value) {
  let text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  // Путь вида «C:\...\mpmissions\dayzOffline.enoch» или «mpmissions/empty.enoch»
  // приводим к имени последней папки — так можно вставлять путь из проводника.
  text = text.replace(/[\\/]+$/, '');
  const lastSep = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  if (lastSep >= 0) text = text.slice(lastSep + 1);

  if (!text) throw new Error('Не указано имя миссии');
  if (text === '.' || text === '..') throw new Error(`Некорректное имя миссии: ${value}`);
  if (/["*?<>|:]/.test(text)) throw new Error(`В имени миссии недопустимые символы: ${text}`);

  return text;
}

/* --------------------------------------------------------------- сканирование */

/** Похоже ли содержимое папки на миссию DayZ. */
function describe(folder, dir) {
  const full = path.join(dir, folder);
  const { prefix, map } = parseFolder(folder);
  const has = (name) => fs.existsSync(path.join(full, name));

  return {
    folder,
    label: labelFor(folder),
    map,
    mapLabel: MAP_LABELS[map] || map || folder,
    prefix,
    path: full,
    exists: true,
    vanilla: VANILLA_MAPS.has(map),
    // init.c — обязательный скрипт миссии; без него сервер не стартует.
    hasInit: has('init.c'),
    hasEconomy: has('cfgeconomycore.xml'),
    // Папка storage_* появляется после первого запуска: в ней лежит мир игроков.
    hasStorage: safeReaddir(full).some((name) => /^storage_/i.test(name))
  };
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

/** Миссии, реально лежащие в mpmissions сервера. */
function scan(v = config.active()) {
  const dir = missionsDir(v);
  if (!dir || !fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map((entry) => describe(entry.name, dir))
    .sort((a, b) => {
      // Сначала ванильные карты, потом моды и свои сборки — в алфавитном порядке.
      if (a.vanilla !== b.vanilla) return a.vanilla ? -1 : 1;
      return a.label.localeCompare(b.label, 'ru');
    });
}

/**
 * Список карт для интерфейса.
 *
 * @param {string} [serverId]
 * @returns {{dir: string, dirExists: boolean, current: string, currentExists: boolean,
 *            fallback: boolean, missions: object[]}}
 */
function list(serverId) {
  const v = config.active(serverId);
  const dir = missionsDir(v);
  const dirExists = Boolean(dir) && fs.existsSync(dir);
  const current = v.server.mission;

  const found = dirExists ? scan(v) : [];
  const missions = found.length
    ? found
    : // Файлов сервера ещё нет — показываем ванильный набор, чтобы карту можно
      // было выбрать заранее. Появятся файлы — список станет настоящим.
      catalogue().map((m) => ({
        folder: m.value,
        label: m.label,
        ...parseFolder(m.value),
        path: dir ? path.join(dir, m.value) : '',
        exists: false,
        vanilla: true,
        hasInit: false,
        hasEconomy: false,
        hasStorage: false
      }));

  // Выбранная карта всегда видна в списке — даже если её папку удалили или
  // переименовали. Иначе пользователь не поймёт, почему сервер не стартует.
  if (current && !missions.some((m) => m.folder === current)) {
    missions.unshift({
      folder: current,
      label: labelFor(current),
      ...parseFolder(current),
      path: dir ? path.join(dir, current) : '',
      exists: false,
      vanilla: VANILLA_MAPS.has(parseFolder(current).map),
      hasInit: false,
      hasEconomy: false,
      hasStorage: false
    });
  }

  return {
    dir,
    dirExists,
    current,
    currentExists: missions.some((m) => m.folder === current && m.exists),
    fallback: !found.length,
    missions: missions.map((m) => ({ ...m, current: m.folder === current }))
  };
}

/* ------------------------------------------------------------------- выбор карты */

/**
 * Выбрать карту (миссию) для сервера.
 *
 * Панель проверяет, что миссия действительно есть в mpmissions: опечатка в
 * имени миссии — одна из самых частых причин, по которой сервер запускается и
 * тут же тихо падает. Проверку можно обойти флагом force — например, когда
 * миссия появится позже вместе с модом-картой.
 *
 * @param {string} serverId
 * @param {string} mission имя папки миссии
 * @param {{force?: boolean}} [opts]
 */
function select(serverId, mission, opts = {}) {
  const folder = sanitize(mission);
  const v = config.active(serverId);
  const dir = missionsDir(v);
  const dirExists = Boolean(dir) && fs.existsSync(dir);
  const onDisk = dirExists && fs.existsSync(path.join(dir, folder));

  if (dirExists && !onDisk && !opts.force) {
    const available = scan(v).map((m) => m.folder);
    throw new Error(
      `Миссия ${folder} не найдена в ${dir}. ` +
        (available.length
          ? `Доступны: ${available.join(', ')}.`
          : 'Папка mpmissions пуста — установите файлы сервера или скопируйте миссию вручную.')
    );
  }

  const warnings = [];
  if (!dirExists) {
    warnings.push(`Папка ${dir || MISSIONS_FOLDER} ещё не существует — карта применится, когда файлы сервера будут установлены.`);
  } else if (!onDisk) {
    warnings.push(`Папки ${folder} в mpmissions нет — сервер не запустится, пока миссия не появится на диске.`);
  } else if (!fs.existsSync(path.join(dir, folder, 'init.c'))) {
    warnings.push(`В ${folder} нет init.c — похоже, это не миссия DayZ.`);
  }

  const previous = v.server.mission;
  config.updateServer(v.id, { server: { mission: folder } });

  // serverDZ.cfg правим только если он уже есть: создавать файл (и папку
  // сервера) из-за смены карты панель не должна — этим занимается установка.
  let cfg = null;
  const cfgFile = config.serverCfgPath(config.active(v.id));
  if (v.features.patchServerCfg && fs.existsSync(cfgFile)) {
    try {
      cfg = serverCfg.sync(v.id);
    } catch (err) {
      warnings.push(`serverDZ.cfg не обновлён: ${err.message}`);
    }
  } else if (!v.features.patchServerCfg) {
    warnings.push('Правка serverDZ.cfg отключена в настройках — впишите template вручную.');
  }

  logger.info(
    SOURCE,
    `«${v.name}»: карта ${previous || '—'} → ${folder}${cfg && cfg.changed ? ' (serverDZ.cfg обновлён)' : ''}`
  );
  for (const warning of warnings) logger.warn(SOURCE, `«${v.name}»: ${warning}`);

  return {
    mission: folder,
    label: labelFor(folder),
    previous,
    exists: onDisk,
    cfg,
    warnings,
    // Работающий сервер продолжает крутить старую карту: движок читает миссию
    // один раз при запуске.
    restartRequired: isRunning(v.id) && previous !== folder
  };
}

function isRunning(serverId) {
  try {
    return require('./serverProcess').isRunning(serverId);
  } catch (_) {
    return false;
  }
}

/**
 * Проблемы с выбранной картой — для проверки готовности сервера к запуску.
 * @returns {string[]}
 */
function problems(v = config.active()) {
  const dir = missionsDir(v);
  if (!dir || !fs.existsSync(dir)) return [];
  if (!v.server.mission) return ['Не выбрана карта (миссия) сервера'];

  const full = path.join(dir, v.server.mission);
  if (!fs.existsSync(full)) {
    const available = scan(v).map((m) => m.folder);
    return [
      `Миссия ${v.server.mission} не найдена в mpmissions` +
        (available.length ? ` (есть: ${available.join(', ')})` : '')
    ];
  }
  if (!fs.existsSync(path.join(full, 'init.c'))) {
    return [`В миссии ${v.server.mission} нет init.c — сервер не сможет её загрузить`];
  }
  return [];
}

module.exports = {
  list,
  scan,
  select,
  problems,
  catalogue,
  labelFor,
  missionsDir,
  sanitize,
  MAP_LABELS,
  VANILLA_MAPS,
  MISSIONS_FOLDER
};
