'use strict';

/**
 * Жизненный цикл DayZServer_x64.exe.
 *
 * Кнопка «Старт сервера» выполняет всю подготовку по порядку:
 *   1. проверка путей;
 *   2. открытие портов в брандмауэре (netsh) — если включено;
 *   3. синхронизация serverDZ.cfg с настройками панели;
 *   4. проверка обновлений модов через SteamCMD и раскладка изменившихся;
 *   5. генерация .bat-файла запуска;
 *   6. запуск процесса и подключение слежения за логами профиля.
 *
 * Сервер запускается напрямую (exe с теми же аргументами, что и в .bat),
 * чтобы панель владела PID и могла корректно остановить процесс. Режим
 * features.launchMode = "bat" запускает сгенерированный .bat через cmd.exe.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const config = require('../config');
const logger = require('../logger');
const firewall = require('./firewall');
const batgen = require('./batgen');
const mods = require('./mods');
const serverCfg = require('./serverCfg');
const logTail = require('./logTail');

const SOURCE = 'server';

const events = new EventEmitter();
events.setMaxListeners(0);

const state = {
  status: 'stopped', // stopped | preparing | running | stopping
  pid: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  lastError: null,
  lastStartSummary: null
};

let child = null;

function setStatus(status, patch = {}) {
  Object.assign(state, patch, { status });
  events.emit('status', getStatus());
}

function getStatus() {
  return {
    ...state,
    uptimeSec: state.startedAt && state.status === 'running'
      ? Math.floor((Date.now() - state.startedAt) / 1000)
      : 0
  };
}

/** Проверки, без которых запускать бессмысленно. */
function validate(cfg = config.load()) {
  const problems = [];

  if (!cfg.paths.serverPath) problems.push('Не указан путь к папке сервера');
  else if (!fs.existsSync(cfg.paths.serverPath)) problems.push(`Папка сервера не найдена: ${cfg.paths.serverPath}`);

  const exe = config.serverExePath(cfg);
  if (cfg.paths.serverPath && fs.existsSync(cfg.paths.serverPath) && !fs.existsSync(exe)) {
    problems.push(`Не найден исполняемый файл сервера: ${exe}`);
  }

  if (cfg.features.autoUpdateMods && cfg.mods.some((m) => m.enabled)) {
    if (!cfg.paths.steamcmdExe) problems.push('Включено автообновление модов, но не указан путь к steamcmd.exe');
    else if (!fs.existsSync(cfg.paths.steamcmdExe)) {
      problems.push(`steamcmd.exe не найден: ${cfg.paths.steamcmdExe}`);
    }
  }

  if (!(cfg.server.gamePort > 0 && cfg.server.gamePort < 65536)) problems.push('Некорректный игровой порт');
  if (!(cfg.server.steamQueryPort > 0 && cfg.server.steamQueryPort < 65536)) problems.push('Некорректный Steam query порт');

  return problems;
}

/**
 * Полный цикл запуска.
 * @param {{skipUpdate?: boolean}} [opts]
 */
async function start(opts = {}) {
  if (state.status === 'running' || state.status === 'preparing') {
    throw new Error('Сервер уже запущен или запускается');
  }

  const cfg = config.load();
  const problems = validate(cfg);
  if (problems.length) {
    const message = problems.join('; ');
    setStatus('stopped', { lastError: message });
    throw new Error(message);
  }

  setStatus('preparing', { lastError: null, exitCode: null });
  logger.info(SOURCE, '─'.repeat(58));
  logger.info(SOURCE, `Запуск сервера «${cfg.server.name}»`);

  const summary = { firewall: null, serverCfg: null, mods: null, bat: null, startedAt: null };

  try {
    // 1. Брандмауэр
    if (cfg.features.autoFirewall) {
      summary.firewall = await firewall.apply();
    } else {
      logger.info(SOURCE, 'Автооткрытие портов выключено в настройках');
    }

    // 2. serverDZ.cfg
    if (cfg.features.patchServerCfg) {
      summary.serverCfg = serverCfg.sync();
    }

    // 3. Моды
    if (cfg.features.autoUpdateMods && !opts.skipUpdate) {
      summary.mods = await mods.checkAndUpdate();
    } else {
      logger.info(SOURCE, 'Автообновление модов пропущено — раскладываю включённые моды как есть');
      summary.mods = { deployed: await mods.deployAll(), updated: [], failed: [], skipped: true };
    }

    // 4. .bat — в сводку кладём только путь, само содержимое отдаёт /api/bat
    if (cfg.features.regenerateBatOnStart) {
      const bat = batgen.generate(config.load());
      summary.bat = { path: bat.path, written: bat.written };
    }

    // 5. Процесс
    await spawnServer(config.load());
    summary.startedAt = state.startedAt;
    state.lastStartSummary = summary;

    return { status: getStatus(), summary };
  } catch (err) {
    setStatus('stopped', { lastError: err.message });
    logger.error(SOURCE, `Запуск прерван: ${err.message}`);
    throw err;
  }
}

function spawnServer(cfg) {
  return new Promise((resolve, reject) => {
    const exe = config.serverExePath(cfg);
    const args = batgen.buildArgs(cfg);
    const cwd = cfg.paths.serverPath;

    // Папка профиля должна существовать до старта, иначе логов не будет.
    const profiles = config.profilesPath(cfg);
    try {
      fs.mkdirSync(profiles, { recursive: true });
    } catch (err) {
      logger.warn(SOURCE, `Не удалось создать папку профиля ${profiles}: ${err.message}`);
    }

    let command = exe;
    let commandArgs = args;

    if (cfg.features.launchMode === 'bat') {
      const bat = config.batPath(cfg);
      if (!fs.existsSync(bat)) return reject(new Error(`.bat не найден: ${bat} — сначала сгенерируйте его`));
      command = process.env.ComSpec || 'cmd.exe';
      commandArgs = ['/c', bat];
      logger.info(SOURCE, `Запуск через .bat: ${bat}`);
    } else {
      logger.info(SOURCE, `Запуск: ${path.basename(exe)} ${args.join(' ')}`);
    }

    let proc;
    try {
      proc = spawn(command, commandArgs, { cwd, windowsHide: true });
    } catch (err) {
      return reject(new Error(`Не удалось запустить сервер: ${err.message}`));
    }

    child = proc;
    let settled = false;

    proc.stdout.on('data', (chunk) => logger.info(SOURCE, chunk.toString('utf8')));
    proc.stderr.on('data', (chunk) => logger.warn(SOURCE, chunk.toString('utf8')));

    proc.on('error', (err) => {
      child = null;
      logTail.stop();
      setStatus('stopped', { pid: null, lastError: err.message });
      if (!settled) {
        settled = true;
        reject(new Error(`Ошибка запуска сервера: ${err.message}`));
      }
    });

    proc.on('close', (code, signal) => {
      child = null;
      logTail.stop();
      const wasStopping = state.status === 'stopping';
      setStatus('stopped', {
        pid: null,
        exitCode: code,
        stoppedAt: Date.now()
      });
      const reason = signal ? `сигнал ${signal}` : `код ${code}`;
      if (wasStopping) logger.info(SOURCE, `Сервер остановлен (${reason})`);
      else logger.warn(SOURCE, `Сервер завершился сам (${reason})`);
    });

    const startedAt = Date.now();
    setStatus('running', { pid: proc.pid, startedAt, stoppedAt: null, exitCode: null });
    logger.info(SOURCE, `Сервер запущен, PID ${proc.pid}`);
    logTail.start(startedAt);

    settled = true;
    resolve(proc.pid);
  });
}

/** Остановка сервера. */
function stop({ force = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!child || state.status === 'stopped') {
      return reject(new Error('Сервер не запущен'));
    }

    const pid = child.pid;
    setStatus('stopping');
    logger.info(SOURCE, `Остановка сервера (PID ${pid})…`);

    const done = () => {
      logTail.stop();
      resolve(getStatus());
    };

    if (process.platform === 'win32') {
      // /T — вместе с дочерними процессами, /F — принудительно.
      const args = ['/PID', String(pid), '/T'];
      if (force !== false) args.push('/F');
      execFile('taskkill', args, { windowsHide: true }, (err, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        if (output) logger.info(SOURCE, output);
        if (err && state.status !== 'stopped') {
          logger.warn(SOURCE, `taskkill вернул ошибку: ${err.message}`);
        }
        setTimeout(done, 500);
      });
      return;
    }

    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch (err) {
      logger.warn(SOURCE, `kill: ${err.message}`);
    }
    setTimeout(done, 500);
  });
}

async function restart(opts = {}) {
  if (state.status !== 'stopped') {
    await stop({ force: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
  }
  return start(opts);
}

function onStatus(handler) {
  events.on('status', handler);
  return () => events.off('status', handler);
}

/** Аккуратно погасить сервер при выключении панели. */
function shutdown() {
  if (child) {
    logger.warn(SOURCE, 'Панель завершается — останавливаю сервер');
    return stop({ force: true }).catch(() => {});
  }
  return Promise.resolve();
}

module.exports = { start, stop, restart, getStatus, validate, onStatus, shutdown };
