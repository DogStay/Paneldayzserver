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

/** Папка, куда SteamCMD складывает недокачанный контент. */
function downloadDir(id, v = config.active()) {
  const root = config.workshopRoot(v);
  return root ? path.join(root, 'downloads', String(v.steam.dayzAppId || '221100'), String(id)) : '';
}

/** Размер папки в байтах — нужен, чтобы показывать прогресс тяжёлых модов. */
function dirSize(dir) {
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
        } catch (_) {
          /* файл мог исчезнуть между чтением списка и stat */
        }
      }
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir);
  return bytes;
}

/** Свободное место на томе, где лежит workshop-контент. */
function freeSpace(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch (_) {
    return 0;
  }
}

const formatBytes = (bytes) => {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};


/* ------------------------------------------- спасение докачанного мода */

/**
 * Состояние незавершённой закачки из appworkshop_<appid>.acf.
 * @returns {{downloaded: number, total: number}|null}
 */
function readDownloadingState(id, v = config.active()) {
  const file = acfPath(v);
  if (!file || !fs.existsSync(file)) return null;

  try {
    const parsed = vdf.parse(fs.readFileSync(file, 'utf8'));
    const section = vdf.findSection(parsed, 'WorkshopItemsDownloading') || {};
    const entry = section[String(id)];
    if (!entry || typeof entry !== 'object') return null;

    return {
      downloaded: parseInt(entry.BytesDownloaded, 10) || 0,
      total: parseInt(entry.BytesToDownload, 10) || 0,
      manifest: String(entry.manifest || '')
    };
  } catch (_) {
    return null;
  }
}

/** Похоже ли содержимое папки на полноценный мод DayZ. */
function looksLikeMod(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const hasMeta = fs.existsSync(path.join(dir, 'meta.cpp'));
  const addons = ['addons', 'Addons'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!hasMeta || !addons) return false;
  try {
    return fs.readdirSync(addons).length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * SteamCMD на тяжёлых модах регулярно докачивает файл до конца, но падает на
 * финальном переносе из steamapps/workshop/downloads в .../content — папка
 * мода так и не появляется, хотя все гигабайты уже на диске.
 *
 * Здесь панель доводит дело до конца сама: проверяет, что закачка полная,
 * и переносит папку на место. Ровно то, что админы делают руками.
 *
 * @param {string} id
 * @param {{expectedBytes?: number, label?: string}} [opts]
 * @returns {{rescued: boolean, reason?: string, registered?: boolean}}
 */
function rescueDownloadedItem(id, opts = {}) {
  const v = config.active();
  const from = downloadDir(id, v);
  const to = itemPath(id, v);
  const label = opts.label || `мод ${id}`;

  if (!from || !fs.existsSync(from)) return { rescued: false, reason: 'нет папки downloads' };
  if (!looksLikeMod(from)) return { rescued: false, reason: 'в downloads нет meta.cpp и addons — закачка неполная' };

  // Полнота проверяется по состоянию SteamCMD, а если его нет — по ожидаемому
  // размеру мода из Workshop. Без подтверждения переносить нельзя: рискуем
  // «установить» половину мода.
  const state = readDownloadingState(id, v);
  const onDisk = dirSize(from);
  let complete = null;

  if (state && state.total > 0) complete = state.downloaded >= state.total;
  else if (opts.expectedBytes > 0) complete = onDisk >= opts.expectedBytes * 0.99;

  if (complete !== true) {
    if (complete === false) {
      // Сколько всего ждём: точнее знает SteamCMD, иначе берём размер из Workshop.
      const total = state && state.total > 0 ? state.total : opts.expectedBytes || 0;
      const share = total ? Math.round((onDisk / total) * 100) : 0;
      return {
        rescued: false,
        reason: total
          ? `скачано ${formatBytes(onDisk)} из ${formatBytes(total)} (${share}%) — закачка не завершена` +
            (share >= 90 ? ', запустите загрузку ещё раз, чтобы докачать остаток' : '')
          : `на диске ${formatBytes(onDisk)}, закачка не завершена`
      };
    }
    return { rescued: false, reason: 'не удалось подтвердить, что закачка полная' };
  }

  logger.warn(
    SOURCE,
    `${label}: SteamCMD скачал ${formatBytes(onDisk)}, но не перенёс мод на место. Переношу сам.`
  );

  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });

    try {
      fs.renameSync(from, to); // один том — мгновенно
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  } catch (err) {
    return { rescued: false, reason: `не удалось перенести папку: ${err.message}` };
  }

  if (!itemExists(id, v)) return { rescued: false, reason: 'после переноса папка мода всё равно пуста' };

  logger.info(SOURCE, `${label}: мод установлен из докачанного архива (${formatBytes(onDisk)})`);
  const registered = registerInstalled(id, v, onDisk);

  return { rescued: true, registered };
}

/**
 * Отметить мод установленным в appworkshop_<appid>.acf.
 *
 * Без этой записи SteamCMD считает мод неустановленным и при следующей
 * проверке снова качает все гигабайты. Значения берём только реальные — из
 * секции WorkshopItemDetails, которую SteamCMD заполнил сам; выдумывать
 * manifest нельзя. Правка точечная, оригинал сохраняется рядом.
 */
function registerInstalled(id, v, sizeBytes) {
  const file = acfPath(v);
  if (!file || !fs.existsSync(file)) return false;

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = vdf.parse(raw);

    const installed = vdf.findSection(parsed, 'WorkshopItemsInstalled') || {};
    if (installed[String(id)]) return true; // уже отмечен

    const details = vdf.findSection(parsed, 'WorkshopItemDetails') || {};
    const entry = details[String(id)];
    if (!entry || !entry.manifest) {
      logger.warn(
        SOURCE,
        'В файле состояния SteamCMD нет данных о версии мода — отметить его установленным не получилось. ' +
          'Панель не будет проверять для него обновления автоматически.'
      );
      return false;
    }

    const block =
      `		"${id}"
		{
` +
      `			"manifest"		"${entry.manifest}"
` +
      `			"timeupdated"		"${entry.timeupdated || Math.floor(Date.now() / 1000)}"
` +
      `			"size"		"${sizeBytes}"
		}
`;

    const marker = raw.match(/"WorkshopItemsInstalled"\s*\r?\n\s*\{\r?\n/);
    if (!marker) return false;

    fs.copyFileSync(file, `${file}.backup`);
    const patched = raw.slice(0, marker.index + marker[0].length) + block + raw.slice(marker.index + marker[0].length);
    fs.writeFileSync(file, patched, 'utf8');

    logger.info(SOURCE, `Мод ${id} отмечен установленным в файле состояния SteamCMD`);
    return true;
  } catch (err) {
    logger.warn(SOURCE, `Не удалось отметить мод установленным: ${err.message}`);
    return false;
  }
}

/**
 * Скачать один мод, при необходимости — за несколько попыток.
 *
 * Моды на 8–10 ГБ регулярно обрываются по таймауту SteamCMD
 * («Timeout downloading item»). Это не фатально: SteamCMD складывает
 * недокачанное в steamapps/workshop/downloads и при следующем запуске
 * продолжает с того же места. Поэтому вместо одной попытки делаем несколько
 * и показываем, что объём на диске растёт.
 *
 * @param {string} id
 * @param {{validate?: boolean, expectedBytes?: number, onProgress?: Function, label?: string}} [opts]
 */
async function downloadItem(id, opts = {}) {
  const cfg = config.load();
  const v = config.active();
  const appId = String(v.steam.dayzAppId || '221100');
  const maxAttempts = Math.max(1, parseInt(cfg.steam.downloadRetries, 10) || 5);
  const timeoutMs = (parseInt(cfg.steam.downloadTimeoutMinutes, 10) || 180) * 60 * 1000;
  const label = opts.label || `мод ${id}`;

  // SteamCMD держит мод дважды: сначала в downloads, потом в content.
  // На 8-гигабайтном моде это 16+ ГБ, и нехватка места выглядит как
  // «скачалось, но не установилось» — предупреждаем заранее.
  if (opts.expectedBytes > 0) {
    const free = freeSpace(config.workshopRoot(v));
    if (free > 0 && free < opts.expectedBytes * 2.2) {
      logger.warn(
        SOURCE,
        `${label}: на диске свободно ${formatBytes(free)}, а моду нужно около ` +
          `${formatBytes(opts.expectedBytes * 2.2)} (SteamCMD хранит копию в downloads и в content). ` +
          'Установка может не завершиться — освободите место.'
      );
    }
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const partial = dirSize(downloadDir(id, v));
      logger.warn(
        SOURCE,
        `${label}: попытка ${attempt} из ${maxAttempts}. ` +
          (partial
            ? `На диске уже ${formatBytes(partial)} — SteamCMD продолжит с этого места.`
            : 'Загрузка начнётся заново.')
      );
      await delay(3000);
    }

    const args = [];
    const installDir = steamInstallDir(v);
    if (installDir) args.push('+force_install_dir', installDir);
    args.push(...loginArgs(cfg));
    args.push('+workshop_download_item', appId, String(id));
    if (opts.validate) args.push('validate');
    args.push('+quit');

    // Пока SteamCMD молчит, следим за размером папки — для больших модов это
    // единственный честный признак того, что процесс жив и что-то качает.
    const watcher = watchSize(id, v, opts.expectedBytes, opts.onProgress, label);

    let output = '';
    let code = 0;
    try {
      ({ output, code } = await run(args, { timeoutMs, onProgress: opts.onProgress }));
    } finally {
      watcher.stop();
    }

    if (itemExists(id, v)) {
      if (attempt > 1) logger.info(SOURCE, `${label}: докачан с ${attempt}-й попытки`);
      return { ok: true, output, attempts: attempt };
    }

    // Тяжёлые моды SteamCMD часто скачивает целиком, но не переносит на место.
    // Если в downloads лежит полная копия — доводим установку сами.
    const rescue = rescueDownloadedItem(id, { expectedBytes: opts.expectedBytes, label });
    if (rescue.rescued) {
      return { ok: true, output, attempts: attempt, rescued: true, registered: rescue.registered };
    }

    lastError =
      detectItemError(output, id) ||
      detectError(output) ||
      `SteamCMD завершился с кодом ${code}, папка мода не появилась`;
    if (rescue.reason) logger.info(SOURCE, `${label}: перенос из downloads не выполнен — ${rescue.reason}`);

    if (!isRetryable(lastError)) {
      logger.error(SOURCE, `${label}: ${lastError} — повтор не поможет`);
      return { ok: false, error: lastError, output, attempts: attempt };
    }

    logger.warn(SOURCE, `${label}: ${lastError}`);
  }

  return {
    ok: false,
    attempts: maxAttempts,
    error:
      `${lastError}. Попыток сделано: ${maxAttempts}. ` +
      'Прогресс не теряется — запустите загрузку ещё раз, SteamCMD продолжит с места обрыва. ' +
      'Если мод очень большой, увеличьте steam.downloadRetries в config/config.json.'
  };
}

/**
 * Стоит ли повторять попытку.
 *
 * Порядок важен: «Failure: No subscription» содержит слово Failure, но
 * повторять его бессмысленно — сначала отсекаем безнадёжные случаи.
 */
function isRetryable(message) {
  const text = String(message);

  const hopeless = [
    /No subscription/i,          // аккаунт не владеет игрой
    /Invalid Password|Login Failure/i,
    /Rate Limit/i,               // Steam временно заблокировал вход
    /Two-factor|Steam Guard/i,
    /File ?Not ?Found|Item is deleted|Missing/i, // мод удалён автором
    /Access ?Denied|Permission/i,
    /No space|Disk (write )?full/i
  ];
  if (hopeless.some((re) => re.test(text))) return false;

  return /Timeout|Timed out|Connection|Disconnect|I\/O|Suspended|Failure|не создал папку/i.test(text);
}

/** Периодически докладываем, сколько уже скачано. */
function watchSize(id, v, expectedBytes, onProgress, label) {
  let lastReported = 0;

  const timer = setInterval(() => {
    const bytes = dirSize(downloadDir(id, v)) || dirSize(itemPath(id, v));
    if (!bytes || bytes === lastReported) return;
    lastReported = bytes;

    const percent = expectedBytes ? Math.min(99, (bytes / expectedBytes) * 100) : null;
    const human = expectedBytes
      ? `${formatBytes(bytes)} из ${formatBytes(expectedBytes)}`
      : formatBytes(bytes);

    logger.info(SOURCE, `${label}: скачано ${human}`);
    if (onProgress) onProgress({ percent, phase: `Загрузка ${human}` });
  }, 15_000);

  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer) };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Скачать/обновить набор модов и определить, что изменилось.
 *
 * Моды качаются по одному: так обрыв на тяжёлом моде не отменяет остальные,
 * а прогресс виден по каждому в отдельности.
 *
 * @param {Array<string|{id: string, sizeBytes?: number, name?: string}>} items
 * @param {{validate?: boolean, onProgress?: Function, onItemDone?: Function}} [opts]
 */
async function downloadItems(items, opts = {}) {
  const v = config.active();
  const list = [];
  const seen = new Set();

  for (const raw of items) {
    const item = typeof raw === 'object' ? raw : { id: raw };
    const id = String(item.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, sizeBytes: item.sizeBytes || 0, name: item.name || id });
  }

  if (!list.length) return { results: [], code: 0 };

  const before = readInstalledState(v);
  const existedBefore = Object.fromEntries(list.map((i) => [i.id, itemExists(i.id, v)]));
  const results = [];

  for (let index = 0; index < list.length; index++) {
    const item = list[index];
    const label = `${item.name} (${item.id})`;
    logger.info(SOURCE, `[${index + 1}/${list.length}] ${label}: загрузка`);

    const share = 100 / list.length;
    const base = index * share;

    const outcome = await downloadItem(item.id, {
      validate: opts.validate,
      expectedBytes: item.sizeBytes,
      label,
      onProgress: (p) => {
        if (!opts.onProgress) return;
        const inner = p.percent === null || p.percent === undefined ? 50 : p.percent;
        opts.onProgress({
          percent: base + (inner / 100) * share,
          phase: `[${index + 1}/${list.length}] ${item.name}: ${p.phase}`
        });
      }
    });

    const after = readInstalledState(config.active());
    const prev = before[item.id] || { manifest: '', timeupdated: 0 };
    const next = after[item.id] || { manifest: '', timeupdated: 0 };

    if (!outcome.ok) {
      results.push({ id: item.id, status: 'failed', manifest: next.manifest, timeupdated: next.timeupdated, error: outcome.error });
    } else if (outcome.rescued) {
      results.push({
        id: item.id,
        status: 'installed',
        manifest: next.manifest,
        timeupdated: next.timeupdated,
        rescued: true,
        registered: Boolean(outcome.registered)
      });
    } else {
      const changed =
        (next.manifest && next.manifest !== prev.manifest) ||
        (next.timeupdated && next.timeupdated !== prev.timeupdated);

      let status = 'up-to-date';
      if (!existedBefore[item.id]) status = 'installed';
      else if (changed) status = 'updated';

      results.push({ id: item.id, status, manifest: next.manifest, timeupdated: next.timeupdated });
    }

    if (opts.onItemDone) opts.onItemDone(item.id, index + 1, list.length);
    if (opts.onProgress) {
      opts.onProgress({ percent: (index + 1) * share, phase: `Готово ${index + 1} из ${list.length}` });
    }
  }

  return { results, code: results.some((r) => r.status === 'failed') ? 1 : 0 };
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
  downloadItem,
  downloadItems,
  downloadDir,
  rescueDownloadedItem,
  readInstalledState,
  itemPath,
  itemExists,
  steamInstallDir,
  acfPath,
  parseProgress,
  detectError,
  health
};
