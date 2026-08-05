'use strict';

/**
 * Логика работы с модами.
 *
 * Скачиванием занимается steamcmd.js, а этот модуль отвечает за «раскладку»:
 *  - определяет PBO-имя мода (@CF, @Community-Online-Tools, ...) из meta.cpp;
 *  - копирует или симлинкает steamapps/workshop/content/221100/<id> в папку сервера;
 *  - раскладывает .bikey из keys/ мода в <server>/keys;
 *  - собирает строку параметра -mod= / -serverMod= из включённых в панели модов.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');
const steamcmd = require('./steamcmd');

const SOURCE = 'mods';

/* ------------------------------------------------------------------ meta.cpp */

/**
 * Достаём человеческое имя мода из meta.cpp workshop-элемента.
 * Формат: name = "Community Framework";
 */
function readMeta(dir) {
  const meta = { name: '', publishedId: '' };
  const file = path.join(dir, 'meta.cpp');
  if (!fs.existsSync(file)) return meta;

  try {
    const text = fs.readFileSync(file, 'utf8');
    const name = text.match(/^\s*name\s*=\s*"([^"]*)"/mi);
    const id = text.match(/^\s*publishedid\s*=\s*(\d+)/mi);
    if (name) meta.name = name[1].trim();
    if (id) meta.publishedId = id[1];
  } catch (err) {
    logger.warn(SOURCE, `Не удалось прочитать meta.cpp в ${dir}: ${err.message}`);
  }
  return meta;
}

/** Имя папки мода в каталоге сервера: «Community Framework» -> «@Community Framework». */
function folderNameFor(id, metaName) {
  const raw = (metaName || '').trim();
  const safe = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return safe ? `@${safe}` : `@${id}`;
}

/* --------------------------------------------------------------- сканирование */

/** Что реально скачано в steamapps/workshop/content/<appid>. */
function scanWorkshop(cfg = config.load()) {
  const dir = cfg.paths.workshopContentDir;
  const found = [];
  if (!dir || !fs.existsSync(dir)) return found;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const meta = readMeta(full);
    found.push({
      id: entry.name,
      metaName: meta.name,
      path: full,
      sizeMb: dirSizeMb(full),
      hasKeys: Boolean(findKeysDir(full))
    });
  }
  return found;
}

/** Папки @Mod, уже лежащие в каталоге сервера. */
function scanServerFolders(cfg = config.load()) {
  const dir = cfg.paths.serverPath;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith('@'))
    .map((e) => e.name);
}

/**
 * Полный список модов для интерфейса: то, что записано в конфиге, обогащённое
 * фактическим состоянием на диске и версией из .acf.
 */
function list() {
  const cfg = config.load();
  const workshop = new Map(scanWorkshop(cfg).map((w) => [w.id, w]));
  const serverFolders = new Set(scanServerFolders(cfg));
  const installedState = steamcmd.readInstalledState(cfg);

  const items = cfg.mods.map((mod) => {
    const ws = workshop.get(mod.id);
    const state = installedState[mod.id] || {};
    const folder = mod.folder || folderNameFor(mod.id, ws ? ws.metaName : mod.name);

    return {
      ...mod,
      name: mod.name || (ws ? ws.metaName : '') || mod.id,
      folder,
      downloaded: Boolean(ws),
      deployed: serverFolders.has(folder),
      sizeMb: ws ? ws.sizeMb : 0,
      hasKeys: ws ? ws.hasKeys : false,
      workshopPath: ws ? ws.path : '',
      installedManifest: state.manifest || '',
      installedTimeupdated: state.timeupdated || 0,
      remoteTimeupdated: state.remoteTimeupdated || 0,
      updateAvailable: Boolean(
        state.remoteTimeupdated && state.timeupdated && state.remoteTimeupdated > state.timeupdated
      )
    };
  });

  // Скачанные, но ещё не добавленные в панель — показываем отдельно, чтобы
  // их можно было подключить в один клик.
  const known = new Set(cfg.mods.map((m) => m.id));
  const orphans = [...workshop.values()]
    .filter((w) => !known.has(w.id))
    .map((w) => ({
      id: w.id,
      name: w.metaName || w.id,
      folder: folderNameFor(w.id, w.metaName),
      sizeMb: w.sizeMb,
      hasKeys: w.hasKeys
    }));

  return { mods: items, orphans };
}

/* -------------------------------------------------------------- добавление мода */

/**
 * Добавить мод по Workshop ID: скачать через SteamCMD, определить имя и
 * записать в конфиг.
 */
async function addByWorkshopId(id, opts = {}) {
  const workshopId = String(id).trim();
  if (!/^\d+$/.test(workshopId)) {
    throw new Error('Workshop ID должен состоять только из цифр (например 1559212036)');
  }

  const cfg = config.load();
  if (cfg.mods.some((m) => m.id === workshopId)) {
    throw new Error(`Мод ${workshopId} уже есть в списке`);
  }

  logger.info(SOURCE, `Добавление мода ${workshopId}: запуск SteamCMD…`);
  const { results } = await steamcmd.downloadItems([workshopId], { validate: Boolean(opts.validate) });
  const result = results[0];

  if (!result || result.status === 'failed') {
    throw new Error(`Не удалось скачать мод ${workshopId}: ${(result && result.error) || 'неизвестная ошибка'}`);
  }

  const dir = steamcmd.itemPath(workshopId, cfg);
  const meta = readMeta(dir);
  const name = meta.name || workshopId;
  const folder = folderNameFor(workshopId, meta.name);

  const mod = {
    id: workshopId,
    name,
    folder,
    enabled: true,
    type: opts.type === 'server' ? 'server' : 'client',
    manifest: result.manifest,
    timeupdated: result.timeupdated,
    lastUpdateCheck: new Date().toISOString(),
    lastDeployed: null,
    missing: false
  };

  config.update({ mods: [...cfg.mods, mod] });
  logger.info(SOURCE, `Мод добавлен: ${name} (${workshopId}) -> ${folder}`);

  // Сразу раскладываем в папку сервера, чтобы мод был готов к запуску.
  try {
    await deploy(mod);
  } catch (err) {
    logger.warn(SOURCE, `Мод скачан, но не разложен в папку сервера: ${err.message}`);
  }

  return mod;
}

/** Подключить уже скачанный workshop-элемент без обращения к Steam. */
async function adoptExisting(id, opts = {}) {
  const workshopId = String(id).trim();
  const cfg = config.load();
  if (cfg.mods.some((m) => m.id === workshopId)) throw new Error(`Мод ${workshopId} уже есть в списке`);
  if (!steamcmd.itemExists(workshopId, cfg)) throw new Error(`Мод ${workshopId} не найден в workshop/content`);

  const dir = steamcmd.itemPath(workshopId, cfg);
  const meta = readMeta(dir);
  const state = steamcmd.readInstalledState(cfg)[workshopId] || {};

  const mod = {
    id: workshopId,
    name: meta.name || workshopId,
    folder: folderNameFor(workshopId, meta.name),
    enabled: true,
    type: opts.type === 'server' ? 'server' : 'client',
    manifest: state.manifest || '',
    timeupdated: state.timeupdated || 0,
    lastUpdateCheck: null,
    lastDeployed: null,
    missing: false
  };

  config.update({ mods: [...cfg.mods, mod] });
  logger.info(SOURCE, `Подключён уже скачанный мод: ${mod.name} (${workshopId})`);
  return mod;
}

function remove(id, { deleteServerFolder = false } = {}) {
  const cfg = config.load();
  const mod = cfg.mods.find((m) => m.id === String(id));
  if (!mod) throw new Error(`Мод ${id} не найден в списке`);

  config.update({ mods: cfg.mods.filter((m) => m.id !== String(id)) });

  if (deleteServerFolder && mod.folder) {
    const target = path.join(cfg.paths.serverPath, mod.folder);
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        logger.info(SOURCE, `Удалена папка мода: ${target}`);
      }
    } catch (err) {
      logger.warn(SOURCE, `Не удалось удалить ${target}: ${err.message}`);
    }
  }

  logger.info(SOURCE, `Мод удалён из списка: ${mod.name} (${mod.id})`);
  return mod;
}

function setEnabled(id, enabled) {
  const cfg = config.load();
  const mods = cfg.mods.map((m) => (m.id === String(id) ? { ...m, enabled: Boolean(enabled) } : m));
  if (!cfg.mods.some((m) => m.id === String(id))) throw new Error(`Мод ${id} не найден`);
  config.update({ mods });
  const mod = mods.find((m) => m.id === String(id));
  logger.info(SOURCE, `${mod.name}: ${enabled ? 'включён' : 'выключен'}`);
  return mod;
}

function patch(id, changes) {
  const cfg = config.load();
  if (!cfg.mods.some((m) => m.id === String(id))) throw new Error(`Мод ${id} не найден`);
  const mods = cfg.mods.map((m) => (m.id === String(id) ? { ...m, ...changes, id: m.id } : m));
  config.update({ mods });
  return mods.find((m) => m.id === String(id));
}

/** Изменить порядок модов — он напрямую влияет на порядок в -mod=. */
function reorder(orderedIds) {
  const cfg = config.load();
  const byId = new Map(cfg.mods.map((m) => [m.id, m]));
  const ordered = [];
  for (const id of orderedIds.map(String)) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }
  ordered.push(...byId.values()); // всё, что не попало в список, — в конец
  config.update({ mods: ordered });
  return ordered;
}

/* ------------------------------------------------------------------ раскладка */

function findKeysDir(modDir) {
  for (const name of ['keys', 'Keys', 'key', 'Key']) {
    const dir = path.join(modDir, name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
}

/**
 * Скопировать (или симлинкнуть) мод в папку сервера и разложить ключи.
 * @param {object} mod
 * @param {{force?: boolean}} [opts]
 */
async function deploy(mod, opts = {}) {
  const cfg = config.load();
  const source = steamcmd.itemPath(mod.id, cfg);
  const folder = mod.folder || folderNameFor(mod.id, mod.name);
  const target = path.join(cfg.paths.serverPath, folder);

  if (!cfg.paths.serverPath || !fs.existsSync(cfg.paths.serverPath)) {
    throw new Error(`Папка сервера не найдена: ${cfg.paths.serverPath}`);
  }
  if (!fs.existsSync(source)) {
    throw new Error(`Контент мода не скачан: ${source}`);
  }

  const symlink = cfg.features.deployMode === 'symlink';

  // Уже симлинк на нужный источник — ничего делать не надо.
  if (symlink && isLinkTo(target, source) && !opts.force) {
    logger.info(SOURCE, `${folder}: симлинк уже актуален`);
  } else {
    removeIfExists(target);
    if (symlink) {
      fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      logger.info(SOURCE, `${folder}: создан симлинк -> ${source}`);
    } else {
      fs.cpSync(source, target, { recursive: true, force: true });
      logger.info(SOURCE, `${folder}: скопировано в папку сервера`);
    }
  }

  copyKeys(source, cfg);

  patch(mod.id, { folder, lastDeployed: new Date().toISOString(), missing: false });
  return target;
}

function copyKeys(modDir, cfg = config.load()) {
  const keysDir = findKeysDir(modDir);
  if (!keysDir) return 0;

  const targetKeys = path.join(cfg.paths.serverPath, 'keys');
  fs.mkdirSync(targetKeys, { recursive: true });

  let count = 0;
  for (const file of fs.readdirSync(keysDir)) {
    if (!/\.bikey$/i.test(file)) continue;
    fs.copyFileSync(path.join(keysDir, file), path.join(targetKeys, file));
    count++;
  }
  if (count) logger.info(SOURCE, `Скопировано ключей (.bikey): ${count}`);
  return count;
}

function isLinkTo(target, source) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) return false;
    return path.resolve(fs.readlinkSync(target)) === path.resolve(source);
  } catch (_) {
    return false;
  }
}

function removeIfExists(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/** Разложить все включённые моды (или указанный список). */
async function deployAll(ids = null) {
  const cfg = config.load();
  const targets = cfg.mods.filter((m) => (ids ? ids.includes(m.id) : m.enabled));
  const report = [];

  for (const mod of targets) {
    try {
      await deploy(mod);
      report.push({ id: mod.id, name: mod.name, ok: true });
    } catch (err) {
      logger.error(SOURCE, `${mod.name} (${mod.id}): ${err.message}`);
      report.push({ id: mod.id, name: mod.name, ok: false, error: err.message });
    }
  }
  return report;
}

/* ---------------------------------------------------- автообновление перед стартом */

/**
 * Проверить обновления включённых модов и разложить изменившиеся.
 * @returns {Promise<{checked: number, updated: Array, failed: Array, skipped: boolean}>}
 */
async function checkAndUpdate() {
  const cfg = config.load();
  const enabled = cfg.mods.filter((m) => m.enabled);

  if (!enabled.length) {
    logger.info(SOURCE, 'Включённых модов нет — проверка обновлений пропущена');
    return { checked: 0, updated: [], failed: [], skipped: true };
  }

  logger.info(SOURCE, `Проверка обновлений через SteamCMD для ${enabled.length} мод(ов)…`);

  const { results } = await steamcmd.downloadItems(enabled.map((m) => m.id));
  const updated = [];
  const failed = [];
  const now = new Date().toISOString();

  for (const result of results) {
    const mod = enabled.find((m) => m.id === result.id);
    if (!mod) continue;

    if (result.status === 'failed') {
      failed.push({ id: mod.id, name: mod.name, error: result.error });
      logger.error(SOURCE, `✗ ${mod.name} (${mod.id}): ${result.error}`);
      patch(mod.id, { lastUpdateCheck: now, missing: true });
      continue;
    }

    patch(mod.id, {
      manifest: result.manifest,
      timeupdated: result.timeupdated,
      lastUpdateCheck: now,
      missing: false
    });

    if (result.status === 'up-to-date') {
      logger.info(SOURCE, `= ${mod.name} (${mod.id}): актуален`);
      continue;
    }

    const label = result.status === 'installed' ? 'установлен' : 'ОБНОВЛЁН';
    logger.info(SOURCE, `↑ ${mod.name} (${mod.id}): ${label} (manifest ${result.manifest || 'n/a'})`);
    updated.push({ id: mod.id, name: mod.name, status: result.status, manifest: result.manifest });

    try {
      await deploy({ ...mod, folder: mod.folder || folderNameFor(mod.id, mod.name) }, { force: true });
    } catch (err) {
      logger.error(SOURCE, `Не удалось разложить обновлённый мод ${mod.name}: ${err.message}`);
      failed.push({ id: mod.id, name: mod.name, error: err.message });
    }
  }

  if (updated.length) {
    logger.info(SOURCE, `Итого обновлено модов: ${updated.length} (${updated.map((u) => u.name).join(', ')})`);
  } else {
    logger.info(SOURCE, 'Все включённые моды актуальны');
  }
  if (failed.length) {
    logger.warn(SOURCE, `Не удалось обработать модов: ${failed.length}`);
  }

  return { checked: results.length, updated, failed, skipped: false };
}

/* ------------------------------------------------------- параметры командной строки */

/**
 * Строки для -mod= и -serverMod= по включённым в панели модам.
 * Порядок соответствует порядку в списке панели.
 */
function buildModParams(cfg = config.load()) {
  const enabled = cfg.mods.filter((m) => m.enabled);
  const folderOf = (m) => m.folder || folderNameFor(m.id, m.name);

  const client = enabled.filter((m) => m.type !== 'server').map(folderOf);
  const server = enabled.filter((m) => m.type === 'server').map(folderOf);

  return {
    clientMods: client,
    serverMods: server,
    modParam: client.length ? `-mod=${client.join(';')}` : '',
    serverModParam: server.length ? `-serverMod=${server.join(';')}` : ''
  };
}

function dirSizeMb(dir) {
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
        } catch (_) {
          /* файл исчез — пропускаем */
        }
      }
    }
  };
  walk(dir);
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

module.exports = {
  list,
  addByWorkshopId,
  adoptExisting,
  remove,
  setEnabled,
  patch,
  reorder,
  deploy,
  deployAll,
  checkAndUpdate,
  buildModParams,
  folderNameFor,
  readMeta,
  scanWorkshop,
  scanServerFolders
};
