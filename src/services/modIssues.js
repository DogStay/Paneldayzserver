'use strict';

/**
 * Разбор ошибок сервера DayZ, связанных с модами.
 *
 * Движок DayZ сообщает о проблемах на своём языке: «Unknown type 'RPCManager'»
 * или «Addon 'X' requires addon 'Y'». Для админа это загадка, хотя причина
 * почти всегда одна из двух: не подключён мод-фреймворк либо он стоит в
 * -mod= позже того, кто от него зависит.
 *
 * Модуль превращает такие строки в понятный вывод: какого мода не хватает,
 * где его взять и что сделать.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = 'mods';

/**
 * Известные фреймворки: имя аддона в логе -> что это за мод.
 * Список намеренно короткий — только то, на чём спотыкаются чаще всего.
 */
const FRAMEWORKS = [
  {
    addons: ['JM_CF_Scripts', 'JM_CF_Modules', 'CF_Scripts'],
    types: ['RPCManager', 'CF_ModStorage', 'JMModuleBase', 'CF_Log'],
    name: 'Community Framework',
    folder: '@CF',
    workshopId: '1559212036'
  },
  {
    addons: ['DabsFramework', 'Dabs_Framework', 'DabsFramework_Scripts'],
    types: ['DayZPlayerImplement_Dabs', 'DF_ModuleService', 'ScriptCaller'],
    name: 'Dabs Framework',
    folder: '@Dabs Framework',
    workshopId: '2545327648'
  },
  {
    addons: ['JM_COT_Scripts'],
    types: ['JMPlayerInstance', 'JMModuleBase'],
    name: 'Community Online Tools',
    folder: '@COT',
    workshopId: '1564026768'
  }
];

/* --------------------------------------------------------------- разбор строк */

/**
 * Разобрать одну строку лога сервера.
 * @param {string} line
 * @returns {{kind: string, addon?: string, required?: string, type?: string, raw: string}|null}
 */
function analyzeLine(line) {
  const text = String(line || '');

  // Addon 'PlayerMuteMemu_CLIENT' requires addon 'JM_CF_Scripts'
  const requires = text.match(/Addon '([^']+)' requires addon '([^']+)'/i);
  if (requires) {
    return { kind: 'requires', addon: requires[1], required: requires[2], raw: text.trim() };
  }

  // SCRIPT (E): @"VPPAdminTools/3_Game/...": Unknown type 'RPCManager'
  const unknownType = text.match(/Unknown type '([^']+)'/i);
  if (unknownType) {
    const where = text.match(/@"([^/"\\]+)[/\\]/);
    return { kind: 'unknown-type', type: unknownType[1], addon: where ? where[1] : '', raw: text.trim() };
  }

  // Can't compile "Game" script module!
  if (/Can't compile "([^"]+)" script module/i.test(text)) {
    return { kind: 'compile-failed', module: (text.match(/Can't compile "([^"]+)"/i) || [])[1], raw: text.trim() };
  }

  if (/Failed to load game scripts/i.test(text)) {
    return { kind: 'scripts-failed', raw: text.trim() };
  }

  return null;
}

/** Фреймворк, которому принадлежит имя аддона или тип из ошибки. */
function frameworkFor({ required, type }) {
  return (
    FRAMEWORKS.find(
      (fw) =>
        (required && fw.addons.some((a) => a.toLowerCase() === String(required).toLowerCase())) ||
        (type && fw.types.some((t) => t.toLowerCase() === String(type).toLowerCase()))
    ) || null
  );
}

/* ------------------------------------------------ какой мод что даёт */

/**
 * Указатель «имя аддона -> мод, который его содержит».
 *
 * Движок ругается именами аддонов (FOG_Data_Patches), а админ видит папки
 * (@Forward Operator Gear). Связать одно с другим можно по именам .pbo:
 * у подавляющего большинства модов DayZ имя файла и есть имя аддона.
 *
 * @param {string} serverPath
 * @param {Array<{folder: string, name: string, enabled: boolean}>} mods
 * @returns {Map<string, {folder: string, name: string, order: number}>}
 */
function indexAddons(serverPath, mods = []) {
  const index = new Map();
  if (!serverPath || !fs.existsSync(serverPath)) return index;

  const enabled = mods.filter((m) => m.enabled && m.folder);
  enabled.forEach((mod, order) => {
    const dir = ['addons', 'Addons']
      .map((name) => path.join(serverPath, mod.folder, name))
      .find((p) => fs.existsSync(p));
    if (!dir) return;

    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (_) {
      return;
    }

    for (const file of files) {
      if (!/\.pbo$/i.test(file)) continue;
      const addon = file.replace(/\.pbo$/i, '').toLowerCase();
      if (!index.has(addon)) index.set(addon, { folder: mod.folder, name: mod.name || mod.folder, order });
    }
  });

  return index;
}

/**
 * Мод, который «почти» содержит нужный аддон — совпадает начало имени
 * (FOG_Data_Patches -> мод, где лежат другие FOG_*.pbo). Обычно это и есть
 * тот самый мод, только другой версии.
 */
function likelyProvider(required, index) {
  const prefix = String(required).split(/[_\-.]/)[0].toLowerCase();
  if (prefix.length < 3) return null;

  for (const [addon, owner] of index) {
    if (addon.startsWith(`${prefix}_`) || addon === prefix) return owner;
  }
  return null;
}

/* ------------------------------------------------------------------- выводы */

/**
 * Превратить накопленные строки в понятные выводы.
 *
 * @param {Array<object>} issues строки, отобранные analyzeLine
 * @param {Array<{folder: string, name: string, id: string, enabled: boolean}>} mods моды сервера
 * @param {{serverPath?: string}} [opts] путь к серверу — чтобы заглянуть в .pbo
 * @returns {Array<{severity: 'error'|'warn', title: string, detail: string, action?: object}>}
 */
function summarize(issues, mods = [], opts = {}) {
  const out = [];
  if (!issues.length) return out;

  const folders = new Set(mods.filter((m) => m.enabled).map((m) => String(m.folder || '').toLowerCase()));
  const ids = new Set(mods.map((m) => String(m.id)));
  const order = mods.filter((m) => m.enabled).map((m) => String(m.folder || '').toLowerCase());

  const hasFramework = (fw) =>
    ids.has(fw.workshopId) || folders.has(fw.folder.toLowerCase());

  // 1. Не хватает фреймворка целиком
  const missing = new Map();
  for (const issue of issues) {
    const fw = frameworkFor(issue);
    if (!fw || hasFramework(fw)) continue;
    if (!missing.has(fw.name)) missing.set(fw.name, { fw, dependents: new Set() });
    if (issue.addon) missing.get(fw.name).dependents.add(issue.addon);
  }

  for (const { fw, dependents } of missing.values()) {
    out.push({
      severity: 'error',
      title: `Не подключён мод «${fw.name}»`,
      detail:
        `Моды ${[...dependents].join(', ') || 'на сервере'} требуют его, поэтому скрипты не компилируются ` +
        `и сервер выключается сразу после старта.\n` +
        `Добавьте «${fw.name}» (Workshop ID ${fw.workshopId}) и поставьте его ПЕРВЫМ в списке модов — ` +
        'фреймворки должны идти раньше тех, кто от них зависит.',
      action: { type: 'add-mod', workshopId: fw.workshopId, name: fw.name }
    });
  }

  // 2. Фреймворк есть, но стоит после зависимого мода
  for (const issue of issues) {
    const fw = frameworkFor(issue);
    if (!fw || !hasFramework(fw)) continue;

    const fwIndex = order.indexOf(fw.folder.toLowerCase());
    const dependentIndex = issue.addon
      ? order.findIndex((folder) => folder.includes(String(issue.addon).toLowerCase().slice(0, 8)))
      : -1;

    if (fwIndex >= 0 && dependentIndex >= 0 && fwIndex > dependentIndex) {
      const already = out.some((o) => o.title.includes(fw.name));
      if (already) continue;
      out.push({
        severity: 'error',
        title: `«${fw.name}» стоит слишком низко в списке модов`,
        detail:
          `Мод ${issue.addon} зависит от него, но загружается раньше. Перетащите «${fw.name}» ` +
          'в самый верх списка модов и запустите сервер заново.',
        action: { type: 'move-first', folder: fw.folder }
      });
    }
  }

  // 3. «Addon 'A' requires addon 'B'» вне известных фреймворков.
  //    Здесь помогает не догадка, а факт: какие .pbo реально лежат в модах.
  const index = indexAddons(opts.serverPath, mods);
  const reported = new Set();

  for (const issue of issues) {
    if (issue.kind !== 'requires' || frameworkFor(issue)) continue;
    if (reported.has(issue.required.toLowerCase())) continue;
    reported.add(issue.required.toLowerCase());

    const provider = index.get(String(issue.required).toLowerCase());
    const dependent = index.get(String(issue.addon).toLowerCase());
    const who = dependent ? `Мод «${dependent.name}» (${dependent.folder})` : `Аддон ${issue.addon}`;

    // Зависимость есть, но грузится позже — классическая беда порядка модов.
    if (provider && dependent && provider.order > dependent.order) {
      out.push({
        severity: 'error',
        title: `«${provider.name}» стоит ниже, чем «${dependent.name}»`,
        detail:
          `${who} требует аддон ${issue.required}, который лежит в «${provider.name}» (${provider.folder}), ` +
          'но тот загружается позже.\n' +
          `Поднимите «${provider.name}» выше «${dependent.name}» в списке модов и запустите сервер заново.`,
        action: { type: 'move-before', folder: provider.folder, before: dependent.folder }
      });
      continue;
    }

    if (provider) continue; // зависимость на месте и в правильном порядке

    // Зависимости нет ни в одном включённом моде.
    const guess = likelyProvider(issue.required, index);
    out.push({
      severity: 'error',
      title: `Не хватает аддона ${issue.required}`,
      detail: guess
        ? `${who} требует ${issue.required}.pbo, но ни в одной папке включённых модов такого файла нет.\n` +
          `Похоже, его должен давать мод «${guess.name}» (${guess.folder}) — там лежат остальные ` +
          `${String(issue.required).split(/[_\-.]/)[0]}_*.pbo. Значит, у вас другая его версия, чем та, ` +
          'под которую собран зависимый мод: обновите или переустановите его кнопкой ' +
          '«Обновить принудительно», а если мод обновлялся автором — обновите и зависимый мод.'
        : `${who} требует ${issue.required}.pbo, но ни в одной папке включённых модов такого файла нет.\n` +
          'Нужный мод-зависимость не подключён к серверу. Откройте страницу зависимого мода в Workshop ' +
          '— в разделе Required Items указано, что ещё нужно подписать.'
    });
  }

  // 4. Неизвестный тип без привязки к известному фреймворку
  const unknownTypes = issues.filter((i) => i.kind === 'unknown-type' && !frameworkFor(i));
  for (const issue of unknownTypes.slice(0, 3)) {
    out.push({
      severity: 'error',
      title: `Мод ${issue.addon || ''} требует чего-то, чего нет на сервере`,
      detail:
        `Движок не нашёл тип «${issue.type}». Обычно это значит, что не подключён мод-зависимость ` +
        'или он стоит в списке ниже. Проверьте страницу мода в Workshop — там указаны требования.'
    });
  }

  // 5. Осталась только общая ошибка компиляции
  if (!out.length && issues.some((i) => i.kind === 'compile-failed' || i.kind === 'scripts-failed')) {
    out.push({
      severity: 'error',
      title: 'Скрипты модов не скомпилировались',
      detail:
        'Сервер не смог собрать скрипты и выключился. Точная строка ошибки есть в profiles\\script*.log — ' +
        'чаще всего виноват мод без своей зависимости или конфликт двух модов.'
    });
  }

  return out;
}

/**
 * Накопитель: собирает интересные строки во время работы сервера.
 * По одному экземпляру на запуск сервера.
 */
function createCollector({ limit = 60 } = {}) {
  const issues = [];
  const seen = new Set();

  return {
    /** @returns {boolean} была ли строка распознана как проблема */
    feed(line) {
      const issue = analyzeLine(line);
      if (!issue) return false;

      const key = `${issue.kind}:${issue.addon || ''}:${issue.required || ''}:${issue.type || ''}`;
      if (seen.has(key)) return true;
      seen.add(key);

      if (issues.length < limit) issues.push(issue);
      return true;
    },
    list: () => issues.slice(),
    clear: () => {
      issues.length = 0;
      seen.clear();
    },
    get size() {
      return issues.length;
    }
  };
}

module.exports = { analyzeLine, summarize, createCollector, indexAddons, FRAMEWORKS, SOURCE };
