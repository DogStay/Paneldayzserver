'use strict';

/**
 * Всё, что связано со SteamCMD.
 *
 * Отвечает за:
 *  - запуск steamcmd.exe с потоковой отдачей вывода в лог панели;
 *  - скачивание/обновление модов Workshop (workshop_download_item);
 *  - определение того, изменилась ли версия мода (по appworkshop_<appid>.acf).
 *
 * Проверка «изменилась ли версия» устроена честно и без Steam Web API:
 * панель запоминает manifest/timeupdated установленного мода ДО запуска
 * SteamCMD и сравнивает их с состоянием ПОСЛЕ. SteamCMD сам решает, качать ли
 * файл; если id манифеста изменился — значит мод обновился, и его нужно
 * заново разложить в папку сервера.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('../config');
const logger = require('../logger');
const vdf = require('../util/vdf');

const SOURCE = 'steamcmd';

let running = null; // текущий дочерний процесс steamcmd (одновременно допускается один)

/** Каталог, который передаётся в +force_install_dir (внутри него появится steamapps/). */
function steamInstallDir(cfg = config.load()) {
  const root = config.workshopRoot(cfg); // .../steamapps/workshop
  if (!root) return '';
  return path.resolve(root, '..', '..'); // .../  (папка, содержащая steamapps)
}

function acfPath(cfg = config.load()) {
  const root = config.workshopRoot(cfg);
  if (!root) return '';
  return path.join(root, `appworkshop_${cfg.steam.dayzAppId || '221100'}.acf`);
}

/**
 * Состояние установленных модов из .acf.
 * @returns {Object<string, {manifest: string, timeupdated: number, remoteTimeupdated: number}>}
 */
function readInstalledState(cfg = config.load()) {
  const file = acfPath(cfg);
  const state = {};
  if (!file || !fs.existsSync(file)) return state;

  let parsed;
  try {
    parsed = vdf.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn(SOURCE, `Не удалось разобрать ${path.basename(file)}: ${err.message}`);
    return state;
  }

  const installed = vdf.findSection(parsed, 'WorkshopItemsInstalled') || {};
  const details = vdf.findSection(parsed, 'WorkshopItemDetails') || {};

  for (const [id, item] of Object.entries(installed)) {
    if (!item || typeof item !== 'object') continue;
    state[id] = {
      manifest: String(item.manifest || ''),
      timeupdated: parseInt(item.timeupdated, 10) || 0,
      remoteTimeupdated: parseInt((details[id] || {}).timeupdated, 10) || 0
    };
  }

  // Мод может быть в details, но ещё не установлен — это тоже полезно знать.
  for (const [id, item] of Object.entries(details)) {
    if (state[id] || !item || typeof item !== 'object') continue;
    state[id] = {
      manifest: '',
      timeupdated: 0,
      remoteTimeupdated: parseInt(item.timeupdated, 10) || 0
    };
  }

  return state;
}

function isBusy() {
  return Boolean(running);
}

/** Путь к скачанному контенту мода. */
function itemPath(id, cfg = config.load()) {
  return path.join(cfg.paths.workshopContentDir, String(id));
}

function itemExists(id, cfg = config.load()) {
  const dir = itemPath(id, cfg);
  return Boolean(dir) && fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
}

/**
 * Низкоуровневый запуск steamcmd.
 * @param {string[]} args
 * @param {{timeoutMs?: number, quiet?: boolean}} [opts]
 * @returns {Promise<{code: number, output: string}>}
 */
function run(args, opts = {}) {
  const cfg = config.load();
  const exe = cfg.paths.steamcmdExe;

  if (!exe) return Promise.reject(new Error('Не указан путь к steamcmd.exe (Настройки → Пути)'));
  if (!fs.existsSync(exe)) return Promise.reject(new Error(`steamcmd.exe не найден: ${exe}`));
  if (running) return Promise.reject(new Error('SteamCMD уже выполняется, дождитесь завершения'));

  const timeoutMs = opts.timeoutMs ?? 45 * 60 * 1000;

  return new Promise((resolve, reject) => {
    logger.info(SOURCE, `> steamcmd ${maskSecrets(args).join(' ')}`);

    const child = spawn(exe, args, {
      cwd: path.dirname(exe),
      windowsHide: true
    });
    running = child;

    let output = '';
    let settled = false;

    const timer = setTimeout(() => {
      logger.error(SOURCE, `Превышено время ожидания (${Math.round(timeoutMs / 60000)} мин), процесс убит`);
      try {
        child.kill();
      } catch (_) {
        /* уже мёртв */
      }
    }, timeoutMs);

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      if (!opts.quiet) logger.info(SOURCE, text);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running = null;
      reject(new Error(`Не удалось запустить steamcmd.exe: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running = null;
      logger.info(SOURCE, `SteamCMD завершился с кодом ${code}`);
      resolve({ code: code ?? -1, output });
    });
  });
}

function cancel() {
  if (!running) return false;
  logger.warn(SOURCE, 'Остановка SteamCMD по запросу пользователя');
  try {
    running.kill();
  } catch (_) {
    /* уже мёртв */
  }
  return true;
}

/** Аргументы авторизации. */
function loginArgs(cfg = config.load()) {
  if (cfg.steam.anonymous || !cfg.steam.username) return ['+login', 'anonymous'];
  const args = ['+login', cfg.steam.username];
  if (cfg.steam.password) args.push(cfg.steam.password);
  return args;
}

function maskSecrets(args) {
  const cfg = config.load();
  if (!cfg.steam.password) return args;
  return args.map((a) => (a === cfg.steam.password ? '***' : a));
}

/**
 * Скачать/обновить один или несколько модов одним запуском SteamCMD и
 * определить, какие из них реально изменились.
 *
 * @param {string[]} ids Workshop ID
 * @param {{validate?: boolean}} [opts]
 * @returns {Promise<{results: Array<{id: string, status: 'updated'|'installed'|'up-to-date'|'failed', manifest: string, timeupdated: number, error?: string}>, code: number}>}
 */
async function downloadItems(ids, opts = {}) {
  const cfg = config.load();
  const list = [...new Set(ids.map(String).filter(Boolean))];
  if (!list.length) return { results: [], code: 0 };

  const appId = String(cfg.steam.dayzAppId || '221100');
  const before = readInstalledState(cfg);
  const existedBefore = Object.fromEntries(list.map((id) => [id, itemExists(id, cfg)]));

  const args = [];
  const installDir = steamInstallDir(cfg);
  if (installDir) args.push('+force_install_dir', installDir);
  args.push(...loginArgs(cfg));
  for (const id of list) {
    args.push('+workshop_download_item', appId, id);
    if (opts.validate) args.push('validate');
  }
  args.push('+quit');

  const { code, output } = await run(args);
  const after = readInstalledState(config.load());

  const results = list.map((id) => {
    const prev = before[id] || { manifest: '', timeupdated: 0 };
    const next = after[id] || { manifest: '', timeupdated: 0 };
    const onDisk = itemExists(id, cfg);

    if (!onDisk) {
      return {
        id,
        status: 'failed',
        manifest: next.manifest,
        timeupdated: next.timeupdated,
        error: detectError(output, id) || 'Папка мода не появилась в workshop/content'
      };
    }

    const changed =
      (next.manifest && next.manifest !== prev.manifest) ||
      (next.timeupdated && next.timeupdated !== prev.timeupdated);

    let status = 'up-to-date';
    if (!existedBefore[id]) status = 'installed';
    else if (changed) status = 'updated';

    return { id, status, manifest: next.manifest, timeupdated: next.timeupdated };
  });

  return { results, code };
}

/** Достаём осмысленную причину сбоя из вывода SteamCMD. */
function detectError(output, id) {
  const re = new RegExp(`ERROR!\\s*Download item ${id} failed \\(([^)]+)\\)`, 'i');
  const match = output.match(re);
  if (match) return match[1];
  if (/Login Failure|Invalid Password|Rate Limit/i.test(output)) {
    return 'Ошибка входа в Steam — проверьте логин/пароль и Steam Guard';
  }
  if (/No subscription/i.test(output)) {
    return 'No subscription — аккаунт Steam не владеет DayZ';
  }
  return null;
}

/** Обновление самого серверного приложения DayZ (app 223350). Вызывается по кнопке. */
async function updateServerApp() {
  const cfg = config.load();
  const args = [];
  if (cfg.paths.serverPath) args.push('+force_install_dir', cfg.paths.serverPath);
  args.push(...loginArgs(cfg));
  args.push('+app_update', String(cfg.steam.serverAppId || '223350'), 'validate', '+quit');
  return run(args);
}

/** Разовая проверка доступности steamcmd.exe. */
function health() {
  const cfg = config.load();
  const exe = cfg.paths.steamcmdExe;
  return {
    exe,
    exists: Boolean(exe && fs.existsSync(exe)),
    workshopContentDir: cfg.paths.workshopContentDir,
    workshopContentExists: Boolean(cfg.paths.workshopContentDir && fs.existsSync(cfg.paths.workshopContentDir)),
    acf: acfPath(cfg),
    acfExists: Boolean(acfPath(cfg) && fs.existsSync(acfPath(cfg))),
    anonymous: Boolean(cfg.steam.anonymous || !cfg.steam.username),
    busy: isBusy()
  };
}

module.exports = {
  run,
  cancel,
  isBusy,
  downloadItems,
  updateServerApp,
  readInstalledState,
  itemPath,
  itemExists,
  steamInstallDir,
  acfPath,
  health
};
