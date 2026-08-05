'use strict';

/**
 * Логика работы с модами активного сервера.
 *
 * Скачиванием занимается steamcmd.js, поиском — workshop.js, а этот модуль
 * отвечает за состав и раскладку:
 *  - определяет PBO-имя мода (@CF, @Community-Online-Tools, …) из meta.cpp;
 *  - копирует или симлинкает steamapps/workshop/content/221100/<id> в папку сервера;
 *  - раскладывает .bikey из keys/ мода в <server>/keys;
 *  - собирает строку параметра -mod= / -serverMod= из включённых модов.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');
const steamcmd = require('./steamcmd');

const SOURCE = 'mods';

/* ------------------------------------------------------------------ meta.cpp */

/** Имя мода из meta.cpp workshop-элемента: name = "Community Framework"; */
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

/** «Community Framework» -> «@Community Framework». */
function folderNameFor(id, metaName) {
  const safe = String(metaName || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return safe ? `@${safe}` : `@${id}`;
}

/* --------------------------------------------------------------- сканирование */

/** Что реально скачано в steamapps/workshop/content/<appid>. */
function scanWorkshop(v = config.active()) {
  const dir = v.paths.workshopContentDir;
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
function scanServerFolders(v = config.active()) {
  const dir = v.paths.serverPath;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith('@'))
    .map((e) => e.name);
}

/** Полный список модов для интерфейса. */
function list() {
  if (!config.hasServers()) return { mods: [], orphans: [], localCandidates: [] };

  const v = config.active();
  const workshop = new Map(scanWorkshop(v).map((w) => [w.id, w]));
  const serverFolders = new Set(scanServerFolders(v));
  const installedState = steamcmd.readInstalledState(v);

  const items = v.mods.map((mod) => {
    if (mod.source === 'local') return describeLocal(mod, v, serverFolders);

    const ws = workshop.get(mod.id);
    const state = installedState[mod.id] || {};
    const folder = mod.folder || folderNameFor(mod.id, ws ? ws.metaName : mod.name);

    return {
      ...mod,
      name: mod.name || (ws ? ws.metaName : '') || mod.id,
      folder,
      downloaded: Boolean(ws),
      deployed: serverFolders.has(folder),
      sizeMb: ws ? ws.sizeMb : Math.round((mod.sizeBytes / 1024 / 1024) * 10) / 10,
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

  const known = new Set(v.mods.map((m) => m.id));
  const orphans = [...workshop.values()]
    .filter((w) => !known.has(w.id))
    .map((w) => ({
      id: w.id,
      name: w.metaName || w.id,
      folder: folderNameFor(w.id, w.metaName),
      sizeMb: w.sizeMb,
      hasKeys: w.hasKeys
    }));

  return { mods: items, orphans, localCandidates: scanLocalCandidates(v) };
}

/** Состояние локального мода: он не качается, а просто лежит в папке. */
function describeLocal(mod, v, serverFolders) {
  const folder = mod.folder || path.basename(mod.localPath || '') || `@${mod.id}`;
  const source = mod.localPath || path.join(v.paths.serverPath, folder);
  const sourceExists = Boolean(source && fs.existsSync(source));
  const inPlace = isInsideServer(source, v) && path.basename(source) === folder;

  return {
    ...mod,
    name: mod.name || folder.replace(/^@/, ''),
    folder,
    localPath: source,
    downloaded: sourceExists,
    deployed: sourceExists && (inPlace || serverFolders.has(folder)),
    sizeMb: sourceExists ? dirSizeMb(source) : 0,
    hasKeys: sourceExists ? Boolean(findKeysDir(source)) : false,
    workshopPath: '',
    installedManifest: '',
    installedTimeupdated: 0,
    remoteTimeupdated: 0,
    updateAvailable: false,
    inPlace
  };
}

/**
 * Папки @Мод, лежащие в каталоге сервера, но не подключённые в панели.
 * Это готовые кандидаты в локальные моды — их можно подключить одной кнопкой.
 */
function scanLocalCandidates(v = config.active()) {
  const known = new Set(v.mods.map((m) => m.folder).filter(Boolean));
  const dir = v.paths.serverPath;
  if (!dir || !fs.existsSync(dir)) return [];

  return scanServerFolders(v)
    .filter((folder) => !known.has(folder))
    .map((folder) => {
      const full = path.join(dir, folder);
      const meta = readMeta(full);
      return {
        folder,
        path: full,
        name: meta.name || folder.replace(/^@/, ''),
        // Мод из Workshop, положенный вручную, узнаётся по publishedid в meta.cpp
        workshopId: meta.publishedId || '',
        sizeMb: dirSizeMb(full),
        hasKeys: Boolean(findKeysDir(full)),
        hasAddons: fs.existsSync(path.join(full, 'addons')) || fs.existsSync(path.join(full, 'Addons'))
      };
    });
}

/* ------------------------------------------------- запущенный сервер и файлы */

/**
 * Запущенный DayZServer_x64.exe держит .pbo модов открытыми, и Windows не даёт
 * ни удалить, ни перезаписать папку мода — копирование падает с EPERM.
 * Поэтому перед раскладкой сервер должен быть остановлен.
 *
 * require здесь ленивый: serverProcess сам подключает этот модуль.
 */
function serverIsRunning(v = config.active()) {
  try {
    return require('./serverProcess').isRunning(v.id);
  } catch (_) {
    return false;
  }
}

const SERVER_BUSY_HINT =
  'Сервер запущен и держит файлы модов открытыми — Windows не даёт заменить папку. ' +
  'Остановите сервер и повторите, либо включите «Остановить сервер и разложить моды».';

/**
 * Выполнить раскладку, при необходимости остановив сервер и запустив его снова.
 * Без явного разрешения панель сервер не трогает: на нём могут играть люди.
 *
 * @param {{stopServer?: boolean}} opts
 * @param {Function} fn
 */
async function withServerStopped(opts, fn) {
  const v = config.active();
  if (!serverIsRunning(v)) return fn();

  if (!opts.stopServer) {
    logger.warn(SOURCE, SERVER_BUSY_HINT);
    return fn(); // скачать моды можно и так, раскладку остановит понятная ошибка
  }

  const serverProcess = require('./serverProcess');
  const serverId = v.id;

  logger.warn(SOURCE, 'Останавливаю сервер, чтобы заменить файлы модов…');
  await serverProcess.stop(serverId).catch((err) => logger.warn(SOURCE, `Остановка: ${err.message}`));
  // Windows отпускает файловые дескрипторы не мгновенно после смерти процесса.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  try {
    return await fn();
  } finally {
    logger.info(SOURCE, 'Раскладка завершена — запускаю сервер обратно');
    // Моды уже обновлены и разложены, второй заход в SteamCMD не нужен.
    await serverProcess
      .start(serverId, { skipUpdate: true })
      .catch((err) => logger.error(SOURCE, `Не удалось запустить сервер обратно: ${err.message}`));
  }
}

function isInsideServer(target, v = config.active()) {
  if (!target || !v.paths.serverPath) return false;
  const rel = path.relative(path.resolve(v.paths.serverPath), path.resolve(target));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* -------------------------------------------------------------- состав списка */

function saveMods(mods) {
  config.updateActive({ mods });
  return mods;
}

/** Добавить запись о моде в список (без скачивания). */
function register(item) {
  const v = config.active();
  const id = String(item.id).trim();
  const source = item.source === 'local' ? 'local' : 'workshop';

  if (source === 'workshop' && !/^\d+$/.test(id)) {
    throw new Error(`Некорректный Workshop ID: ${item.id}`);
  }
  if (!id) throw new Error('У мода нет идентификатора');

  const existing = v.mods.find((m) => m.id === id);
  if (existing) return existing;

  const mod = {
    id,
    source,
    localPath: source === 'local' ? item.localPath || '' : '',
    collectionId: item.collectionId || '',
    name: item.name || id,
    folder: item.folder || '',
    enabled: item.enabled !== false,
    type: item.type === 'server' ? 'server' : 'client',
    manifest: '',
    timeupdated: 0,
    sizeBytes: item.sizeBytes || 0,
    preview: item.preview || '',
    lastDeployed: null,
    lastUpdateCheck: null,
    missing: false
  };

  saveMods([...v.mods, mod]);
  logger.info(SOURCE, `В список добавлен мод: ${mod.name} (${id})`);
  return mod;
}

/* --------------------------------------------------------- локальные моды */

/** Идентификатор локального мода: Workshop ID у него отсутствует. */
function localIdFor(folder) {
  const slug = String(folder)
    .replace(/^@/, '')
    .replace(/[^\wА-Яа-яЁё-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `local_${slug || Date.now().toString(36)}`;
}

/**
 * Подключить мод из своей папки — например, собственный серверный мод.
 *
 * Папка может лежать где угодно: если она уже внутри каталога сервера,
 * панель ничего не копирует и работает с ней на месте; если снаружи —
 * копирует (или симлинкает) её в каталог сервера при раскладке.
 *
 * @param {{path: string, name?: string, type?: string, folder?: string}} input
 */
function addLocal(input = {}) {
  const v = config.active();
  const raw = String(input.path || '').trim();
  if (!raw) throw new Error('Укажите путь к папке мода');

  // Относительный путь считаем от папки сервера — так удобнее вводить «@MyMod».
  const source = path.isAbsolute(raw) ? raw : path.join(v.paths.serverPath, raw);

  if (!fs.existsSync(source)) throw new Error(`Папка не найдена: ${source}`);
  if (!fs.statSync(source).isDirectory()) throw new Error(`Это не папка: ${source}`);

  const base = path.basename(source);
  const folder = (input.folder || base).trim();
  const normalizedFolder = folder.startsWith('@') ? folder : `@${folder}`;

  if (v.mods.some((m) => m.folder === normalizedFolder)) {
    throw new Error(`Мод с папкой ${normalizedFolder} уже есть в списке`);
  }

  const meta = readMeta(source);
  const hasAddons = fs.existsSync(path.join(source, 'addons')) || fs.existsSync(path.join(source, 'Addons'));
  if (!hasAddons) {
    logger.warn(SOURCE, `В ${source} нет папки addons — убедитесь, что это действительно мод DayZ`);
  }

  const mod = register({
    id: localIdFor(normalizedFolder),
    source: 'local',
    localPath: source,
    folder: normalizedFolder,
    name: input.name || meta.name || normalizedFolder.replace(/^@/, ''),
    type: input.type === 'client' ? 'client' : 'server' // локальные моды чаще всего серверные
  });

  logger.info(
    SOURCE,
    `Локальный мод подключён: ${mod.name} → ${normalizedFolder} ` +
      `(${mod.type === 'server' ? '-serverMod' : '-mod'}, источник ${source})`
  );

  return mod;
}

function patch(id, changes) {
  const v = config.active();
  if (!v.mods.some((m) => m.id === String(id))) throw new Error(`Мод ${id} не найден`);
  const mods = v.mods.map((m) => (m.id === String(id) ? { ...m, ...changes, id: m.id } : m));
  saveMods(mods);
  return mods.find((m) => m.id === String(id));
}

function remove(id, { deleteServerFolder = false } = {}) {
  const v = config.active();
  const mod = v.mods.find((m) => m.id === String(id));
  if (!mod) throw new Error(`Мод ${id} не найден в списке`);

  saveMods(v.mods.filter((m) => m.id !== String(id)));

  if (deleteServerFolder && mod.folder) {
    const target = path.join(v.paths.serverPath, mod.folder);
    const isOwnFolder =
      mod.source === 'local' && mod.localPath && path.resolve(mod.localPath) === path.resolve(target);

    if (isOwnFolder) {
      // Это исходная папка пользователя, а не копия, сделанная панелью.
      // Удалять её нельзя — панель лишь забывает про мод.
      logger.info(SOURCE, `Папка локального мода оставлена на диске: ${target}`);
    } else {
      try {
        removeIfExists(target);
        logger.info(SOURCE, `Удалена папка мода: ${target}`);
      } catch (err) {
        logger.warn(SOURCE, `Не удалось удалить ${target}: ${err.message}`);
      }
    }
  }

  logger.info(SOURCE, `Мод удалён из списка: ${mod.name} (${mod.id})`);
  return mod;
}

function setEnabled(id, enabled) {
  const mod = patch(id, { enabled: Boolean(enabled) });
  logger.info(SOURCE, `${mod.name}: ${enabled ? 'включён' : 'выключен'}`);
  return mod;
}

/** Порядок модов напрямую влияет на порядок в -mod=. */
function reorder(orderedIds) {
  const v = config.active();
  const byId = new Map(v.mods.map((m) => [m.id, m]));
  const ordered = [];
  for (const id of orderedIds.map(String)) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }
  ordered.push(...byId.values());
  saveMods(ordered);
  return ordered;
}

/** Подключить уже скачанный workshop-элемент без обращения к Steam. */
function adoptExisting(id, opts = {}) {
  const v = config.active();
  const workshopId = String(id).trim();
  if (v.mods.some((m) => m.id === workshopId)) throw new Error(`Мод ${workshopId} уже есть в списке`);
  if (!steamcmd.itemExists(workshopId, v)) throw new Error(`Мод ${workshopId} не найден в workshop/content`);

  const meta = readMeta(steamcmd.itemPath(workshopId, v));
  const state = steamcmd.readInstalledState(v)[workshopId] || {};

  const mod = register({
    id: workshopId,
    name: meta.name || workshopId,
    folder: folderNameFor(workshopId, meta.name),
    type: opts.type
  });

  return patch(mod.id, { manifest: state.manifest || '', timeupdated: state.timeupdated || 0 });
}

/* ---------------------------------------------------- скачивание и раскладка */

/**
 * Скачать выбранные моды (кнопка «Загрузить» в окне подписки) и разложить их.
 * @param {Array<{id: string, name?: string, type?: string, preview?: string, sizeBytes?: number}>} items
 * @param {{onProgress?: (p: {percent: number, step: string}) => void, stopServer?: boolean}} [opts]
 */
async function downloadMany(items, opts = {}) {
  const list = items
    .map((i) => (typeof i === 'string' ? { id: i } : i))
    .filter((i) => i && i.id && i.source !== 'local' && /^\d+$/.test(String(i.id)));
  if (!list.length) throw new Error('Список модов пуст — для загрузки нужны моды из Workshop');

  for (const item of list) register(item);

  const ids = list.map((i) => String(i.id));
  const report = { downloaded: [], failed: [], total: ids.length };

  const notify = (percent, step) => opts.onProgress && opts.onProgress({ percent, step });
  notify(2, `Подготовка загрузки (${ids.length} шт.)`);

  const { results } = await steamcmd.downloadItems(
    list.map((i) => ({ id: String(i.id), name: i.name || String(i.id), sizeBytes: i.sizeBytes || 0 })),
    {
      onProgress: (p) => {
        if (p.percent !== null && p.percent !== undefined) notify(5 + p.percent * 0.8, p.phase);
      },
      onItemDone: (id, done, total) => notify(5 + (done / total) * 80, `Готово ${done} из ${total}`)
    }
  );

  notify(88, 'Раскладываю моды в папку сервера');

  const now = new Date().toISOString();
  await withServerStopped(opts, () => deployResults(results, report, now));

  notify(100, `Готово: ${report.downloaded.length} из ${report.total}`);
  return report;
}

/** Разложить только что скачанные моды и записать итог в отчёт. */
async function deployResults(results, report, now) {
  for (const result of results) {
    const v = config.active();
    const mod = v.mods.find((m) => m.id === result.id);
    if (!mod) continue;

    if (result.status === 'failed') {
      patch(mod.id, { lastUpdateCheck: now, missing: true });
      report.failed.push({ id: mod.id, name: mod.name, error: result.error });
      logger.error(SOURCE, `✗ ${mod.name} (${mod.id}): ${result.error}`);
      continue;
    }

    const meta = readMeta(steamcmd.itemPath(mod.id, v));
    const updated = patch(mod.id, {
      name: meta.name || mod.name,
      folder: mod.folder || folderNameFor(mod.id, meta.name),
      manifest: result.manifest,
      timeupdated: result.timeupdated,
      lastUpdateCheck: now,
      missing: false,
      manualInstall: Boolean(result.rescued && !result.registered)
    });

    if (result.rescued) {
      logger.warn(
        SOURCE,
        result.registered
          ? `${updated.name}: установлен переносом из downloads, SteamCMD уведомлён — обновления будут проверяться как обычно`
          : `${updated.name}: установлен переносом из downloads. Автопроверка обновлений для него отключена, ` +
              'иначе SteamCMD скачивал бы весь мод заново. Обновляйте кнопкой «Обновить принудительно» в строке мода.'
      );
    }

    try {
      await deploy(updated, { force: true });
      report.downloaded.push({ id: updated.id, name: updated.name, status: result.status });
      logger.info(SOURCE, `✓ ${updated.name} (${updated.id}) готов к использованию`);
    } catch (err) {
      report.failed.push({ id: updated.id, name: updated.name, error: err.message });
      logger.error(SOURCE, `${updated.name}: скачан, но не разложен — ${err.message}`);
    }
  }

  return report;
}

/**
 * Принудительно перекачать один мод, даже если он помечен как установленный
 * переносом. Нужен, когда автор обновил тяжёлый мод и его надо обновить руками.
 */
async function forceUpdate(id, opts = {}) {
  const v = config.active();
  const mod = v.mods.find((m) => m.id === String(id));
  if (!mod) throw new Error(`Мод ${id} не найден`);
  if (mod.source === 'local') throw new Error('Локальные моды не качаются из Workshop');

  patch(mod.id, { manualInstall: false });
  logger.info(SOURCE, `${mod.name}: принудительная перезагрузка мода`);

  const report = await downloadMany([{ id: mod.id, name: mod.name, sizeBytes: mod.sizeBytes, type: mod.type }], opts);
  if (report.failed.length) throw new Error(report.failed[0].error);
  return config.active().mods.find((m) => m.id === mod.id);
}

/** Добавление одного мода по Workshop ID (совместимость со старым API). */
async function addByWorkshopId(id, opts = {}) {
  const workshopId = String(id).trim();
  if (!/^\d+$/.test(workshopId)) {
    throw new Error('Workshop ID должен состоять только из цифр (например 1559212036)');
  }
  if (config.active().mods.some((m) => m.id === workshopId)) {
    throw new Error(`Мод ${workshopId} уже есть в списке`);
  }

  const report = await downloadMany([{ id: workshopId, type: opts.type }]);
  if (report.failed.length) throw new Error(report.failed[0].error);
  return config.active().mods.find((m) => m.id === workshopId);
}

function findKeysDir(modDir) {
  for (const name of ['keys', 'Keys', 'key', 'Key']) {
    const dir = path.join(modDir, name);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch (_) {
      /* пропускаем */
    }
  }
  return null;
}

/** Скопировать (или симлинкнуть) мод в папку сервера и разложить ключи. */
async function deploy(mod, opts = {}) {
  const v = config.active();
  const isLocal = mod.source === 'local';
  const folder = mod.folder || folderNameFor(mod.id, mod.name);
  const source = isLocal
    ? mod.localPath || path.join(v.paths.serverPath, folder)
    : steamcmd.itemPath(mod.id, v);
  const target = path.join(v.paths.serverPath, folder);

  if (!v.paths.serverPath || !fs.existsSync(v.paths.serverPath)) {
    throw new Error(`Папка сервера не найдена: ${v.paths.serverPath}`);
  }
  if (!fs.existsSync(source)) {
    throw new Error(isLocal ? `Папка локального мода исчезла: ${source}` : `Контент мода не скачан: ${source}`);
  }

  // Локальный мод может уже лежать прямо в каталоге сервера. Тогда копировать
  // нечего, и — важнее — нельзя трогать target: это и есть исходная папка.
  if (path.resolve(source) === path.resolve(target)) {
    logger.info(SOURCE, `${folder}: локальный мод уже на месте, копирование не требуется`);
    copyKeys(source, v);
    patch(mod.id, { folder, lastDeployed: new Date().toISOString(), missing: false });
    return target;
  }

  // Заменять папку мода под работающим сервером бессмысленно и невозможно:
  // Windows вернёт EPERM. Сообщаем об этом до того, как что-то удалим.
  if (fs.existsSync(target) && serverIsRunning(v)) {
    throw new Error(`${folder}: ${SERVER_BUSY_HINT}`);
  }

  const symlink = v.features.deployMode === 'symlink';

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

  copyKeys(source, v);
  patch(mod.id, { folder, lastDeployed: new Date().toISOString(), missing: false });
  return target;
}

function copyKeys(modDir, v = config.active()) {
  const keysDir = findKeysDir(modDir);
  if (!keysDir) return 0;

  const targetKeys = path.join(v.paths.serverPath, 'keys');
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
    if (!fs.lstatSync(target).isSymbolicLink()) return false;
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
async function deployAll(ids = null, opts = {}) {
  const v = config.active();
  const targets = v.mods.filter((m) => (ids ? ids.includes(m.id) : m.enabled));

  return withServerStopped(opts, async () => {
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
  });
}

/* ---------------------------------------------------- автообновление перед стартом */

/**
 * Проверить обновления включённых модов и разложить изменившиеся.
 * @param {{onProgress?: Function}} [opts]
 */
async function checkAndUpdate(opts = {}) {
  const v = config.active();
  const enabledAll = v.mods.filter((m) => m.enabled);
  const enabled = enabledAll.filter((m) => m.source !== 'local' && !m.manualInstall);
  const local = enabledAll.filter((m) => m.source === 'local');
  const manual = enabledAll.filter((m) => m.source !== 'local' && m.manualInstall);
  const notify = (percent, step) => opts.onProgress && opts.onProgress({ percent, step });

  if (manual.length) {
    logger.info(
      SOURCE,
      `Пропускаю проверку обновлений для модов, установленных переносом: ${manual.map((m) => m.name).join(', ')}. ` +
        'SteamCMD скачал бы их целиком заново.'
    );
  }

  // Моды, которые надо просто разложить: локальные и установленные переносом.
  // Раскладка идёт одним заходом вместе с обновлёнными — чтобы сервер (если
  // его понадобится остановить) останавливался ровно один раз.
  const deployOnly = async () => {
    for (const mod of manual) {
      try {
        await deploy(mod);
      } catch (err) {
        logger.error(SOURCE, `${mod.name}: ${err.message}`);
      }
    }
    for (const mod of local) {
      try {
        await deploy(mod);
      } catch (err) {
        logger.error(SOURCE, `Локальный мод ${mod.name}: ${err.message}`);
      }
    }
  };

  if (!enabled.length) {
    await withServerStopped(opts, deployOnly);
    logger.info(
      SOURCE,
      local.length
        ? `Обновлять нечего: включены только локальные моды (${local.length})`
        : 'Включённых модов нет — проверка обновлений пропущена'
    );
    return { checked: 0, updated: [], failed: [], skipped: true, local: local.length };
  }

  logger.info(SOURCE, `Проверка обновлений через SteamCMD для ${enabled.length} мод(ов)…`);
  notify(5, `Проверяю ${enabled.length} мод(ов)`);

  const { results } = await steamcmd.downloadItems(
    enabled.map((m) => ({ id: m.id, name: m.name, sizeBytes: m.sizeBytes })),
    {
      onProgress: (p) => {
        if (p.percent !== null && p.percent !== undefined) notify(5 + p.percent * 0.8, p.phase);
      }
    }
  );

  const updated = [];
  const failed = [];
  const now = new Date().toISOString();
  const toDeploy = [];

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
    toDeploy.push(mod);
  }

  await withServerStopped(opts, async () => {
    await deployOnly();
    for (const mod of toDeploy) {
      try {
        await deploy({ ...mod, folder: mod.folder || folderNameFor(mod.id, mod.name) }, { force: true });
      } catch (err) {
        logger.error(SOURCE, `Не удалось разложить обновлённый мод ${mod.name}: ${err.message}`);
        failed.push({ id: mod.id, name: mod.name, error: err.message });
      }
    }
  });

  if (updated.length) {
    logger.info(SOURCE, `Итого обновлено модов: ${updated.length} (${updated.map((u) => u.name).join(', ')})`);
  } else {
    logger.info(SOURCE, 'Все включённые моды актуальны');
  }
  if (failed.length) logger.warn(SOURCE, `Не удалось обработать модов: ${failed.length}`);

  notify(100, updated.length ? `Обновлено: ${updated.length}` : 'Все моды актуальны');
  return { checked: results.length, updated, failed, skipped: false };
}

/* ------------------------------------------------- параметры командной строки */

/** Строки для -mod= и -serverMod= по включённым модам, в порядке списка. */
function buildModParams(v = config.active()) {
  const enabled = v.mods.filter((m) => m.enabled);
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
          /* файл исчез */
        }
      }
    }
  };
  walk(dir);
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

module.exports = {
  list,
  register,
  addLocal,
  scanLocalCandidates,
  downloadMany,
  forceUpdate,
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
