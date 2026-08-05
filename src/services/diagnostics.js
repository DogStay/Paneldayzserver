'use strict';

/**
 * Диагностика.
 *
 * Здесь собирается всё, что нужно человеку (или тому, кому вы отправите файл),
 * чтобы понять, почему сервер не запускается:
 *
 *   - отчёт по кнопке — файл diagnostic-report-*.txt в корне папки панели;
 *   - отчёт при падении — logs/crash-*.txt, создаётся автоматически, если
 *     сервер завершился сам или запуск сорвался.
 *
 * В отчёт попадают: настройки (без паролей), состояние путей, список модов,
 * аргументы запуска, содержимое serverDZ.cfg, сгенерированный .bat, хвост
 * лога панели и хвост *.RPT/*.ADM самого сервера.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const logger = require('../logger');
const steamcmd = require('./steamcmd');
const batgen = require('./batgen');
const mods = require('./mods');
const logTail = require('./logTail');

const SOURCE = 'panel';
const ROOT = path.join(__dirname, '..', '..');

/* --------------------------------------------------------------- утилиты */

const line = (char = '─', len = 72) => char.repeat(len);

function section(title) {
  return `\n${line('═')}\n  ${title}\n${line('═')}\n`;
}

function exists(target) {
  if (!target) return 'путь не задан';
  try {
    const stat = fs.statSync(target);
    const size = stat.isDirectory() ? '' : ` (${formatBytes(stat.size)})`;
    return `ЕСТЬ${size}`;
  } catch (_) {
    return 'НЕ НАЙДЕН';
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function tailFile(file, lines = 200, { redact = false } = {}) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const all = text.split(/\r?\n/);
    const tail = all.slice(-lines).join('\n');
    return redact ? redactSecrets(tail) : tail;
  } catch (err) {
    return `<не удалось прочитать: ${err.message}>`;
  }
}

/**
 * Затираем пароли перед тем, как класть текст в отчёт: отчёт создаётся
 * ради пересылки другому человеку, паролям там не место.
 */
function redactSecrets(text) {
  return text.replace(
    /^(\s*(?:password|passwordAdmin|adminPassword|rconPassword|BEPassword)\s*=\s*)("?)([^";\r\n]*)("?\s*;?.*)$/gim,
    (_m, head, q1, value, tail) => `${head}${q1}${value ? '***скрыто панелью***' : ''}${tail}`
  );
}

function diskInfo(target) {
  try {
    const stat = fs.statfsSync(target);
    const free = stat.bavail * stat.bsize;
    const total = stat.blocks * stat.bsize;
    return `свободно ${formatBytes(free)} из ${formatBytes(total)}`;
  } catch (_) {
    return 'нет данных';
  }
}

function listDir(target, limit = 60) {
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const rendered = entries
      .slice(0, limit)
      .map((e) => `  ${e.isDirectory() ? '[папка]' : '       '} ${e.name}`)
      .join('\n');
    const rest = entries.length > limit ? `\n  … ещё ${entries.length - limit} элем.` : '';
    return rendered + rest;
  } catch (err) {
    return `  <не удалось прочитать: ${err.message}>`;
  }
}

/* ---------------------------------------------------------- разделы отчёта */

function envSection() {
  const pkg = require('../../package.json');
  return [
    section('ОКРУЖЕНИЕ'),
    `Дата отчёта:     ${new Date().toLocaleString('ru-RU')}`,
    `Версия панели:   ${pkg.version}`,
    `ОС:              ${os.type()} ${os.release()} (${process.platform}, ${process.arch})`,
    `Node.js:         ${process.version}`,
    `Память:          свободно ${formatBytes(os.freemem())} из ${formatBytes(os.totalmem())}`,
    `Ядер CPU:        ${os.cpus().length}`,
    `Папка панели:    ${ROOT}`,
    `Диск панели:     ${diskInfo(ROOT)}`,
    `Аптайм системы:  ${Math.round(os.uptime() / 60)} мин`
  ].join('\n');
}

function steamSection() {
  const cfg = config.load();
  const health = steamcmd.health();
  return [
    section('STEAMCMD'),
    `Путь:                 ${health.exe || '(не задан)'} — ${exists(health.exe)}`,
    `Workshop content:     ${health.workshopContentDir || '(не задан)'} — ${exists(health.workshopContentDir)}`,
    `Файл версий (.acf):   ${health.acf || '(нет)'} — ${exists(health.acf)}`,
    `Логин Steam:          ${cfg.steam.username ? cfg.steam.username : '(не задан)'}`,
    `Пароль сохранён:      ${cfg.steam.password ? 'да' : 'нет'}`,
    `Анонимный вход:       ${health.anonymous ? 'да' : 'нет'}`,
    `Ключ Web API:         ${cfg.steam.webApiKey ? 'задан' : 'нет'}`,
    `SteamCMD сейчас занят:${health.busy ? ' да' : ' нет'}`
  ].join('\n');
}

function serverSection(server, status) {
  const v = config.active(server.id);
  const out = [];

  out.push(section(`СЕРВЕР: ${server.name}  (id ${server.id})`));
  out.push(`Установлен:      ${server.installed ? 'да' : 'НЕТ — файлы сервера не скачаны'}`);
  out.push(`Создан:          ${server.createdAt || '—'}`);
  out.push('');
  out.push('Пути:');
  out.push(`  Папка сервера:  ${v.paths.serverPath} — ${exists(v.paths.serverPath)}`);
  out.push(`  Исполняемый:    ${config.serverExePath(v)} — ${exists(config.serverExePath(v))}`);
  out.push(`  Профили:        ${config.profilesPath(v)} — ${exists(config.profilesPath(v))}`);
  out.push(`  serverDZ.cfg:   ${config.serverCfgPath(v)} — ${exists(config.serverCfgPath(v))}`);
  out.push(`  .bat запуска:   ${config.batPath(v)} — ${exists(config.batPath(v))}`);
  out.push(`  Диск сервера:   ${diskInfo(v.paths.serverPath || ROOT)}`);
  out.push('');
  out.push('Настройки:');
  out.push(`  Название:       ${v.server.name}`);
  out.push(`  Слотов:         ${v.server.maxPlayers}`);
  out.push(`  Игровой порт:   ${v.server.gamePort} (UDP)`);
  out.push(`  Query порт:     ${v.server.steamQueryPort}`);
  out.push(`  Карта:          ${v.server.mission}`);
  out.push(`  Пароль входа:   ${v.server.password ? 'задан' : 'нет'}`);
  out.push(`  Пароль админа:  ${v.server.adminPassword ? 'задан' : 'нет'}`);
  out.push(`  Доп. порты:     ${v.server.extraPorts.map((p) => `${p.protocol} ${p.from}-${p.to}`).join(', ') || '—'}`);
  out.push(`  Флаги:          ${JSON.stringify(v.features)}`);

  if (status) {
    out.push('');
    out.push('Состояние процесса:');
    out.push(`  Статус:         ${status.status}`);
    out.push(`  PID:            ${status.pid || '—'}`);
    out.push(`  Аптайм:         ${status.uptimeSec ? `${status.uptimeSec} с` : '—'}`);
    out.push(`  Код выхода:     ${status.exitCode === null || status.exitCode === undefined ? '—' : status.exitCode}`);
    out.push(`  Последняя ошибка: ${status.lastError || '—'}`);
  }

  out.push('');
  out.push(`Моды (${v.mods.length}):`);
  if (!v.mods.length) {
    out.push('  (список пуст)');
  } else {
    let list = { mods: [] };
    try {
      list = mods.list();
    } catch (_) {
      /* сканирование могло не пройти */
    }
    for (const mod of v.mods) {
      const info = list.mods.find((m) => m.id === mod.id) || {};
      out.push(
        `  ${mod.enabled ? '[x]' : '[ ]'} ${mod.id.padEnd(12)} ${String(mod.folder || '').padEnd(32)} ` +
          `${mod.type === 'server' ? 'serverMod' : 'mod      '} ` +
          `скачан:${info.downloaded ? 'да' : 'НЕТ'} разложен:${info.deployed ? 'да' : 'НЕТ'} ` +
          `версия:${mod.timeupdated || '—'}`
      );
    }
  }

  out.push('');
  out.push('Аргументы запуска:');
  try {
    out.push(`  ${batgen.buildCommandLine(v)}`);
  } catch (err) {
    out.push(`  <не удалось собрать: ${err.message}>`);
  }

  out.push('');
  out.push('Содержимое папки сервера:');
  out.push(listDir(v.paths.serverPath));

  out.push('');
  out.push(`serverDZ.cfg (${config.serverCfgPath(v)}):`);
  out.push(line());
  out.push(
    fs.existsSync(config.serverCfgPath(v))
      ? tailFile(config.serverCfgPath(v), 200, { redact: true })
      : '<файл отсутствует>'
  );
  out.push(line());

  const batFile = config.batPath(v);
  out.push('');
  out.push(`Сгенерированный .bat (${batFile}):`);
  out.push(line());
  out.push(fs.existsSync(batFile) ? tailFile(batFile, 80, { redact: true }) : '<файл отсутствует>');
  out.push(line());

  out.push('');
  out.push('Логи сервера (последние строки):');
  const profiles = config.profilesPath(v);
  const files = logTail.findLogFiles(profiles, 0).slice(-4);
  if (!files.length) {
    out.push(`  <в ${profiles} нет файлов *.RPT / *.ADM / script.log>`);
  } else {
    for (const file of files) {
      out.push('');
      out.push(`  ── ${file} ──`);
      out.push(tailFile(file, 120, { redact: true }));
    }
  }

  return out.join('\n');
}

function panelLogSection(lines = 400) {
  const out = [section('ЛОГ ПАНЕЛИ (последние строки)')];
  const entries = logger.tail(lines);
  for (const entry of entries) {
    out.push(`${entry.ts} [${entry.level.toUpperCase().padEnd(5)}] [${entry.source}] ${entry.message}`);
  }
  if (!entries.length) out.push('(лог пуст)');
  return out.join('\n');
}

/* ------------------------------------------------------------ полный отчёт */

/**
 * Собрать текст диагностического отчёта.
 * @param {{statuses?: Object}} [opts] статусы серверов (передаёт вызывающий код)
 */
function buildReport(opts = {}) {
  const cfg = config.load();
  const statuses = opts.statuses || {};

  const parts = [
    line('═'),
    '  ДИАГНОСТИЧЕСКИЙ ОТЧЁТ DAYZ PANEL',
    '  Этот файл можно целиком отправить тому, кто помогает с настройкой:',
    '  пароли Steam и пароли сервера в него НЕ попадают.',
    line('═'),
    envSection(),
    steamSection(),
    section('ПАНЕЛЬ'),
    `Адрес:          http://${cfg.panel.host}:${cfg.panel.port}`,
    `Серверов:       ${cfg.servers.length}`,
    `Активный:       ${cfg.activeServerId || '—'}`,
    `Конфиг:         ${config.CONFIG_FILE}`
  ];

  if (!cfg.servers.length) {
    parts.push(section('СЕРВЕРЫ'), 'Серверы ещё не созданы.');
  } else {
    for (const server of cfg.servers) {
      try {
        parts.push(serverSection(server, statuses[server.id]));
      } catch (err) {
        parts.push(section(`СЕРВЕР: ${server.name}`), `<не удалось собрать раздел: ${err.stack || err.message}>`);
      }
    }
  }

  parts.push(panelLogSection());
  parts.push('');
  parts.push(line('═'));
  parts.push('  КОНЕЦ ОТЧЁТА');
  parts.push(line('═'));
  parts.push('');

  return parts.join('\n');
}

/**
 * Сохранить отчёт в корень папки панели.
 * @returns {{path: string, name: string, size: number}}
 */
function writeReport(opts = {}) {
  const content = buildReport(opts);
  const name = `diagnostic-report-${timestamp()}.txt`;
  const target = path.join(ROOT, name);

  fs.writeFileSync(target, content, 'utf8');
  logger.info(SOURCE, `Диагностический отчёт сохранён: ${target}`);

  return { path: target, name, size: Buffer.byteLength(content, 'utf8') };
}

/* ------------------------------------------------------- отчёт о падении */

/**
 * Отчёт при неожиданном завершении сервера или сорванном запуске.
 * @param {{serverId: string, reason: string, status?: object, recent?: string[]}} info
 * @returns {string|null} путь к файлу
 */
function writeCrashReport(info) {
  try {
    const server = config.getServer(info.serverId);
    const name = server ? server.name : info.serverId;

    const parts = [
      line('═'),
      '  ОТЧЁТ О СБОЕ СЕРВЕРА DAYZ',
      line('═'),
      `Сервер:  ${name} (${info.serverId})`,
      `Время:   ${new Date().toLocaleString('ru-RU')}`,
      `Причина: ${info.reason}`,
      '',
      'Что делать: приложите этот файл к вопросу о проблеме — в нём есть',
      'настройки, пути, список модов и последние строки логов.',
      ''
    ];

    if (server) {
      try {
        parts.push(serverSection(server, info.status));
      } catch (err) {
        parts.push(`<не удалось собрать раздел сервера: ${err.message}>`);
      }
    }

    if (info.recent && info.recent.length) {
      parts.push(section('ПОСЛЕДНИЙ ВЫВОД ПРОЦЕССА СЕРВЕРА'));
      parts.push(info.recent.join('\n'));
    }

    parts.push(panelLogSection(250));
    parts.push('');

    fs.mkdirSync(logger.LOG_DIR, { recursive: true });
    const file = path.join(logger.LOG_DIR, `crash-${safeName(name)}-${timestamp()}.txt`);
    fs.writeFileSync(file, parts.join('\n'), 'utf8');
    return file;
  } catch (err) {
    logger.error(SOURCE, `Не удалось сохранить отчёт о сбое: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ список */

/** Все сохранённые отчёты — их видно в интерфейсе на вкладке «Диагностика». */
function listReports() {
  const out = [];

  const collect = (dir, kind) => {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (kind === 'report' && !/^diagnostic-report-.*\.txt$/.test(file)) continue;
        if (kind === 'crash' && !/^crash-.*\.txt$/.test(file)) continue;
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        out.push({ name: file, path: full, kind, size: stat.size, mtime: stat.mtime.toISOString() });
      }
    } catch (_) {
      /* папки может не быть */
    }
  };

  collect(ROOT, 'report');
  collect(logger.LOG_DIR, 'crash');

  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** Прочитать отчёт по имени файла (без выхода за пределы папок панели). */
function readReport(name) {
  const entry = listReports().find((r) => r.name === name);
  if (!entry) throw new Error(`Отчёт «${name}» не найден`);
  return { ...entry, content: fs.readFileSync(entry.path, 'utf8') };
}

function removeReport(name) {
  const entry = listReports().find((r) => r.name === name);
  if (!entry) throw new Error(`Отчёт «${name}» не найден`);
  fs.unlinkSync(entry.path);
  logger.info(SOURCE, `Отчёт удалён: ${entry.name}`);
  return entry;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

const safeName = (value) => String(value).replace(/[^\wА-Яа-яЁё-]+/g, '_').slice(0, 40);

module.exports = { buildReport, writeReport, writeCrashReport, listReports, readReport, removeReport, ROOT };
