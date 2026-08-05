'use strict';

/**
 * Работа с конфигурацией панели.
 *
 * Всё состояние (пути, порты, настройки сервера, список модов) лежит в одном
 * JSON-файле config/config.json. При первом запуске он создаётся из
 * config/config.default.json, который остаётся эталоном и не перезаписывается.
 *
 * Любое сохранение проходит через мердж с дефолтом, поэтому после обновления
 * панели новые ключи автоматически появляются в существующем конфиге.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_FILE = path.join(CONFIG_DIR, 'config.default.json');

let cache = null;

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
    for (const key of Object.keys(override)) {
      out[key] = merge(base[key], override[key]);
    }
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
      logger.error('panel', `config.json повреждён (${err.message}), используются значения по умолчанию`);
      const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
      try {
        fs.copyFileSync(CONFIG_FILE, backup);
        logger.warn('panel', `Повреждённый конфиг сохранён как ${backup}`);
      } catch (_) {
        /* не критично */
      }
      stored = {};
    }
  }

  cache = normalize(merge(defaults, stored));

  if (!fs.existsSync(CONFIG_FILE)) {
    save(cache);
    logger.info('panel', `Создан config/config.json — отредактируйте пути в разделе «Настройки»`);
  }

  return cache;
}

function save(next) {
  const defaults = readDefaults();
  cache = normalize(merge(defaults, next));
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return cache;
}

/** Частичное обновление: patch мержится поверх текущего конфига. */
function update(patch) {
  return save(merge(load(), patch));
}

/** Приведение типов и вычисляемые значения (например, путь к workshop-контенту). */
function normalize(cfg) {
  const c = cfg;

  c.panel.port = toInt(c.panel.port, 8787);
  c.server.gamePort = toInt(c.server.gamePort, 2302);
  c.server.steamQueryPort = toInt(c.server.steamQueryPort, 27016);
  c.server.maxPlayers = toInt(c.server.maxPlayers, 60);
  c.server.cpuCount = toInt(c.server.cpuCount, 0);
  c.server.limitFPS = toInt(c.server.limitFPS, 0);

  c.server.extraPorts = (Array.isArray(c.server.extraPorts) ? c.server.extraPorts : [])
    .map((p) => ({
      protocol: String(p.protocol || 'UDP').toUpperCase() === 'TCP' ? 'TCP' : 'UDP',
      from: toInt(p.from, 0),
      to: toInt(p.to, toInt(p.from, 0)),
      comment: p.comment || ''
    }))
    .filter((p) => p.from > 0 && p.to >= p.from);

  c.server.extraArgs = (Array.isArray(c.server.extraArgs) ? c.server.extraArgs : [])
    .map((a) => String(a).trim())
    .filter(Boolean);

  c.mods = (Array.isArray(c.mods) ? c.mods : []).map((m) => ({
    id: String(m.id || '').trim(),
    name: m.name || '',
    folder: m.folder || '',
    enabled: m.enabled !== false,
    type: m.type === 'server' ? 'server' : 'client',
    manifest: m.manifest || '',
    timeupdated: toInt(m.timeupdated, 0),
    lastDeployed: m.lastDeployed || null,
    lastUpdateCheck: m.lastUpdateCheck || null,
    missing: Boolean(m.missing)
  })).filter((m) => m.id);

  if (!c.paths.workshopContentDir) {
    c.paths.workshopContentDir = deriveWorkshopDir(c);
  }

  if (c.features.deployMode !== 'symlink') c.features.deployMode = 'copy';
  if (c.features.launchMode !== 'bat') c.features.launchMode = 'exe';

  return c;
}

/** По умолчанию workshop-контент лежит рядом со steamcmd.exe. */
function deriveWorkshopDir(cfg) {
  const exe = cfg.paths.steamcmdExe;
  if (!exe) return '';
  const dir = path.dirname(exe);
  return path.join(dir, 'steamapps', 'workshop', 'content', String(cfg.steam.dayzAppId || '221100'));
}

/** Каталог steamapps/workshop (там же лежит appworkshop_<appid>.acf). */
function workshopRoot(cfg = load()) {
  const content = cfg.paths.workshopContentDir || deriveWorkshopDir(cfg);
  if (!content) return '';
  // .../steamapps/workshop/content/221100 -> .../steamapps/workshop
  return path.resolve(content, '..', '..');
}

function serverExePath(cfg = load()) {
  return path.join(cfg.paths.serverPath, cfg.paths.serverExe);
}

function profilesPath(cfg = load()) {
  const profiles = cfg.paths.profilesFolder || 'profiles';
  return path.isAbsolute(profiles) ? profiles : path.join(cfg.paths.serverPath, profiles);
}

function serverCfgPath(cfg = load()) {
  const file = cfg.paths.configFile || 'serverDZ.cfg';
  return path.isAbsolute(file) ? file : path.join(cfg.paths.serverPath, file);
}

function batPath(cfg = load()) {
  const file = cfg.paths.batFile || 'start_dayz_server.bat';
  return path.isAbsolute(file) ? file : path.join(cfg.paths.serverPath, file);
}

/** Конфиг для отдачи в браузер: пароль Steam наружу не уходит. */
function publicView(cfg = load()) {
  const copy = JSON.parse(JSON.stringify(cfg));
  copy.steam.password = '';
  copy.steam.hasPassword = Boolean(cfg.steam.password);
  copy._paths = {
    serverExe: serverExePath(cfg),
    profiles: profilesPath(cfg),
    serverCfg: serverCfgPath(cfg),
    bat: batPath(cfg),
    workshopRoot: workshopRoot(cfg)
  };
  return copy;
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  load,
  save,
  update,
  publicView,
  workshopRoot,
  serverExePath,
  profilesPath,
  serverCfgPath,
  batPath,
  deriveWorkshopDir,
  CONFIG_FILE,
  DEFAULT_FILE
};
