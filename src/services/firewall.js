'use strict';

/**
 * Правила Windows Firewall через netsh advfirewall.
 *
 * Все порты берутся из конфига панели (server.gamePort, server.steamQueryPort,
 * server.extraPorts) — в коде нет ни одного жёстко зашитого номера.
 *
 * Каждое правило именуется префиксом «DayZ Panel - », поэтому набор правил
 * панели легко посмотреть и целиком удалить, не задев чужие.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');

const SOURCE = 'firewall';
const RULE_PREFIX = 'DayZ Panel - ';

const isWindows = () => process.platform === 'win32';

function execNetsh(args) {
  return new Promise((resolve) => {
    execFile('netsh', args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        output: `${stdout || ''}${stderr || ''}`.trim()
      });
    });
  });
}

/**
 * Список правил, которые нужны серверу при текущих настройках.
 * @returns {Array<{name: string, protocol: 'UDP'|'TCP', localport: string, comment: string}>}
 */
function desiredRules(cfg = config.active()) {
  const rules = [];
  const seen = new Set();

  const add = (protocol, from, to, comment) => {
    const localport = from === to ? String(from) : `${from}-${to}`;
    const key = `${protocol}:${localport}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({
      name: `${RULE_PREFIX}${protocol} ${localport}`,
      protocol,
      localport,
      comment
    });
  };

  add('UDP', cfg.server.gamePort, cfg.server.gamePort, 'Игровой порт DayZ');
  add('UDP', cfg.server.steamQueryPort, cfg.server.steamQueryPort, 'Steam query');

  for (const p of cfg.server.extraPorts) {
    add(p.protocol, p.from, p.to, p.comment || 'Дополнительный порт');
  }

  return rules;
}

/** Правило для самого исполняемого файла сервера (полезно при NAT/динамических портах). */
function programRule(cfg = config.active()) {
  return {
    name: `${RULE_PREFIX}DayZServer.exe`,
    program: config.serverExePath(cfg)
  };
}

async function ruleExists(name) {
  const res = await execNetsh(['advfirewall', 'firewall', 'show', 'rule', `name=${name}`]);
  return res.ok && !/No rules match|Не найдено ни одного правила/i.test(res.output);
}

/**
 * Создать недостающие правила (in + out) для текущих портов.
 * @param {{force?: boolean}} [opts] force — пересоздать даже существующие
 */
async function apply(opts = {}) {
  const cfg = config.active();
  const rules = desiredRules(cfg);
  const report = { created: [], skipped: [], failed: [], platform: process.platform };

  if (!isWindows()) {
    logger.warn(SOURCE, 'Открытие портов доступно только в Windows — шаг пропущен');
    report.skipped = rules.map((r) => ({ ...r, reason: 'not-windows' }));
    return report;
  }

  logger.info(SOURCE, `Проверка правил брандмауэра (${rules.length} шт.)…`);

  for (const rule of rules) {
    try {
      const exists = await ruleExists(rule.name);
      if (exists && !opts.force) {
        report.skipped.push({ ...rule, reason: 'exists' });
        continue;
      }
      if (exists && opts.force) {
        await execNetsh(['advfirewall', 'firewall', 'delete', 'rule', `name=${rule.name}`]);
      }

      let failure = null;
      for (const dir of ['in', 'out']) {
        const res = await execNetsh([
          'advfirewall',
          'firewall',
          'add',
          'rule',
          `name=${rule.name}`,
          `dir=${dir}`,
          'action=allow',
          `protocol=${rule.protocol}`,
          `localport=${rule.localport}`,
          'profile=any',
          `description=${rule.comment}`
        ]);
        if (!res.ok) failure = res.output || `netsh вернул код ${res.code}`;
      }

      if (failure) {
        report.failed.push({ ...rule, error: failure });
        logger.error(SOURCE, `✗ ${rule.name}: ${failure}`);
      } else {
        report.created.push(rule);
        logger.info(SOURCE, `✓ Открыт ${rule.protocol} ${rule.localport} (${rule.comment})`);
      }
    } catch (err) {
      report.failed.push({ ...rule, error: err.message });
      logger.error(SOURCE, `✗ ${rule.name}: ${err.message}`);
    }
  }

  // Правило по программе — только если .exe действительно на месте.
  const prog = programRule(cfg);
  if (fs.existsSync(prog.program)) {
    const exists = await ruleExists(prog.name);
    if (!exists) {
      for (const dir of ['in', 'out']) {
        await execNetsh([
          'advfirewall',
          'firewall',
          'add',
          'rule',
          `name=${prog.name}`,
          `dir=${dir}`,
          'action=allow',
          `program=${prog.program}`,
          'enable=yes',
          'profile=any'
        ]);
      }
      logger.info(SOURCE, `✓ Разрешено приложение ${prog.program}`);
      report.created.push(prog);
    } else {
      report.skipped.push({ ...prog, reason: 'exists' });
    }
  }

  if (report.failed.length) {
    logger.warn(
      SOURCE,
      'Часть правил не создана. Скорее всего панель запущена без прав администратора — ' +
        'запустите start-panel.bat от имени администратора или примените generated/open-firewall.bat вручную.'
    );
  }

  return report;
}

/** Текущее состояние правил панели — для отображения в интерфейсе. */
async function status() {
  const cfg = config.active();
  const rules = desiredRules(cfg);

  if (!isWindows()) {
    return {
      supported: false,
      platform: process.platform,
      rules: rules.map((r) => ({ ...r, exists: null }))
    };
  }

  const out = [];
  for (const rule of rules) {
    out.push({ ...rule, exists: await ruleExists(rule.name) });
  }
  return { supported: true, platform: process.platform, rules: out };
}

/** Удалить все правила, созданные панелью. */
async function removeAll() {
  if (!isWindows()) {
    logger.warn(SOURCE, 'Удаление правил доступно только в Windows');
    return { removed: 0, supported: false };
  }
  const cfg = config.active();
  const names = [...desiredRules(cfg).map((r) => r.name), programRule(cfg).name];
  let removed = 0;
  for (const name of names) {
    const res = await execNetsh(['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`]);
    if (res.ok) {
      removed++;
      logger.info(SOURCE, `Удалено правило: ${name}`);
    }
  }
  return { removed, supported: true };
}

/**
 * Сохранить netsh-команды в .bat — на случай, если панель запущена без прав
 * администратора и правила нужно применить вручную.
 */
function generateBat() {
  const cfg = config.active();
  const rules = desiredRules(cfg);
  const prog = programRule(cfg);

  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'rem Сгенерировано DayZ Panel. Запускать ОТ ИМЕНИ АДМИНИСТРАТОРА.',
    'net session >nul 2>&1 || (echo Требуются права администратора & pause & exit /b 1)',
    ''
  ];

  for (const rule of rules) {
    lines.push(`rem ${rule.comment}`);
    for (const dir of ['in', 'out']) {
      lines.push(
        `netsh advfirewall firewall add rule name="${rule.name}" dir=${dir} action=allow ` +
          `protocol=${rule.protocol} localport=${rule.localport} profile=any`
      );
    }
    lines.push('');
  }

  lines.push('rem Разрешение для самого исполняемого файла сервера');
  for (const dir of ['in', 'out']) {
    lines.push(
      `netsh advfirewall firewall add rule name="${prog.name}" dir=${dir} action=allow ` +
        `program="${prog.program}" enable=yes profile=any`
    );
  }
  lines.push('', 'echo Готово.', 'pause', '');

  const outDir = path.join(__dirname, '..', '..', 'generated');
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'open-firewall.bat');
  fs.writeFileSync(target, lines.join('\r\n'), 'utf8');
  logger.info(SOURCE, `Сохранён ${target}`);

  return { path: target, content: lines.join('\r\n') };
}

module.exports = { apply, status, removeAll, desiredRules, generateBat, RULE_PREFIX };
