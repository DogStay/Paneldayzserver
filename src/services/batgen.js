'use strict';

/**
 * Генерация .bat-файла запуска сервера и набора аргументов командной строки.
 *
 * Один и тот же список аргументов используется и для .bat, и для прямого
 * запуска DayZServer_x64.exe из панели — так поведение кнопки «Старт» и
 * ручного запуска .bat всегда совпадает.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');
const mods = require('./mods');

const SOURCE = 'bat';

/**
 * Аргументы запуска DayZServer_x64.exe.
 * @returns {string[]}
 */
function buildArgs(cfg = config.active()) {
  const args = [];

  args.push(`-config=${cfg.paths.configFile || 'serverDZ.cfg'}`);
  args.push(`-port=${cfg.server.gamePort}`);
  args.push(`-profiles=${cfg.paths.profilesFolder || 'profiles'}`);

  const { modParam, serverModParam } = mods.buildModParams(cfg);
  if (modParam) args.push(modParam);
  if (serverModParam) args.push(serverModParam);

  if (cfg.server.cpuCount > 0) args.push(`-cpuCount=${cfg.server.cpuCount}`);
  if (cfg.server.limitFPS > 0) args.push(`-limitFPS=${cfg.server.limitFPS}`);

  for (const extra of cfg.server.extraArgs) {
    if (!args.some((a) => a.split('=')[0] === extra.split('=')[0])) args.push(extra);
  }

  return args;
}

/** Аргумент в виде, пригодном для вставки в .bat (кавычки там, где нужно). */
function quoteArg(arg) {
  return /[\s;&^]/.test(arg) ? `"${arg}"` : arg;
}

function buildCommandLine(cfg = config.active()) {
  return [quoteArg(cfg.paths.serverExe), ...buildArgs(cfg).map(quoteArg)].join(' ');
}

/** Текст .bat-файла. */
function buildBatContent(cfg = config.active()) {
  const { clientMods, serverMods } = mods.buildModParams(cfg);
  const stamp = new Date().toLocaleString('ru-RU');

  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    `title DayZ Server - ${cfg.server.name}`,
    'rem ==========================================================',
    'rem  Файл сгенерирован автоматически панелью DayZ Panel',
    `rem  Дата генерации: ${stamp}`,
    'rem  Ручные правки будут перезаписаны при следующем запуске',
    'rem  из панели. Меняйте параметры в разделе «Настройки».',
    'rem ==========================================================',
    '',
    `set "SERVER_DIR=${cfg.paths.serverPath}"`,
    `set "SERVER_EXE=${cfg.paths.serverExe}"`,
    `set "GAME_PORT=${cfg.server.gamePort}"`,
    `set "QUERY_PORT=${cfg.server.steamQueryPort}"`,
    '',
    'cd /d "%SERVER_DIR%"',
    'if errorlevel 1 (',
    '    echo [ОШИБКА] Не найдена папка сервера: %SERVER_DIR%',
    '    pause',
    '    exit /b 1',
    ')',
    'if not exist "%SERVER_EXE%" (',
    '    echo [ОШИБКА] Не найден %SERVER_EXE% в %SERVER_DIR%',
    '    pause',
    '    exit /b 1',
    ')',
    '',
    `echo Сервер:     ${cfg.server.name}`,
    'echo Игровой порт: %GAME_PORT% (UDP)',
    'echo Query порт:   %QUERY_PORT%',
    `echo Модов включено: ${clientMods.length + serverMods.length}`,
    ''
  ];

  if (clientMods.length) {
    lines.push('rem Клиентские моды (-mod):');
    clientMods.forEach((m) => lines.push(`rem   ${m}`));
  }
  if (serverMods.length) {
    lines.push('rem Серверные моды (-serverMod):');
    serverMods.forEach((m) => lines.push(`rem   ${m}`));
  }
  if (clientMods.length || serverMods.length) lines.push('');

  lines.push(buildCommandLine(cfg));
  lines.push('');
  lines.push('rem Код возврата сервера остаётся в %ERRORLEVEL%');
  lines.push('exit /b %ERRORLEVEL%');
  lines.push('');

  return lines.join('\r\n');
}

/**
 * Записать .bat на диск.
 * @returns {{path: string, content: string, written: boolean}}
 */
function generate(cfg = config.active()) {
  const target = config.batPath(cfg);
  const content = buildBatContent(cfg);

  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    throw new Error(`Папка для .bat не найдена: ${dir}`);
  }

  let written = true;
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) {
    written = false;
    logger.info(SOURCE, `.bat уже актуален: ${target}`);
  } else {
    fs.writeFileSync(target, content, 'utf8');
    logger.info(SOURCE, `Сгенерирован ${target}`);
  }

  return { path: target, content, written };
}

/** Предпросмотр для веб-интерфейса — без записи на диск. */
function preview(cfg = config.active()) {
  return {
    path: config.batPath(cfg),
    content: buildBatContent(cfg),
    commandLine: buildCommandLine(cfg),
    args: buildArgs(cfg)
  };
}

module.exports = { buildArgs, buildCommandLine, buildBatContent, generate, preview };
