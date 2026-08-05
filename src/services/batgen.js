'use strict';

/**
 * Генерация .bat-файла запуска сервера и набора аргументов командной строки.
 *
 * Один и тот же список аргументов используется и для .bat, и для прямого
 * запуска DayZServer_x64.exe из панели — так поведение кнопки «Старт» и
 * ручного запуска .bat всегда совпадает.
 *
 * Текст внутри .bat намеренно на латинице. Файл пересоздаётся при каждом
 * запуске, его читают и cmd.exe, и текстовые редакторы, а у них разные
 * представления о кодировке: консоль ждёт CP866, редакторы — UTF-8 или
 * CP1251. ASCII одинаково правильно выглядит везде, поэтому русский текст
 * живёт в панели, а не в машинном файле.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');
const cp866 = require('../util/cp866');
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
  // Кавычим всё, что cmd.exe может истолковать по-своему: пробелы, разделители
  // команд, конвейеры, перенаправления, скобки. Имя мода вида
  // «The First Line | GUNS» без кавычек превратилось бы в конвейер.
  return /[\s;&^|<>()!,]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Текст для echo: cmd разбирает служебные символы даже внутри echo,
 * поэтому экранируем их «крышкой», а проценты удваиваем.
 */
function safeEcho(text) {
  return String(text)
    .replace(/%/g, '%%')
    .replace(/[&|<>^()]/g, (ch) => `^${ch}`);
}

/**
 * Текст для rem: перенаправления и конвейеры разбираются до того, как cmd
 * поймёт, что это комментарий, поэтому опасные символы просто убираем.
 */
function safeComment(text) {
  return String(text).replace(/[&|<>^()%]/g, '-');
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
    // Никакого chcp: смена кодовой страницы посреди .bat сбивает разбор
    // файла в cmd.exe, и скрипт молча обрывается.
    `title DayZ Server - ${safeEcho(cfg.server.name)}`,
    'rem ==========================================================',
    'rem  Generated automatically by DayZ Panel.',
    `rem  Created: ${stamp}`,
    'rem  Manual edits are overwritten on the next start from the panel.',
    'rem  Change settings in the panel instead.',
    'rem ==========================================================',
    '',
    `set "SERVER_DIR=${cfg.paths.serverPath}"`,
    `set "SERVER_EXE=${cfg.paths.serverExe}"`,
    `set "GAME_PORT=${cfg.server.gamePort}"`,
    `set "QUERY_PORT=${cfg.server.steamQueryPort}"`,
    '',
    'cd /d "%SERVER_DIR%"',
    'if errorlevel 1 (',
    '    echo [ERROR] Server folder not found: %SERVER_DIR%',
    '    pause',
    '    exit /b 1',
    ')',
    'if not exist "%SERVER_EXE%" (',
    '    echo [ERROR] %SERVER_EXE% not found in %SERVER_DIR%',
    '    pause',
    '    exit /b 1',
    ')',
    '',
    `echo Server:     ${safeEcho(cfg.server.name)}`,
    'echo Game port:  %GAME_PORT% (UDP)',
    'echo Query port: %QUERY_PORT%',
    `echo Mods enabled: ${clientMods.length + serverMods.length}`,
    ''
  ];

  if (clientMods.length) {
    lines.push('rem Client mods (-mod):');
    clientMods.forEach((m) => lines.push(`rem   ${safeComment(m)}`));
  }
  if (serverMods.length) {
    lines.push('rem Server mods (-serverMod):');
    serverMods.forEach((m) => lines.push(`rem   ${safeComment(m)}`));
  }
  if (clientMods.length || serverMods.length) lines.push('');

  lines.push(buildCommandLine(cfg));
  lines.push('');
  lines.push('rem Server exit code stays in %ERRORLEVEL%');
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

  // Имя папки мода может содержать символы, которых нет в CP866. Сам сервер
  // панель запускает напрямую с юникодными аргументами, а вот .bat такие
  // имена передать не сможет — честно предупреждаем.
  const { clientMods, serverMods } = mods.buildModParams(cfg);
  const unsupported = [...clientMods, ...serverMods].filter((folder) => !cp866.canEncode(folder));
  if (unsupported.length) {
    logger.warn(
      SOURCE,
      `Имена модов ${unsupported.join(', ')} не записываются в .bat без искажений. ` +
        'Запускайте сервер кнопкой в панели — там имена передаются без потерь.'
    );
  }

  const buffer = cp866.encode(content);

  let written = true;
  if (fs.existsSync(target) && fs.readFileSync(target).equals(buffer)) {
    written = false;
    logger.info(SOURCE, `.bat уже актуален: ${target}`);
  } else {
    fs.writeFileSync(target, buffer);
    logger.info(SOURCE, `Сгенерирован ${target}`);
  }

  return { path: target, content, written, unsupported };
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
