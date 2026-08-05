'use strict';

/**
 * Конфигурация панели.
 *
 * Всё состояние лежит в одном JSON-файле config/config.json:
 *
 *   {
 *     panel:  { host, port, ... }          — настройки самой панели
 *     steam:  { username, password, ... }  — общий аккаунт SteamCMD
 *     paths:  { steamcmdExe, ... }         — общие пути
 *     activeServerId: "srv_xxx"
 *     servers: [ { id, name, paths, server, features, mods } ]
 *   }
 *
 * Сервисы работают не с этим деревом напрямую, а с «плоским» видом активного
 * сервера — config.active(). В нём глобальные и серверные настройки уже
 * склеены, поэтому логика модов, .bat, брандмауэра и запуска не знает про
 * многосерверность вообще.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logger = require('./logger');
const bus = require('./events');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_FILE = path.join(CONFIG_DIR, 'config.default.json');

/** Пути, которые общие для всех серверов (лежат в корне конфига). */
const GLOBAL_PATH_KEYS = ['steamcmdExe', 'workshopContentDir'];

let cache = null;

/**
 * Сервер, «закреплённый» на время длительной операции.
 *
 * Загрузка модов или запуск сервера идут минутами, и пользователь за это время
 * может переключить активный сервер в интерфейсе. Пока операция выполняется,
 * active() обязан отдавать тот сервер, для которого её запустили, иначе моды
 * уедут не в ту папку.
 */
let pinnedServerId = null;

/* --------------------------------------------------------------- чтение/запись */

function readDefaults() {
  return JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8'));
}

/** Глубокий мердж: значения из `override` побеждают, массивы заменяются целиком. */
function merge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) out[key] = merge(base[key], override[key]);
    return out;
  }
  return override === undefined ? base : override;
}

function load(force = false) {
  if (cache && !force) return cache;

  const defaults = readDefaults();
  let stored = {};

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      logger.error('panel', `config.json повреждён (${err.message}), беру значения по умолчанию`);
      try {
        const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
        fs.copyFileSync(CONFIG_FILE, backup);
        logger.warn('panel', `Повреждённый конфиг сохранён как ${backup}`);
      } catch (_) {
        /* не критично */
      }
      stored = {};
    }
  }

  cache = normalize(merge(defaults, migrate(stored)));

  if (!fs.existsSync(CONFIG_FILE)) {
    persist();
    logger.info('panel', 'Создан config/config.json');
  }

  return cache;
}

function persist() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return cache;
}

function save(next) {
  cache = normalize(merge(readDefaults(), next));
  return persist();
}

/** Частичное обновление корня конфига (panel / steam / общие пути). */
function updateRoot(patch) {
  return save(merge(load(), patch));
}

/* ------------------------------------------------- миграция со старого формата */

/**
 * Конфиг версии 1 описывал ровно один сервер плоскими секциями.
 * Превращаем его в первый элемент servers[], чтобы ничего не потерялось.
 */
function migrate(stored) {
  if (!stored || typeof stored !== 'object') return {};
  if (Array.isArray(stored.servers)) return stored; // уже новый формат
  if (!stored.paths && !stored.server && !stored.mods) return stored; // пустой конфиг

  logger.info('panel', 'Обнаружен конфиг старого формата — переношу сервер в список серверов');

  const legacyPaths = stored.paths || {};
  const instance = {
    id: newId(),
    name: (stored.server && stored.server.name) || 'DayZ Server',
    createdAt: new Date().toISOString(),
    installed: true,
    paths: {
      serverPath: legacyPaths.serverPath || '',
      serverExe: legacyPaths.serverExe || 'DayZServer_x64.exe',
      profilesFolder: legacyPaths.profilesFolder || 'profiles',
      configFile: legacyPaths.configFile || 'serverDZ.cfg',
      batFile: legacyPaths.batFile || 'start_dayz_server.bat'
    },
    server: stored.server || {},
    features: stored.features || {},
    mods: stored.mods || []
  };

  return {
    panel: stored.panel,
    steam: stored.steam,
    paths: {
      steamcmdExe: legacyPaths.steamcmdExe || '',
      workshopContentDir: legacyPaths.workshopContentDir || ''
    },
    activeServerId: instance.id,
    servers: [instance]
  };
}

function newId() {
  return `srv_${crypto.randomBytes(4).toString('hex')}`;
}

/* ----------------------------------------------------------------- нормализация */

function normalize(cfg) {
  const c = cfg;
  const defaults = readDefaults();

  c.panel.port = toInt(c.panel.port, 8787);
  c.panel.logBufferLines = toInt(c.panel.logBufferLines, 2000);

  c.servers = (Array.isArray(c.servers) ? c.servers : []).map((raw) => {
    const s = merge(defaults.serverTemplate, raw);
    s.id = s.id || newId();
    s.name = String(s.name || 'DayZ Server').trim() || 'DayZ Server';
    s.installed = Boolean(s.installed);

    s.server.maxPlayers = clamp(toInt(s.server.maxPlayers, 60), 1, 200);
    s.server.gamePort = clamp(toInt(s.server.gamePort, 2302), 1, 65535);
    s.server.steamQueryPort = clamp(toInt(s.server.steamQueryPort, 27016), 1, 65535);
    s.server.cpuCount = clamp(toInt(s.server.cpuCount, 0), 0, 64);
    s.server.limitFPS = clamp(toInt(s.server.limitFPS, 0), 0, 1000);
    s.server.timeAcceleration = clamp(toNum(s.server.timeAcceleration, 12), 0.1, 64);
    s.server.nightTimeAcceleration = clamp(toNum(s.server.nightTimeAcceleration, 1), 0.1, 64);
    s.server.name = String(s.server.name || s.name);

    s.server.extraPorts = (Array.isArray(s.server.extraPorts) ? s.server.extraPorts : [])
      .map((p) => ({
        protocol: String(p.protocol || 'UDP').toUpperCase() === 'TCP' ? 'TCP' : 'UDP',
        from: toInt(p.from, 0),
        to: toInt(p.to, toInt(p.from, 0)),
        comment: p.comment || ''
      }))
      .filter((p) => p.from > 0 && p.to >= p.from);

    s.server.extraArgs = (Array.isArray(s.server.extraArgs) ? s.server.extraArgs : [])
      .map((a) => String(a).trim())
      .filter(Boolean);

    s.mods = (Array.isArray(s.mods) ? s.mods : [])
      .map((m) => ({
        id: String(m.id || '').trim(),
        // workshop — качается через SteamCMD; local — своя папка на диске,
        // которую панель только раскладывает и не пытается обновлять.
        source: m.source === 'local' ? 'local' : 'workshop',
        localPath: m.localPath || '',
        collectionId: m.collectionId || '',
        name: m.name || '',
        folder: m.folder || '',
        enabled: m.enabled !== false,
        type: m.type === 'server' ? 'server' : 'client',
        manifest: m.manifest || '',
        timeupdated: toInt(m.timeupdated, 0),
        sizeBytes: toInt(m.sizeBytes, 0),
        preview: m.preview || '',
        lastDeployed: m.lastDeployed || null,
        lastUpdateCheck: m.lastUpdateCheck || null,
        missing: Boolean(m.missing)
      }))
      .filter((m) => m.id);

    if (s.features.deployMode !== 'symlink') s.features.deployMode = 'copy';
    if (s.features.launchMode !== 'bat') s.features.launchMode = 'exe';

    return s;
  });

  if (!c.paths.workshopContentDir) c.paths.workshopContentDir = deriveWorkshopDir(c);

  if (!c.servers.some((s) => s.id === c.activeServerId)) {
    c.activeServerId = c.servers.length ? c.servers[0].id : null;
  }

  delete c.serverTemplate; // шаблон живёт только в config.default.json
  return c;
}

/* --------------------------------------------------------------- работа с серверами */

function servers() {
  return load().servers;
}

function getServer(id) {
  return load().servers.find((s) => s.id === id) || null;
}

function activeServer() {
  const cfg = load();
  const id = pinnedServerId || cfg.activeServerId;
  return cfg.servers.find((s) => s.id === id) || null;
}

/**
 * Выполнить операцию так, чтобы active() внутри неё указывал на конкретный
 * сервер, что бы пользователь ни нажимал в интерфейсе.
 * @param {string} serverId
 * @param {() => Promise<any>} fn
 */
async function withServer(serverId, fn) {
  const previous = pinnedServerId;
  pinnedServerId = serverId;
  try {
    return await fn();
  } finally {
    pinnedServerId = previous;
  }
}

function setActive(id) {
  const cfg = load();
  if (!cfg.servers.some((s) => s.id === id)) throw new Error(`Сервер ${id} не найден`);
  cfg.activeServerId = id;
  persist();
  bus.emit('servers');
  return activeServer();
}

function addServer(instance) {
  const cfg = load();
  const defaults = readDefaults();
  const created = normalizeOne(merge(defaults.serverTemplate, { ...instance, id: instance.id || newId() }));
  cfg.servers.push(created);
  cfg.activeServerId = created.id;
  persist();
  bus.emit('servers');
  return created;
}

function normalizeOne(instance) {
  const cfg = load();
  const backup = cfg.servers;
  cfg.servers = [instance];
  const normalized = normalize(cfg).servers[0];
  cfg.servers = backup;
  return normalized;
}

function removeServer(id) {
  const cfg = load();
  const index = cfg.servers.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`Сервер ${id} не найден`);
  const [removed] = cfg.servers.splice(index, 1);
  if (cfg.activeServerId === id) cfg.activeServerId = cfg.servers.length ? cfg.servers[0].id : null;
  persist();
  bus.emit('servers');
  return removed;
}

/** Частичное обновление конкретного сервера. */
function updateServer(id, patch) {
  const cfg = load();
  const index = cfg.servers.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`Сервер ${id} не найден`);
  cfg.servers[index] = normalizeOne(merge(cfg.servers[index], patch));
  persist();
  bus.emit('servers');
  return cfg.servers[index];
}

/** Частичное обновление активного сервера. */
function updateActive(patch) {
  const active = activeServer();
  if (!active) throw new Error('Сервер не выбран');
  return updateServer(active.id, patch);
}

/* ------------------------------------------------------- «плоский» вид сервера */

/**
 * Вид, с которым работают все сервисы: глобальные настройки + настройки
 * конкретного сервера, склеенные в одну структуру.
 */
function view(serverId) {
  const cfg = load();
  const instance = serverId ? getServer(serverId) : activeServer();
  if (!instance) throw new Error('Сервер не выбран. Создайте сервер в панели.');

  return {
    id: instance.id,
    name: instance.name,
    installed: instance.installed,
    createdAt: instance.createdAt,
    panel: cfg.panel,
    steam: cfg.steam,
    paths: { ...cfg.paths, ...instance.paths },
    server: instance.server,
    features: instance.features,
    mods: instance.mods
  };
}

const active = (serverId) => view(serverId);

/** Есть ли вообще хоть один сервер. */
function hasServers() {
  return load().servers.length > 0;
}

/* ------------------------------------------------------------- вычисляемые пути */

function deriveWorkshopDir(cfg = load()) {
  const exe = cfg.paths && cfg.paths.steamcmdExe;
  if (!exe) return '';
  return path.join(path.dirname(exe), 'steamapps', 'workshop', 'content', String(cfg.steam.dayzAppId || '221100'));
}

/** Каталог steamapps/workshop (там же лежит appworkshop_<appid>.acf). */
function workshopRoot(v = active()) {
  const content = v.paths.workshopContentDir;
  if (!content) return '';
  return path.resolve(content, '..', '..');
}

const serverExePath = (v = active()) => path.join(v.paths.serverPath, v.paths.serverExe);

function profilesPath(v = active()) {
  const profiles = v.paths.profilesFolder || 'profiles';
  return path.isAbsolute(profiles) ? profiles : path.join(v.paths.serverPath, profiles);
}

function serverCfgPath(v = active()) {
  const file = v.paths.configFile || 'serverDZ.cfg';
  return path.isAbsolute(file) ? file : path.join(v.paths.serverPath, file);
}

function batPath(v = active()) {
  const file = v.paths.batFile || 'start_dayz_server.bat';
  return path.isAbsolute(file) ? file : path.join(v.paths.serverPath, file);
}

/* --------------------------------------------------------- отдача в интерфейс */

/** Конфиг для браузера: секреты наружу не уходят. */
function publicView() {
  const cfg = load();
  const copy = JSON.parse(JSON.stringify(cfg));

  copy.steam.password = '';
  copy.steam.hasPassword = Boolean(cfg.steam.password);
  copy.steam.webApiKey = '';
  copy.steam.hasWebApiKey = Boolean(cfg.steam.webApiKey);

  copy.servers = copy.servers.map((s) => {
    const v = view(s.id);
    return {
      ...s,
      resolved: {
        serverExe: serverExePath(v),
        profiles: profilesPath(v),
        serverCfg: serverCfgPath(v),
        bat: batPath(v),
        workshopRoot: workshopRoot(v)
      }
    };
  });

  return copy;
}

/* -------------------------------------------------------------------- утилиты */

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  load,
  save,
  updateRoot,
  publicView,
  // серверы
  servers,
  getServer,
  activeServer,
  withServer,
  setActive,
  addServer,
  removeServer,
  updateServer,
  updateActive,
  hasServers,
  newId,
  // плоский вид + пути
  active,
  view,
  workshopRoot,
  serverExePath,
  profilesPath,
  serverCfgPath,
  batPath,
  deriveWorkshopDir,
  GLOBAL_PATH_KEYS,
  CONFIG_FILE,
  DEFAULT_FILE
};
