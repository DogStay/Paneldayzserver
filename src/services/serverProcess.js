'use strict';

/**
 * Жизненный цикл DayZServer_x64.exe. Каждый сервер панели живёт независимо:
 * своё состояние, свой процесс, свой «хвостовик» логов.
 *
 * Кнопка «Запустить» выполняет всю подготовку по порядку:
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
 *
 * Если сервер падает сам — панель пишет подробный отчёт в logs/crash-*.txt.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const config = require('../config');
const logger = require('../logger');
const bus = require('../events');
const firewall = require('./firewall');
const batgen = require('./batgen');
const mods = require('./mods');
const serverCfg = require('./serverCfg');
const logTail = require('./logTail');
const diagnostics = require('./diagnostics');
const modIssues = require('./modIssues');

const SOURCE = 'server';
const RECENT_LINES = 250;

/** serverId -> состояние */
const instances = new Map();

function instance(serverId) {
  if (!instances.has(serverId)) {
    instances.set(serverId, {
      serverId,
      status: 'stopped', // stopped | preparing | running | stopping
      pid: null,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
      lastError: null,
      lastCrashReport: null,
      lastStartSummary: null,
      lastIssues: [],
      child: null,
      tailer: null,
      collector: null,
      issueTimer: null,
      warnedDialog: false,
      recent: []
    });
  }
  return instances.get(serverId);
}

function remember(inst, line) {
  inst.recent.push(line);
  if (inst.recent.length > RECENT_LINES) inst.recent.shift();
}

/** Разобрать строку сервера и, если это проблема с модами, запомнить её. */
function feedIssue(serverId, line) {
  const inst = instance(serverId);
  if (!inst.collector) return;
  if (inst.collector.feed(line)) noteIssuesSoon(serverId);
}

/**
 * Живой разбор проблем с модами.
 *
 * Ждать падения сервера нельзя: на ошибку вида «Addon 'X' requires addon 'Y'»
 * движок показывает модальное окно и просто стоит, пока кто-нибудь не нажмёт
 * OK. Снаружи это выглядит как «сервер запущен, но его нет в списке».
 * Поэтому выводы делаются прямо во время работы и сразу уезжают в интерфейс.
 */
function noteIssuesSoon(serverId) {
  const inst = instance(serverId);
  if (inst.issueTimer) return; // строки идут пачками — разбираем их разом

  inst.issueTimer = setTimeout(() => {
    inst.issueTimer = null;

    let issues = [];
    try {
      const v = config.active(serverId);
      issues = modIssues.summarize(inst.collector ? inst.collector.list() : [], v.mods, {
        serverPath: v.paths.serverPath
      });
    } catch (_) {
      return; // конфиг мог смениться — разбор не критичен
    }

    const known = new Set((inst.lastIssues || []).map((i) => i.title));
    const fresh = issues.filter((i) => !known.has(i.title));
    if (!fresh.length) return;

    inst.lastIssues = issues;

    for (const issue of fresh) {
      logger.error(SOURCE, `Проблема с модами: ${issue.title}`, { serverId });
      for (const line of issue.detail.split('\n')) logger.warn(SOURCE, `  ${line}`, { serverId });
    }

    if (!inst.warnedDialog) {
      inst.warnedDialog = true;
      logger.warn(
        SOURCE,
        'Если на экране сервера висит окно DayZ с этой ошибкой — нажмите в нём OK: пока окно открыто, ' +
          'запуск стоит на месте. Чтобы окно больше не появлялось, устраните причину выше.',
        { serverId }
      );
    }

    bus.emit('status', getStatus(serverId));
  }, 4000);

  if (inst.issueTimer.unref) inst.issueTimer.unref();
}

function setStatus(inst, status, patch = {}) {
  Object.assign(inst, patch, { status });
  bus.emit('status', getStatus(inst.serverId));
}

function getStatus(serverId) {
  const inst = instance(serverId);
  return {
    serverId,
    status: inst.status,
    pid: inst.pid,
    startedAt: inst.startedAt,
    stoppedAt: inst.stoppedAt,
    exitCode: inst.exitCode,
    lastError: inst.lastError,
    lastCrashReport: inst.lastCrashReport,
    lastStartSummary: inst.lastStartSummary,
    lastIssues: inst.lastIssues,
    uptimeSec: inst.startedAt && inst.status === 'running' ? Math.floor((Date.now() - inst.startedAt) / 1000) : 0
  };
}

/** Статусы всех известных серверов. */
function allStatuses() {
  const out = {};
  for (const server of config.servers()) out[server.id] = getStatus(server.id);
  return out;
}

const isRunning = (serverId) => instance(serverId).status === 'running';

/* --------------------------------------------------------------- проверки */

/** Проблемы, из-за которых запуск бессмысленен. */
function validate(serverId) {
  const problems = [];
  let v;
  try {
    v = config.active(serverId);
  } catch (err) {
    return [err.message];
  }

  if (!v.paths.serverPath) problems.push('Не указан путь к папке сервера');
  else if (!fs.existsSync(v.paths.serverPath)) problems.push(`Папка сервера не найдена: ${v.paths.serverPath}`);

  const exe = config.serverExePath(v);
  if (v.paths.serverPath && fs.existsSync(v.paths.serverPath) && !fs.existsSync(exe)) {
    problems.push(`Не найден исполняемый файл сервера: ${exe}. Установите файлы сервера через SteamCMD.`);
  }

  if (v.features.autoUpdateMods && v.mods.some((m) => m.enabled)) {
    if (!v.paths.steamcmdExe) problems.push('Включено автообновление модов, но не указан путь к steamcmd.exe');
    else if (!fs.existsSync(v.paths.steamcmdExe)) problems.push(`steamcmd.exe не найден: ${v.paths.steamcmdExe}`);
  }

  if (!(v.server.gamePort > 0 && v.server.gamePort < 65536)) problems.push('Некорректный игровой порт');
  if (!(v.server.steamQueryPort > 0 && v.server.steamQueryPort < 65536)) problems.push('Некорректный Steam query порт');

  return problems;
}

/* ------------------------------------------------------------------ запуск */

/**
 * Полный цикл запуска.
 * @param {string} serverId
 * @param {{skipUpdate?: boolean, onProgress?: Function}} [opts]
 */
async function start(serverId, opts = {}) {
  const inst = instance(serverId);
  if (inst.status === 'running' || inst.status === 'preparing') {
    throw new Error('Сервер уже запущен или запускается');
  }

  const v = config.active(serverId);
  const problems = validate(serverId);
  if (problems.length) {
    const message = problems.join('; ');
    setStatus(inst, 'stopped', { lastError: message });
    throw new Error(message);
  }

  const progress = (percent, step) => opts.onProgress && opts.onProgress({ percent, step });

  setStatus(inst, 'preparing', { lastError: null, exitCode: null, lastCrashReport: null, lastIssues: [] });
  inst.recent = [];
  inst.warnedDialog = false;
  inst.collector = modIssues.createCollector();
  logger.info(SOURCE, '─'.repeat(60), { serverId });
  logger.info(SOURCE, `Запуск сервера «${v.server.name}»`, { serverId });

  const summary = { firewall: null, serverCfg: null, mods: null, bat: null, startedAt: null };

  try {
    progress(5, 'Открываю порты в брандмауэре');
    if (v.features.autoFirewall) summary.firewall = await firewall.apply();
    else logger.info(SOURCE, 'Автооткрытие портов выключено в настройках', { serverId });

    progress(15, 'Обновляю serverDZ.cfg');
    if (v.features.patchServerCfg) summary.serverCfg = serverCfg.sync(serverId);

    if (v.features.autoUpdateMods && !opts.skipUpdate) {
      progress(25, 'Проверяю обновления модов');
      summary.mods = await mods.checkAndUpdate({
        onProgress: (p) => progress(25 + (p.percent || 0) * 0.6, p.step)
      });
    } else {
      progress(40, 'Раскладываю моды');
      logger.info(SOURCE, 'Автообновление модов пропущено — раскладываю включённые моды как есть', { serverId });
      summary.mods = { deployed: await mods.deployAll(), updated: [], failed: [], skipped: true };
    }

    progress(88, 'Генерирую .bat запуска');
    if (v.features.regenerateBatOnStart) {
      const bat = batgen.generate(config.active(serverId));
      summary.bat = { path: bat.path, written: bat.written };
    }

    progress(94, 'Запускаю процесс сервера');
    await spawnServer(serverId, config.active(serverId));

    summary.startedAt = inst.startedAt;
    inst.lastStartSummary = summary;
    progress(100, 'Сервер запущен');

    return { status: getStatus(serverId), summary };
  } catch (err) {
    setStatus(inst, 'stopped', { lastError: err.message });
    logger.error(SOURCE, `Запуск прерван: ${err.message}`, { serverId });

    const report = diagnostics.writeCrashReport({
      serverId,
      reason: `Запуск прерван: ${err.message}`,
      status: getStatus(serverId),
      recent: inst.recent
    });
    if (report) {
      inst.lastCrashReport = report;
      bus.emit('status', getStatus(serverId));
    }
    throw err;
  }
}

function spawnServer(serverId, v) {
  const inst = instance(serverId);

  return new Promise((resolve, reject) => {
    const exe = config.serverExePath(v);
    const args = batgen.buildArgs(v);
    const cwd = v.paths.serverPath;

    // Папка профиля должна существовать до старта, иначе логов не будет.
    const profiles = config.profilesPath(v);
    try {
      fs.mkdirSync(profiles, { recursive: true });
    } catch (err) {
      logger.warn(SOURCE, `Не удалось создать папку профиля ${profiles}: ${err.message}`, { serverId });
    }

    let command = exe;
    let commandArgs = args;

    if (v.features.launchMode === 'bat') {
      const bat = config.batPath(v);
      if (!fs.existsSync(bat)) return reject(new Error(`.bat не найден: ${bat} — сначала сгенерируйте его`));
      command = process.env.ComSpec || 'cmd.exe';
      commandArgs = ['/c', bat];
      logger.info(SOURCE, `Запуск через .bat: ${bat}`, { serverId });
    } else {
      logger.info(SOURCE, `Запуск: ${path.basename(exe)} ${args.join(' ')}`, { serverId });
    }

    let proc;
    try {
      proc = spawn(command, commandArgs, { cwd, windowsHide: true });
    } catch (err) {
      return reject(new Error(`Не удалось запустить сервер: ${err.message}`));
    }

    inst.child = proc;

    const onOutput = (chunk, level) => {
      const text = chunk.toString('utf8');
      remember(inst, text.trim());
      for (const line of text.split(/\r?\n/)) feedIssue(serverId, line);
      logger.log(SOURCE, text, level, { serverId });
    };
    proc.stdout.on('data', (c) => onOutput(c, 'info'));
    proc.stderr.on('data', (c) => onOutput(c, 'warn'));

    let settled = false;

    proc.on('error', (err) => {
      inst.child = null;
      if (inst.tailer) inst.tailer.stop();
      setStatus(inst, 'stopped', { pid: null, lastError: err.message });
      if (!settled) {
        settled = true;
        reject(new Error(`Ошибка запуска сервера: ${err.message}`));
      }
    });

    proc.on('close', (code, signal) => {
      inst.child = null;
      if (inst.tailer) {
        inst.tailer.poll(); // дочитываем хвост лога перед остановкой
        inst.tailer.stop();
      }

      const wasStopping = inst.status === 'stopping';
      const ranFor = inst.startedAt ? Date.now() - inst.startedAt : 0;
      setStatus(inst, 'stopped', { pid: null, exitCode: code, stoppedAt: Date.now() });

      const reason = signal ? `сигнал ${signal}` : `код ${code}`;
      if (wasStopping) {
        logger.info(SOURCE, `Сервер остановлен (${reason})`, { serverId });
        return;
      }

      logger.error(SOURCE, `Сервер завершился сам (${reason}), проработав ${Math.round(ranFor / 1000)} с`, {
        serverId
      });

      // Движок DayZ ругается на своём языке — переводим в понятные выводы.
      let issues = [];
      try {
        const v = config.active(serverId);
        issues = modIssues.summarize(inst.collector ? inst.collector.list() : [], v.mods, {
          serverPath: v.paths.serverPath
        });
      } catch (_) {
        /* конфиг мог поменяться — разбор не критичен */
      }
      inst.lastIssues = issues;

      for (const issue of issues) {
        logger.error(SOURCE, `Вероятная причина: ${issue.title}`, { serverId });
        for (const line of issue.detail.split('\n')) logger.warn(SOURCE, `  ${line}`, { serverId });
      }

      const report = diagnostics.writeCrashReport({
        serverId,
        reason: `Сервер завершился сам: ${reason}, аптайм ${Math.round(ranFor / 1000)} с`,
        status: getStatus(serverId),
        recent: inst.recent,
        issues
      });
      if (report) {
        inst.lastCrashReport = report;
        inst.lastError = issues.length
          ? issues[0].title
          : `Сервер неожиданно завершился (${reason}). Отчёт: ${path.basename(report)}`;
        logger.warn(SOURCE, `Подробный отчёт для диагностики: ${report}`, { serverId });
        bus.emit('status', getStatus(serverId));
      }
    });

    const startedAt = Date.now();
    setStatus(inst, 'running', { pid: proc.pid, startedAt, stoppedAt: null, exitCode: null });
    logger.info(SOURCE, `Сервер запущен, PID ${proc.pid}`, { serverId });

    inst.tailer = logTail.createTailer(serverId, {
      onLine: (line) => {
        remember(inst, line);
        feedIssue(serverId, line);
      }
    });
    inst.tailer.start(startedAt);

    settled = true;
    resolve(proc.pid);
  });
}

/* --------------------------------------------------------------- остановка */

function stop(serverId, { force = true } = {}) {
  const inst = instance(serverId);

  return new Promise((resolve, reject) => {
    if (!inst.child || inst.status === 'stopped') return reject(new Error('Сервер не запущен'));

    const pid = inst.child.pid;
    setStatus(inst, 'stopping');
    logger.info(SOURCE, `Остановка сервера (PID ${pid})…`, { serverId });

    const done = () => {
      if (inst.tailer) inst.tailer.stop();
      resolve(getStatus(serverId));
    };

    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      execFile('taskkill', args, { windowsHide: true }, (err, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        if (output) logger.info(SOURCE, output, { serverId });
        if (err && inst.status !== 'stopped') logger.warn(SOURCE, `taskkill: ${err.message}`, { serverId });
        setTimeout(done, 600);
      });
      return;
    }

    try {
      inst.child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch (err) {
      logger.warn(SOURCE, `kill: ${err.message}`, { serverId });
    }
    setTimeout(done, 600);
  });
}

async function restart(serverId, opts = {}) {
  if (instance(serverId).status !== 'stopped') {
    await stop(serverId).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
  }
  return start(serverId, opts);
}

/** Аккуратно погасить все серверы при выключении панели. */
async function shutdown() {
  for (const [serverId, inst] of instances) {
    if (!inst.child) continue;
    logger.warn(SOURCE, 'Панель завершается — останавливаю сервер', { serverId });
    await stop(serverId).catch(() => {});
  }
}

/** Последние строки вывода сервера — попадают в диагностический отчёт. */
const recentOutput = (serverId) => instance(serverId).recent.slice();

module.exports = {
  start,
  stop,
  restart,
  getStatus,
  allStatuses,
  isRunning,
  validate,
  shutdown,
  recentOutput
};
