'use strict';

/**
 * Всё, что связано со SteamCMD.
 *
 *  - запуск steamcmd.exe с потоковой отдачей вывода в лог панели;
 *  - разбор прогресса загрузки (для прогресс-баров в интерфейсе);
 *  - установка/обновление серверных файлов DayZ (app_update 223350);
 *  - скачивание модов Workshop (workshop_download_item);
 *  - определение того, изменилась ли версия мода (по appworkshop_<appid>.acf).
 *
 * Проверка «изменилась ли версия» работает без Steam Web API: панель
 * запоминает manifest/timeupdated установленного мода ДО запуска SteamCMD и
 * сравнивает с состоянием ПОСЛЕ. SteamCMD сам решает, качать ли файл; если
 * манифест изменился — мод обновился и его нужно заново разложить.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('../config');
const logger = require('../logger');
const vdf = require('../util/vdf');

const SOURCE = 'steamcmd';

let running = null; // одновременно допускается один процесс steamcmd

/* ------------------------------------------------------------------- пути */

/** Каталог, который передаётся в +force_install_dir для модов. */
function steamInstallDir(v = config.active()) {
  const root = config.workshopRoot(v); // .../steamapps/workshop
  return root ? path.resolve(root, '..', '..') : '';
}

function acfPath(v = config.active()) {
  const root = config.workshopRoot(v);
  return root ? path.join(root, `appworkshop_${v.steam.dayzAppId || '221100'}.acf`) : '';
}

const itemPath = (id, v = config.active()) => path.join(v.paths.workshopContentDir, String(id));

function itemExists(id, v = config.active()) {
  const dir = itemPath(id, v);
  try {
    return Boolean(dir) && fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch (_) {
    return false;
  }
}

/* --------------------------------------------------------- состояние из .acf */

/**
 * Установленные моды из appworkshop_<appid>.acf.
 * @returns {Object<string, {manifest: string, timeupdated: number, remoteTimeupdated: number}>}
 */
function readInstalledState(v = config.active()) {
  const file = acfPath(v);
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
  for (const [id, item] of Object.entries(details)) {
    if (state[id] || !item || typeof item !== 'object') continue;
    state[id] = { manifest: '', timeupdated: 0, remoteTimeupdated: parseInt(item.timeupdated, 10) || 0 };
  }
  return state;
}

/* ------------------------------------------------------------------ запуск */

const isBusy = () => Boolean(running);

/**
 * Низкоуровневый запуск steamcmd.
 * @param {string[]} args
 * @param {{timeoutMs?: number, quiet?: boolean, onProgress?: Function, onLine?: Function}} [opts]
 * @returns {Promise<{code: number, output: string}>}
 */
function run(args, opts = {}) {
  const v = config.load();
  const exe = v.paths.steamcmdExe;

  if (!exe) return Promise.reject(new Error('Не указан путь к steamcmd.exe (Настройки → SteamCMD)'));
  if (!fs.existsSync(exe)) return Promise.reject(new Error(`steamcmd.exe не найден: ${exe}`));
  if (running) return Promise.reject(new Error('SteamCMD уже выполняется, дождитесь завершения текущей операции'));

  const timeoutMs = opts.timeoutMs ?? 90 * 60 * 1000;

  return new Promise((resolve, reject) => {
    logger.info(SOURCE, `> steamcmd ${maskSecrets(args).join(' ')}`);

    let child;
    try {
      child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
    } catch (err) {
      return reject(new Error(`Не удалось запустить steamcmd.exe: ${err.message}`));
    }
    running = child;

    let output = '';
    let settled = false;
    let carry = '';

    const timer = setTimeout(() => {
      logger.error(SOURCE, `Превышено время ожидания (${Math.round(timeoutMs / 60000)} мин), процесс остановлен`);
      try {
        child.kill();
      } catch (_) {
        /* уже мёртв */
      }
    }, timeoutMs);

    const handle = (chunk) => {
      const text = chunk.toString('utf8');
      output += text;

      // SteamCMD печатает прогресс без перевода строки, поэтому режем по \r тоже.
      carry += text;
      const parts = carry.split(/\r\n|\r|\n/);
      carry = parts.pop() ?? '';

      for (const line of parts) {
        if (!line.trim()) continue;
        if (!opts.quiet) logger.info(SOURCE, line);
        if (opts.onLine) opts.onLine(line);
        const progress = parseProgress(line);
        if (progress && opts.onProgress) opts.onProgress(progress);
      }
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running = null;
      reject(new Error(`Не удалось запустить steamcmd.exe: ${err.message}`));
    });

    child.on('close', (code) => {
      if (carry.trim() && !opts.quiet) logger.info(SOURCE, carry);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running = null;
      logger.info(SOURCE, `SteamCMD завершился с кодом ${code}`);
      resolve({ code: code ?? -1, output });
    });
  });
}

/**
 * Разбор строк прогресса SteamCMD.
 * Примеры:
 *   Update state (0x61) downloading, progress: 42.55 (1234 / 5678)
 *   Downloading item 1559212036 ...
 */
function parseProgress(line) {
  const state = line.match(/Update state \(0x\d+\)\s*([^,]+),\s*progress:\s*([\d.]+)\s*(?:\((\d+)\s*\/\s*(\d+)\))?/i);
  if (state) {
    return {
      percent: parseFloat(state[2]) || 0,
      phase: translatePhase(state[1].trim()),
      bytes: state[3] ? parseInt(state[3], 10) : 0,
      totalBytes: state[4] ? parseInt(state[4], 10) : 0
    };
  }
  if (/^\s*Downloading item\s+(\d+)/i.test(line)) {
    return { percent: null, phase: 'Скачивание мода' };
  }
  if (/Success\.\s*Downloaded item/i.test(line)) {
    return { percent: 100, phase: 'Мод скачан' };
  }
  return null;
}

function translatePhase(phase) {
  const map = {
    downloading: 'Загрузка',
    verifying: 'Проверка файлов',
    preallocating: 'Подготовка места',
    committing: 'Применение',
    validating: 'Валидация',
    reconfiguring: 'Настройка'
  };
  return map[phase.toLowerCase()] || phase;
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

/* ---------------------------------------------------------------- логин */

function loginArgs(cfg = config.load()) {
  if (cfg.steam.anonymous || !cfg.steam.username) return ['+login', 'anonymous'];
  const args = ['+login', cfg.steam.username];
  if (cfg.steam.password) args.push(cfg.steam.password);
  return args;
}

function maskSecrets(args) {
  const cfg = config.load();
  if (!cfg.steam.password) return args;
  return args.map((a) => (a === cfg.steam.password ? '******' : a));
}

/* -------------------------------------------------------- установка сервера */

/**
 * Установка/обновление серверных файлов DayZ (app 223350) в указанную папку.
 * @param {string} targetDir
 * @param {{onProgress?: Function, validate?: boolean}} [opts]
 */
async function installServerApp(targetDir, opts = {}) {
  const cfg = config.load();
  if (!targetDir) throw new Error('Не указана папка установки сервера');

  fs.mkdirSync(targetDir, { recursive: true });

  const args = ['+force_install_dir', targetDir, ...loginArgs(cfg), '+app_update', String(cfg.steam.serverAppId || '223350')];
  if (opts.validate !== false) args.push('validate');
  args.push('+quit');

  const { code, output } = await run(args, { onProgress: opts.onProgress, timeoutMs: 4 * 60 * 60 * 1000 });

  const failure = detectError(output);
  if (failure) throw new Error(failure);
  if (code !== 0 && !/Success! App '\d+' fully installed|already up to date/i.test(output)) {
    throw new Error(`SteamCMD завершился с кодом ${code}. Подробности в логе.`);
  }
  return { code, output };
}

/* ------------------------------------------------------------- моды */

/**
 * Скачать/обновить моды одним запуском SteamCMD и определить, что изменилось.
 * @param {string[]} ids
 * @param {{validate?: boolean, onProgress?: Function, onItemDone?: Function}} [opts]
 */
async function downloadItems(ids, opts = {}) {
  const v = config.active();
  const list = [...new Set(ids.map(String).filter(Boolean))];
  if (!list.length) return { results: [], code: 0 };

  const appId = String(v.steam.dayzAppId || '221100');
  const before = readInstalledState(v);
  const existedBefore = Object.fromEntries(list.map((id) => [id, itemExists(id, v)]));

  const args = [];
  const installDir = steamInstallDir(v);
  if (installDir) args.push('+force_install_dir', installDir);
  args.push(...loginArgs(config.load()));
  for (const id of list) {
    args.push('+workshop_download_item', appId, id);
    if (opts.validate) args.push('validate');
  }
  args.push('+quit');

  let doneCount = 0;
  const { code, output } = await run(args, {
    onProgress: opts.onProgress,
    onLine: (line) => {
      const m = line.match(/Success\.\s*Downloaded item\s+(\d+)/i);
      if (m) {
        doneCount++;
        if (opts.onItemDone) opts.onItemDone(m[1], doneCount, list.length);
      }
    }
  });

  const after = readInstalledState(config.active());

  const results = list.map((id) => {
    const prev = before[id] || { manifest: '', timeupdated: 0 };
    const next = after[id] || { manifest: '', timeupdated: 0 };

    if (!itemExists(id, v)) {
      return {
        id,
        status: 'failed',
        manifest: next.manifest,
        timeupdated: next.timeupdated,
        error: detectItemError(output, id) || detectError(output) || 'Папка мода не появилась в workshop/content'
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

/* ------------------------------------------------------------ разбор ошибок */

function detectItemError(output, id) {
  const match = output.match(new RegExp(`ERROR!\\s*Download item ${id} failed \\(([^)]+)\\)`, 'i'));
  return match ? match[1] : null;
}

function detectError(output) {
  if (/Login Failure:\s*Invalid Password|Invalid Password/i.test(output)) {
    return 'Неверный логин или пароль Steam';
  }
  if (/Rate Limit Exceeded/i.test(output)) {
    return 'Steam временно ограничил число попыток входа — подождите 10–30 минут';
  }
  if (/Two-factor code mismatch|Steam Guard/i.test(output)) {
    return 'Требуется код Steam Guard. Выполните вход вручную: steamcmd +login ЛОГИН +quit';
  }
  if (/No subscription/i.test(output)) {
    return 'No subscription — аккаунт Steam не владеет DayZ';
  }
  if (/ERROR!\s*Failed to install app.*(Disk write failure|No space)/i.test(output)) {
    return 'Недостаточно места на диске или нет прав на запись в папку установки';
  }
  if (/Failed to install app '\d+' \(([^)]+)\)/i.test(output)) {
    return `Steam вернул ошибку: ${output.match(/Failed to install app '\d+' \(([^)]+)\)/i)[1]}`;
  }
  return null;
}

/* ----------------------------------------------------------------- здоровье */

function health() {
  const cfg = config.load();
  const exe = cfg.paths.steamcmdExe;
  const workshop = cfg.paths.workshopContentDir;
  const acf = cfg.servers.length ? acfPath(config.active()) : '';

  return {
    exe,
    exists: Boolean(exe && fs.existsSync(exe)),
    workshopContentDir: workshop,
    workshopContentExists: Boolean(workshop && fs.existsSync(workshop)),
    acf,
    acfExists: Boolean(acf && fs.existsSync(acf)),
    anonymous: Boolean(cfg.steam.anonymous || !cfg.steam.username),
    hasCredentials: Boolean(cfg.steam.username),
    busy: isBusy()
  };
}

module.exports = {
  run,
  cancel,
  isBusy,
  installServerApp,
  downloadItems,
  readInstalledState,
  itemPath,
  itemExists,
  steamInstallDir,
  acfPath,
  parseProgress,
  detectError,
  health
};
