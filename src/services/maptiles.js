'use strict';

/**
 * Подложка интерактивной карты: настоящие тайлы карт DayZ.
 *
 * Панель не раздаёт картинки сама и не хранит их в репозитории — это чужие
 * гигабайты. Вместо этого она работает как кэширующий посредник: браузер просит
 * тайл у панели, панель один раз скачивает его с публичного тайл-сервера
 * (по умолчанию static.xam.nu) и складывает в data/maptiles. Дальше тайл
 * отдаётся с диска, даже если интернета на машине нет.
 *
 * Почему через панель, а не напрямую из браузера:
 *   - тайл-сервер получает один запрос на тайл за всю жизнь панели, а не по
 *     запросу на каждое открытие карты каждым админом;
 *   - карта работает на машинах без интернета (сервер в закрытой сети);
 *   - не важно, блокирует ли тайл-сервер сторонние сайты по Referer.
 *
 * Система координат совпадает с обычной XYZ: на зуме z карта занимает 2^z
 * тайлов по каждой оси, тайл 256×256. Мировые координаты в метрах переводятся
 * так: tileX = x / (worldSize / 2^z), tileY = (worldSize - z) / (worldSize / 2^z)
 * — ось Y картинки идёт на юг, а мировая z на север.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const config = require('./../config');
const { imageSize } = require('../util/imagesize');
const logger = require('./../logger');

const SOURCE = 'map';

const CATALOGUE = require('../data/dayz-maps.json');

/** Дальше этого зума тайлов у источников нет. */
const MAX_ZOOM = 6;
const TILE_SIZE = 256;

/** Тайлов в очереди на скачивание одновременно. */
const MAX_PARALLEL = 4;
const REQUEST_TIMEOUT_MS = 15_000;

/** Ключи тайлов, которых у источника нет — чтобы не спрашивать их снова. */
const missing = new Set();

/**
 * Последний отказ источника: «карта/слой» -> {at, reason}.
 *
 * Пока отказ свежий, панель не дёргает источник на каждый тайл (иначе один
 * взгляд на карту — это десятки запросов в пустоту) и показывает причину
 * админу вместо пустого холста.
 */
const failures = new Map();
const FAILURE_COOLDOWN_MS = 60_000;

function noteFailure(key, reason) {
  failures.set(key, { at: Date.now(), reason });
}

function freshFailure(key) {
  const item = failures.get(key);
  if (!item) return null;
  if (Date.now() - item.at > FAILURE_COOLDOWN_MS) {
    failures.delete(key);
    return null;
  }
  return item;
}
let running = 0;
const queue = [];

/* ------------------------------------------------------------------ каталог */

/** Имя мира из миссии: «dayzOffline.chernarusplus» -> «chernarusplus». */
function worldOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const parts = raw.split('.');
  return parts[parts.length - 1];
}

/** Запись каталога по имени мира или миссии (учитывая псевдонимы). */
function resolve(value) {
  const world = worldOf(value);
  if (!world) return null;

  const direct = CATALOGUE.maps[world];
  if (direct) return { name: world, ...direct };

  for (const [name, entry] of Object.entries(CATALOGUE.maps)) {
    if ((entry.aliases || []).includes(world)) return { name, ...entry };
  }
  return null;
}

/** Размер карты в метрах по каталогу — подстраховка, если мод не на связи. */
function sizeOf(value) {
  const entry = resolve(value);
  return entry ? entry.size : 0;
}

function catalogue() {
  return Object.entries(CATALOGUE.maps)
    .map(([name, entry]) => ({
      name,
      size: entry.size,
      layers: Object.keys(entry.layers || {}),
      aliases: entry.aliases || []
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ----------------------------------------------------------------- настройки */

function settings() {
  const cfg = config.load();
  const map = (cfg.panel && cfg.panel.map) || {};
  const tiles = map.tiles || {};

  return {
    enabled: tiles.enabled !== false,
    layer: tiles.layer === 'satellite' ? 'satellite' : 'topographic',
    urlTemplate: String(tiles.urlTemplate || ''),
    attribution: String(tiles.attribution || CATALOGUE.attribution)
  };
}

/** Шаблон адреса тайлов: своя настройка важнее каталога. */
function templateFor(world, layer) {
  const s = settings();
  if (s.urlTemplate) return s.urlTemplate;

  const entry = resolve(world);
  if (!entry) return '';

  const layers = entry.layers || {};
  return layers[layer] || layers.topographic || layers.satellite || '';
}

/* --------------------------------------------------------------------- кэш */

/** Кэш лежит рядом с журналом событий — в data/, а не в public/. */
const CACHE_ROOT = path.join(__dirname, '..', '..', 'data', 'maptiles');

function cacheRoot() {
  return CACHE_ROOT;
}

function tilePath(world, layer, z, x, y) {
  return path.join(cacheRoot(), worldOf(world) || 'unknown', layer, String(z), String(x), `${y}.img`);
}

/** Сколько тайлов уже лежит на диске и сколько это байт. */
function cacheStats(world) {
  const root = world ? path.join(cacheRoot(), worldOf(world)) : cacheRoot();
  let files = 0;
  let bytes = 0;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch (_) {
          /* файл убрали между чтением каталога и статистикой */
        }
      }
    }
  };

  walk(root);
  return { files, bytes };
}

function clearCache(world) {
  const root = world ? path.join(cacheRoot(), worldOf(world)) : cacheRoot();
  const stats = cacheStats(world);
  fs.rmSync(root, { recursive: true, force: true });
  missing.clear();
  logger.info(SOURCE, `Кэш тайлов очищен: ${stats.files} файлов, ${Math.round(stats.bytes / 1024)} КБ`);
  return stats;
}

/* ------------------------------------------------------------- скачивание */

function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const request = client.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          // Некоторые тайл-серверы отдают webp только «браузерам».
          'User-Agent': 'DayZPanel/1.0 (+tile cache)',
          Accept: 'image/webp,image/png,image/*;q=0.8'
        }
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return fetchUrl(next, redirects + 1).then(resolve, reject);
        }

        // 404 — тайла действительно нет (край карты, дальний зум). 403/401 —
        // другое: источник не отдаёт тайлы этому клиенту. Путать их нельзя,
        // иначе панель будет молча считать, что карта просто закончилась.
        if (status === 404) {
          res.resume();
          const error = new Error('тайла нет (404)');
          error.code = 'missing';
          return reject(error);
        }

        if (status === 403 || status === 401) {
          res.resume();
          const error = new Error(`источник отказал в доступе (${status})`);
          error.code = 'forbidden';
          return reject(error);
        }

        if (status !== 200) {
          res.resume();
          return reject(new Error(`тайл-сервер ответил ${status}`));
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ body: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
        res.on('error', reject);
      }
    );

    request.on('timeout', () => request.destroy(new Error('тайл-сервер не ответил за 15 с')));
    request.on('error', reject);
  });
}

/** Очередь: одновременных запросов к чужому серверу должно быть немного. */
function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const item = queue.shift();
    running++;
    item
      .task()
      .then(item.resolve, item.reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}

/**
 * Тайл для браузера: сначала диск, потом сеть.
 * @returns {Promise<{body: Buffer, type: string, cached: boolean}>}
 */
async function tile(world, layer, z, x, y) {
  const zoom = Number(z);
  const tx = Number(x);
  const ty = Number(y);

  const reject = (message) => {
    const error = new Error(message);
    error.code = 'bad-request';
    return error;
  };

  if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_ZOOM) throw reject(`зум вне диапазона 0…${MAX_ZOOM}`);
  const span = 2 ** zoom;
  if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= span || ty >= span) {
    throw reject('тайл за границами карты');
  }

  const kind = layer === 'satellite' ? 'satellite' : 'topographic';
  const file = tilePath(world, kind, zoom, tx, ty);

  try {
    return { body: fs.readFileSync(file), type: contentTypeOf(file), cached: true };
  } catch (_) {
    /* на диске нет — идём в сеть */
  }

  const key = `${worldOf(world)}/${kind}/${zoom}/${tx}/${ty}`;
  if (missing.has(key)) {
    const error = new Error('тайла нет у источника');
    error.code = 'missing';
    throw error;
  }

  // Карта нарезана вручную: чего нет на диске, того нет вообще.
  if (isLocal(world, kind)) {
    const error = new Error('этого тайла нет в нарезанной карте');
    error.code = 'missing';
    throw error;
  }

  const template = templateFor(world, kind);
  if (!template) {
    const error = new Error(`для карты «${worldOf(world) || '—'}» не известен адрес тайлов`);
    error.code = 'no-source';
    throw error;
  }

  const sourceKey = `${worldOf(world)}/${kind}`;
  const failed = freshFailure(sourceKey);
  if (failed) {
    const error = new Error(failed.reason);
    error.code = 'source-down';
    throw error;
  }

  const url = template
    .replace('{z}', String(zoom))
    .replace('{x}', String(tx))
    .replace('{y}', String(ty));

  let result;
  try {
    result = await enqueue(() => fetchUrl(url));
  } catch (err) {
    // Отсутствующий тайл — обычное дело на краях карты и на дальних зумах,
    // поэтому в лог он не пишется: запомнили и больше не спрашиваем.
    if (err.code === 'missing') missing.add(key);
    else noteFailure(sourceKey, err.message);
    throw err;
  }

  // В кэш попадает только картинка. Иначе страница с ошибкой, отданная с кодом
  // 200 (заглушка провайдера, портал Wi-Fi), осталась бы там навсегда.
  if (!looksLikeImage(result.body)) {
    const error = new Error('тайл-сервер вернул не картинку');
    error.code = 'bad-upstream';
    throw error;
  }

  failures.delete(sourceKey);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, result.body);
  } catch (err) {
    logger.warn(SOURCE, `Тайл ${key} не сохранён в кэш: ${err.message}`);
  }

  return { body: result.body, type: result.type || guessType(url), cached: false };
}

/** PNG, JPEG или WebP по первым байтам. */
function looksLikeImage(buffer) {
  if (!buffer || buffer.length < 12) return false;

  const png = buffer[0] === 0x89 && buffer.slice(1, 4).toString('ascii') === 'PNG';
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const webp = buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';

  // У настоящего тайла есть содержимое: 12 байт «правильной» подписи мало.
  return (png || jpeg || webp) && buffer.length > 100;
}

function guessType(name) {
  if (/\.webp($|\?)/i.test(name)) return 'image/webp';
  if (/\.png($|\?)/i.test(name)) return 'image/png';
  if (/\.jpe?g($|\?)/i.test(name)) return 'image/jpeg';
  return 'image/webp';
}

/** Тип по первым байтам файла: расширение в кэше у всех одинаковое. */
function contentTypeOf(file) {
  let head;
  try {
    const handle = fs.openSync(file, 'r');
    head = Buffer.alloc(12);
    fs.readSync(handle, head, 0, 12, 0);
    fs.closeSync(handle);
  } catch (_) {
    return 'image/webp';
  }

  if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  return 'image/webp';
}

/* ------------------------------------------------------- локальные тайлы */

/**
 * Своя карта, нарезанная на тайлы.
 *
 * Картинку карты в 150 МБ браузер одним файлом не осилит: ему пришлось бы
 * держать в памяти целый растр (16000×16000 — это больше гигабайта). Поэтому
 * нарезкой занимается браузер админа один раз: он читает файл локально, режет на
 * тайлы 256×256 по уровням масштаба и отправляет их в панель. Дальше карта
 * работает как обычная тайловая — грузятся только видимые куски.
 *
 * Тайлы ложатся в тот же кэш, что и скачанные из интернета, поэтому рисовать их
 * умеет уже написанный код. Отличие одно: рядом лежит метка .local, и при её
 * наличии панель никогда не ходит в сеть за этой картой.
 */
function localMarker(world, layer) {
  return path.join(cacheRoot(), worldOf(world) || 'unknown', layer, '.local');
}

function isLocal(world, layer) {
  return fs.existsSync(localMarker(world, layer));
}

/** Записать один нарезанный тайл. */
function saveTile(world, layer, z, x, y, body) {
  const kind = layer === 'satellite' ? 'satellite' : 'topographic';

  if (!looksLikeImage(body)) throw new Error('тайл не картинка');
  if (body.length > 4 * 1024 * 1024) throw new Error('тайл больше 4 МБ — это точно не тайл 256×256');

  const zoom = Number(z);
  const span = 2 ** zoom;
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_ZOOM) throw new Error(`зум вне диапазона 0…${MAX_ZOOM}`);
  if (!(Number(x) >= 0 && Number(x) < span && Number(y) >= 0 && Number(y) < span)) {
    throw new Error('тайл за границами карты');
  }

  const file = tilePath(world, kind, zoom, Number(x), Number(y));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);

  // Метка «карта своя»: с ней панель не пойдёт в интернет за отсутствующими
  // тайлами — их там и нет, а лишние запросы только тормозили бы карту.
  const marker = localMarker(world, kind);
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    logger.info(SOURCE, `Карта «${worldOf(world)}» переведена на свои тайлы (${kind})`);
  }

  return { saved: true, bytes: body.length };
}

/* --------------------------------------------------- своя картинка карты */

/**
 * Одна картинка вместо тайлов.
 *
 * Тайл-серверы сообщества держат версию карты в адресе и удаляют старые версии
 * (об этом прямо предупреждает dzmap), поэтому подложка из интернета может
 * отвалиться в любой момент. Своя картинка этого лишена: панель скачивает её
 * один раз, кладёт рядом с собой и дальше отдаёт с диска.
 *
 * Резать на тайлы не нужно — карта рисуется на холсте одним изображением.
 */
const IMAGE_ROOT = path.join(__dirname, '..', '..', 'data', 'maps');
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

function imageFile(world) {
  const name = worldOf(world) || 'unknown';

  try {
    for (const entry of fs.readdirSync(IMAGE_ROOT)) {
      if (entry.replace(/\.[^.]+$/, '') === name) return path.join(IMAGE_ROOT, entry);
    }
  } catch (_) {
    /* папки ещё нет */
  }
  return '';
}

function imageInfo(world) {
  const file = imageFile(world);
  if (!file) return { exists: false };

  try {
    const stat = fs.statSync(file);
    const head = Buffer.alloc(Math.min(65536, stat.size));

    const handle = fs.openSync(file, 'r');
    fs.readSync(handle, head, 0, head.length, 0);
    fs.closeSync(handle);

    const measured = imageSize(head) || {};
    return {
      exists: true,
      file,
      bytes: stat.size,
      width: measured.width || 0,
      height: measured.height || 0,
      // Мир DayZ квадратный: неквадратная картинка растянется и метки поедут.
      square: Boolean(measured.width && measured.width === measured.height),
      changedAt: Math.round(stat.mtimeMs)
    };
  } catch (_) {
    return { exists: false };
  }
}

/**
 * Ссылки, которые ведут не на файл, а на страницу просмотра.
 *
 * Самый частый случай — Google Drive: по ссылке вида /file/d/<id>/view отдаётся
 * HTML, и панель честно отвечала «по ссылке не картинка». Приводим такие ссылки
 * к прямой отдаче файла.
 */
function directUrl(url) {
  const drive = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i) || url.match(/drive\.google\.com\/open\?id=([^&#]+)/i);
  if (drive) return `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download`;

  // Dropbox: ?dl=0 отдаёт страницу, ?raw=1 — сам файл.
  if (/dropbox\.com\//i.test(url)) return url.replace(/([?&])dl=0/i, '$1raw=1');

  return url;
}

/** Сохранить готовые байты картинки как подложку карты. */
function saveImage(world, body, contentType) {
  if (!looksLikeImage(body)) {
    throw new Error(
      'это не картинка (нужен PNG, JPEG или WebP). Если ссылка ведёт на страницу просмотра, ' +
        'возьмите прямую ссылку на файл или загрузите файл с компьютера'
    );
  }
  if (body.length > MAX_IMAGE_BYTES) throw new Error('картинка больше 512 МБ — нарежьте её на тайлы кнопкой «Нарезать на тайлы»');

  const measured = imageSize(body) || {};
  const type = measured.type || contentType || '';
  const extension = /png/i.test(type) ? 'png' : /webp/i.test(type) ? 'webp' : 'jpg';
  const file = path.join(IMAGE_ROOT, `${worldOf(world) || 'unknown'}.${extension}`);

  // Старый файл мог быть с другим расширением — убираем, иначе останутся два.
  const previous = imageFile(world);
  if (previous && previous !== file) fs.rmSync(previous, { force: true });

  fs.mkdirSync(IMAGE_ROOT, { recursive: true });
  fs.writeFileSync(file, body);

  logger.info(SOURCE, `Картинка карты сохранена: ${file} (${Math.round(body.length / 1024)} КБ)`);
  return imageInfo(world);
}

/** Скачать картинку карты по ссылке. */
async function setImage(world, url) {
  const address = String(url || '').trim();
  if (!/^https?:\/\//i.test(address)) throw new Error('нужна ссылка, начинающаяся с http:// или https://');

  const result = await enqueue(() => fetchUrl(directUrl(address)));
  return saveImage(world, result.body, result.type);
}

function clearImage(world) {
  const file = imageFile(world);
  if (file) fs.rmSync(file, { force: true });
  return { removed: Boolean(file) };
}

/* ------------------------------------------------------- проверка источника */

/**
 * Скачать один тайл прямо сейчас и рассказать, что получилось.
 *
 * Нужно для ответа на вопрос «почему карта пустая»: причин ровно три —
 * карты нет в каталоге, нет сети, или источник отвечает отказом. Без такой
 * проверки их не различить, потому что браузер видит только пустой холст.
 */
async function test(world, layer) {
  const kind = layer === 'satellite' ? 'satellite' : 'topographic';
  const template = templateFor(world, kind);
  const entry = resolve(world);

  const result = {
    world: worldOf(world),
    known: Boolean(entry),
    layer: kind,
    template,
    url: '',
    ok: false,
    error: '',
    bytes: 0,
    type: ''
  };

  if (!template) {
    result.error = entry
      ? `для карты «${result.world}» нет слоя «${kind}»`
      : `карта «${result.world || '—'}» не в каталоге панели: укажите свой адрес тайлов`;
    return result;
  }

  // Нулевой зум — это один тайл на всю карту, он есть у любого источника.
  result.url = template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');

  try {
    const tile = await enqueue(() => fetchUrl(result.url));
    result.bytes = tile.body.length;
    result.type = tile.type;

    if (!looksLikeImage(tile.body)) {
      result.error = 'источник ответил, но это не картинка — проверьте адрес';
      return result;
    }

    result.ok = true;
    failures.delete(`${result.world}/${kind}`);
  } catch (err) {
    if (err.code === 'missing') {
      result.error =
        'источник ответил «нет такого тайла» (404) — вероятно, у этой карты сменилась версия тайлов; ' +
        'укажите свой адрес в настройках';
    } else if (err.code === 'forbidden') {
      result.error =
        `${err.message} — он не отдаёт тайлы программам или закрыт для вашей сети. ` +
        'Поднимите свой тайл-сервер (например, dzmap) и укажите его адрес ниже';
    } else {
      result.error = `${err.message} — проверьте, есть ли на этой машине интернет`;
    }
  }

  return result;
}

/* ------------------------------------------------------------------ статус */

/**
 * Что показать в панели: какая карта, откуда тайлы, сколько уже в кэше.
 * @param {string} world имя мира от мода или миссии из настроек сервера
 */
function status(world) {
  const entry = resolve(world);
  const s = settings();
  const template = templateFor(world, s.layer);

  return {
    world: worldOf(world),
    known: Boolean(entry),
    size: entry ? entry.size : 0,
    layers: entry ? Object.keys(entry.layers || {}) : [],
    maxZoom: MAX_ZOOM,
    tileSize: TILE_SIZE,
    tiles: {
      ...s,
      source: template ? new URL(template.replace(/\{[zxy]\}/g, '0')).origin : '',
      // Полный шаблон полезен админу: по нему видно и карту, и версию тайлов.
      template,
      hasSource: Boolean(template)
    },
    cache: cacheStats(world),
    localTiles: isLocal(world, s.layer),
    image: imageInfo(world),
    lastError: (freshFailure(`${worldOf(world)}/${s.layer}`) || {}).reason || '',
    reason: reasonFor(entry, template, s, isLocal(world, s.layer))
  };
}

function reasonFor(entry, template, s, local) {
  if (!s.enabled) return 'подложка выключена в настройках панели';
  if (local) return '';
  if (template) return '';
  if (!entry) {
    return (
      'карта не в списке известных панели — укажите свой адрес тайлов в настройках ' +
      '(шаблон вида https://сервер/{z}/{x}/{y}.png) или оставьте сетку координат'
    );
  }
  return 'для этой карты не указан слой тайлов';
}

module.exports = {
  MAX_ZOOM,
  TILE_SIZE,
  catalogue,
  resolve,
  sizeOf,
  worldOf,
  settings,
  status,
  tile,
  test,
  imageFile,
  imageInfo,
  setImage,
  saveImage,
  saveTile,
  isLocal,
  directUrl,
  clearImage,
  cacheStats,
  clearCache
};
