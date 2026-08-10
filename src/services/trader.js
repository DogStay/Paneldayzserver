'use strict';

/**
 * Трейдер MAODev Trade System: чтение и правка файлов торговца.
 *
 * Перенесено из `trader_manager.py` прежнего бота (3400 строк) с сохранением
 * правил, которые там выстрадали. Логика живёт в панели, а не в боте, потому что
 * файлы лежат рядом с сервером, а бот может стоять на другой машине; бот и сайт
 * пользуются этим по API.
 *
 * Раскладка файлов (не наша, её задаёт мод MAODev):
 *
 *   <trade>/trader_main_setting.json    валюты: currency_list[]
 *   <trade>/Traders_list.json           торговцы: Traders[] с trader_mode и списками категорий
 *   <trade>/trader_category_list/*.json категории продажи: { name_category, products[] }
 *   <trade>/barter_category_list/*.json категории бартера: { name_category, products[] }
 *
 * Товар: classname, variable_items[], buy_price, sell_price, quantity_buy,
 * quantity_sell, count_product (склад), hidden_item (0/1).
 *
 * Правила, которые нельзя нарушать (все — из прежнего бота):
 *   - quantity_buy и quantity_sell не могут быть 0 (мод считает 0 запретом и
 *     ломает выдачу), hidden_item только 0 или 1;
 *   - classname в категории уникален;
 *   - категорию, назначенную торговцу, удалять нельзя — сначала снять с NPC;
 *   - назначить категорию можно только торговцу с подходящим trader_mode:
 *     trader-категории — режимам trader и trader_barter, barter — barter и
 *     trader_barter;
 *   - перед каждой правкой файла делается копия: файлы правит не только панель.
 *
 * Имя файла категории — это её id. Если категория назначена NPC, но лежит не в
 * своей папке, файл ищется по всему дереву (кроме папок копий и логов): у людей
 * так бывает, и прежний бот это тоже учитывал.
 */

const fs = require('fs');
const path = require('path');

const config = require('./../config');
const logger = require('./../logger');
const eventlog = require('./eventlog');

const SOURCE = 'trader';

const TRADER_LIST = 'Traders_list.json';
const MAIN_SETTING = 'trader_main_setting.json';
const FOLDERS = { trader: 'trader_category_list', barter: 'barter_category_list' };

/** Папки, в которых не ищем файлы категорий. */
const IGNORED = new Set(['backup', 'backups', 'logs', '_discord_backups', '_panel_backups']);

/** Сколько копий одного файла держим. */
const BACKUP_KEEP = 30;

class TraderError extends Error {}

/* ------------------------------------------------------------------- путь */

/** Папка Trade System. Относительный путь считается от папки профиля сервера. */
function tradePath(serverId) {
  const v = config.active(serverId);
  const configured = (v.trader && v.trader.path) || '';
  if (!configured) throw new TraderError('не указана папка Trade System в настройках сервера');

  const full = path.isAbsolute(configured) ? configured : path.join(config.profilesPath(v), configured);
  if (!fs.existsSync(full)) throw new TraderError(`папки Trade System нет на диске: ${full}`);

  return full;
}

const normalizeId = (value) => String(value === undefined || value === null ? '' : value).trim();

const kindOf = (value) => (String(value || '').trim().toLowerCase() === 'barter' ? 'barter' : 'trader');

/** Папка категорий. Регистр имени может отличаться — ищем и так. */
function categoryFolder(trade, kind) {
  const wanted = FOLDERS[kindOf(kind)];
  const direct = path.join(trade, wanted);
  if (fs.existsSync(direct)) return direct;

  for (const entry of fs.readdirSync(trade, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.toLowerCase() === wanted.toLowerCase()) return path.join(trade, entry.name);
  }
  return direct;
}

/** Все .json в папке, включая вложенные. */
function jsonFilesIn(dir, depth = 4) {
  if (!fs.existsSync(dir) || depth < 0) return [];
  const out = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name.toLowerCase())) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) out.push(...jsonFilesIn(full, depth - 1));
    else if (entry.name.toLowerCase().endsWith('.json')) out.push(full);
  }
  return out;
}

/**
 * id категории -> файл.
 *
 * Файлы ближе к корню папки побеждают — так же, как в прежнем боте: если
 * одинаковое имя встречается дважды, берём менее вложенный.
 */
function categoryIndex(trade, kind) {
  const files = jsonFilesIn(categoryFolder(trade, kind)).sort(
    (a, b) => a.split(path.sep).length - b.split(path.sep).length || a.toLowerCase().localeCompare(b.toLowerCase())
  );

  const index = new Map();
  for (const file of files) {
    const id = path.basename(file, '.json').trim();
    if (id && !index.has(id.toLowerCase())) index.set(id.toLowerCase(), file);
  }

  // Категории, назначенные NPC, но лежащие не в своей папке.
  const missing = referencedCategoryIds(trade, kind).filter((id) => !index.has(id.toLowerCase()));
  if (missing.length) {
    for (const file of jsonFilesIn(trade, 5)) {
      const key = path.basename(file, '.json').trim().toLowerCase();
      if (missing.some((id) => id.toLowerCase() === key) && !index.has(key)) index.set(key, file);
    }
  }

  return index;
}

function categoryPath(trade, categoryId, kind) {
  const id = normalizeId(categoryId);
  const found = categoryIndex(trade, kind).get(id.toLowerCase());
  return found || path.join(categoryFolder(trade, kind), `${id}.json`);
}

/* ------------------------------------------------------------ чтение файлов */

function readJson(file) {
  if (!fs.existsSync(file)) throw new TraderError(`файл не найден: ${file}`);

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new TraderError(`ошибка чтения JSON в «${path.basename(file)}»: ${err.message}`);
  }
}

/**
 * Запись с копией и через временный файл.
 *
 * Отступ в четыре пробела — как в файлах мода: их читают и правят руками, и
 * лишняя разница в форматировании мешает сравнивать версии.
 */
function writeJson(file, data) {
  backup(file);

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Копия файла перед правкой, с ограничением числа копий. */
function backup(file) {
  if (!fs.existsSync(file)) return '';

  const dir = path.join(path.dirname(file), '_panel_backups');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(dir, `${path.basename(file, '.json')}-${stamp}.json`);

  try {
    fs.copyFileSync(file, copy);
  } catch (err) {
    logger.warn(SOURCE, `Копия ${path.basename(file)} не создана: ${err.message}`);
    return '';
  }

  // Старые копии убираем, иначе папка растёт бесконечно.
  const own = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${path.basename(file, '.json')}-`))
    .sort();
  for (const name of own.slice(0, Math.max(0, own.length - BACKUP_KEEP))) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (_) {
      /* не критично */
    }
  }

  return copy;
}

/* -------------------------------------------------------------- торговцы */

function tradersFile(trade) {
  return path.join(trade, TRADER_LIST);
}

function loadTraders(trade) {
  const file = tradersFile(trade);
  const data = readJson(file);

  if (!Array.isArray(data.Traders)) throw new TraderError(`в ${TRADER_LIST} нет массива Traders`);
  return { file, data, traders: data.Traders.filter((item) => item && typeof item === 'object') };
}

function referencedCategoryIds(trade, kind) {
  const field = kindOf(kind) === 'barter' ? 'category_list_barter' : 'category_list_trader';

  let traders = [];
  try {
    traders = loadTraders(trade).traders;
  } catch (_) {
    return [];
  }

  const out = [];
  for (const trader of traders) {
    for (const value of Array.isArray(trader[field]) ? trader[field] : []) {
      const id = normalizeId(value);
      if (id && !out.some((item) => item.toLowerCase() === id.toLowerCase())) out.push(id);
    }
  }
  return out;
}

/** Торговцы с их категориями — для списков и админки бота. */
function traders(serverId) {
  const trade = tradePath(serverId);
  const list = loadTraders(trade).traders;

  return list.map((trader) => ({
    traderId: normalizeId(trader.trader_id),
    mode: normalizeId(trader.trader_mode),
    currencyId: normalizeId(trader.currency_id),
    name: normalizeId(trader.trader_name || trader.name),
    categoriesTrader: (Array.isArray(trader.category_list_trader) ? trader.category_list_trader : []).map(normalizeId),
    categoriesBarter: (Array.isArray(trader.category_list_barter) ? trader.category_list_barter : []).map(normalizeId)
  }));
}

/** Валюты из trader_main_setting.json. */
function currencies(serverId) {
  const trade = tradePath(serverId);
  const file = path.join(trade, MAIN_SETTING);
  if (!fs.existsSync(file)) return [];

  const data = readJson(file);
  return (Array.isArray(data.currency_list) ? data.currency_list : []).map((currency) => ({
    currencyId: normalizeId(currency.currency_id),
    nominals: (Array.isArray(currency.currency_nominal) ? currency.currency_nominal : []).map((n) => ({
      classname: normalizeId(n.currency_classname),
      value: Number(n.currency_value) || 0
    }))
  }));
}

/* -------------------------------------------------------------- категории */

const productsOf = (data) => (Array.isArray(data.products) ? data.products.filter((p) => p && typeof p === 'object') : []);

/** Список категорий с числом товаров. */
function categories(serverId, kind = 'trader') {
  const trade = tradePath(serverId);
  const index = categoryIndex(trade, kind);
  const assigned = new Map();

  for (const trader of traders(serverId)) {
    const list = kindOf(kind) === 'barter' ? trader.categoriesBarter : trader.categoriesTrader;
    for (const id of list) {
      const key = id.toLowerCase();
      assigned.set(key, [...(assigned.get(key) || []), trader.traderId]);
    }
  }

  const out = [];
  for (const [key, file] of index) {
    const id = path.basename(file, '.json').trim();
    let name = '';
    let count = 0;
    let error = '';

    try {
      const data = readJson(file);
      name = normalizeId(data.name_category);
      count = productsOf(data).length;
    } catch (err) {
      error = err.message;
    }

    out.push({ id, name, products: count, traders: assigned.get(key) || [], file, error });
  }

  // Категории, на которые ссылаются NPC, но файла нет — это поломка, и её надо
  // показывать, а не молча пропускать.
  for (const id of referencedCategoryIds(trade, kind)) {
    if (!index.has(id.toLowerCase())) {
      out.push({ id, name: '', products: 0, traders: assigned.get(id.toLowerCase()) || [], file: '', error: 'файла категории нет на диске' });
    }
  }

  return out.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
}

/** Товары категории. Индекс — ключ товара: classname может повторяться в файле. */
function products(serverId, categoryId, kind = 'trader') {
  const trade = tradePath(serverId);
  const file = categoryPath(trade, categoryId, kind);
  const data = readJson(file);

  return {
    id: normalizeId(categoryId),
    name: normalizeId(data.name_category),
    kind: kindOf(kind),
    file,
    products: productsOf(data).map((product, index) =>
      kindOf(kind) === 'barter'
        ? {
            index,
            received: (Array.isArray(product.received_classname) ? product.received_classname : []).map(normalizeId),
            required: (Array.isArray(product.required_classname) ? product.required_classname : []).map(normalizeId)
          }
        : {
            index,
            classname: normalizeId(product.classname),
            buyPrice: Number(product.buy_price),
            sellPrice: Number(product.sell_price),
            quantityBuy: Number(product.quantity_buy),
            quantitySell: Number(product.quantity_sell),
            count: Number(product.count_product),
            hidden: Number(product.hidden_item) === 1,
            variableItems: Array.isArray(product.variable_items) ? product.variable_items : []
          }
    )
  };
}

function createCategory(serverId, { id, name, kind = 'trader' }) {
  const trade = tradePath(serverId);
  const categoryId = normalizeId(id);
  if (!categoryId) throw new TraderError('нужен id категории (он же имя файла)');

  const file = categoryPath(trade, categoryId, kind);
  if (fs.existsSync(file)) throw new TraderError('категория уже существует');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, { name_category: normalizeId(name) || categoryId, products: [] });

  note(serverId, `создана категория ${kindOf(kind)} «${categoryId}»`);
  return { id: categoryId, file, kind: kindOf(kind) };
}

function deleteCategory(serverId, { id, kind = 'trader' }) {
  const trade = tradePath(serverId);
  const categoryId = normalizeId(id);
  const file = categoryPath(trade, categoryId, kind);
  if (!fs.existsSync(file)) throw new TraderError('категория не найдена');

  // Назначенную категорию удалять нельзя: торговец начнёт ссылаться в пустоту.
  const field = kindOf(kind) === 'barter' ? 'categoriesBarter' : 'categoriesTrader';
  const linked = traders(serverId)
    .filter((trader) => trader[field].some((item) => item.toLowerCase() === categoryId.toLowerCase()))
    .map((trader) => trader.traderId);

  if (linked.length) throw new TraderError(`категория назначена торговцам: ${linked.join(', ')}. Сначала снимите её с них`);

  backup(file);
  fs.unlinkSync(file);
  note(serverId, `удалена категория ${kindOf(kind)} «${categoryId}»`);

  return { id: categoryId, deleted: true };
}

/* ----------------------------------------------------------------- товары */

/** Проверка товара — те же правила, что в прежнем боте. */
function validateProduct(product) {
  if (!normalizeId(product.classname)) throw new TraderError('classname не может быть пустым');

  const numbers = {
    buy_price: product.buy_price,
    sell_price: product.sell_price,
    quantity_buy: product.quantity_buy,
    quantity_sell: product.quantity_sell,
    count_product: product.count_product,
    hidden_item: product.hidden_item
  };

  for (const [key, value] of Object.entries(numbers)) {
    if (!Number.isFinite(Number(value))) throw new TraderError(`${key} должно быть числом`);
  }

  // Ноль мод понимает как «нельзя», и товар просто перестаёт работать.
  if (Number(product.quantity_buy) === 0 || Number(product.quantity_sell) === 0) {
    throw new TraderError('quantity_buy и quantity_sell не могут быть 0');
  }
  if (![0, 1].includes(Number(product.hidden_item))) throw new TraderError('hidden_item должен быть 0 или 1');
}

/** true/false и 0/1 понимаем, остальное отдаём как есть — на проверку. */
function hiddenOf(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback === undefined ? 0 : Number(fallback);
  if (value === true) return 1;
  if (value === false) return 0;
  return Number(value);
}

function payloadOf(input, base = {}) {
  const pick = (a, b, fallback) => (a === undefined || a === null || a === '' ? (b === undefined ? fallback : b) : a);

  return {
    classname: normalizeId(pick(input.classname, base.classname, '')),
    variable_items: Array.isArray(input.variableItems) ? input.variableItems : base.variable_items || [],
    buy_price: Number(pick(input.buyPrice, base.buy_price, -1)),
    sell_price: Number(pick(input.sellPrice, base.sell_price, -1)),
    quantity_buy: Number(pick(input.quantityBuy, base.quantity_buy, -1)),
    quantity_sell: Number(pick(input.quantitySell, base.quantity_sell, -3)),
    count_product: Number(pick(input.count, base.count_product, -1)),
    /*
     * hidden не приводим к 0/1 молча: если пришло 5, это ошибка вызывающего, и
     * validateProduct должен её показать, а не тихо выключить скрытие.
     */
    hidden_item: hiddenOf(input.hidden, base.hidden_item)
  };
}

function addProduct(serverId, { category, kind = 'trader', ...input }) {
  const trade = tradePath(serverId);
  const file = categoryPath(trade, category, kind);
  if (!fs.existsSync(file)) throw new TraderError('категория не найдена');

  const product = payloadOf(input);
  validateProduct(product);

  const data = readJson(file);
  const list = productsOf(data);

  if (list.some((item) => normalizeId(item.classname).toLowerCase() === product.classname.toLowerCase())) {
    throw new TraderError('такой товар уже есть в категории');
  }

  list.push(product);
  data.products = list;
  writeJson(file, data);

  note(serverId, `добавлен товар ${product.classname} в «${normalizeId(category)}»`);
  return { index: list.length - 1, product };
}

function updateProduct(serverId, { category, kind = 'trader', index, ...input }) {
  const trade = tradePath(serverId);
  const file = categoryPath(trade, category, kind);
  const data = readJson(file);
  const list = productsOf(data);

  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= list.length) throw new TraderError('товар не найден');

  const current = list[position];
  const next = payloadOf(input, current);

  // Смена classname на уже занятый превратила бы два товара в один.
  if (next.classname.toLowerCase() !== normalizeId(current.classname).toLowerCase()) {
    const clash = list.some(
      (item, i) => i !== position && normalizeId(item.classname).toLowerCase() === next.classname.toLowerCase()
    );
    if (clash) throw new TraderError('товар с таким classname уже есть в категории');
  }

  validateProduct(next);
  list[position] = { ...current, ...next };
  data.products = list;
  writeJson(file, data);

  note(serverId, `изменён товар ${next.classname} в «${normalizeId(category)}»`);
  return { index: position, product: list[position] };
}

function deleteProduct(serverId, { category, kind = 'trader', index }) {
  const trade = tradePath(serverId);
  const file = categoryPath(trade, category, kind);
  const data = readJson(file);
  const list = productsOf(data);

  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= list.length) throw new TraderError('товар не найден');

  const [removed] = list.splice(position, 1);
  data.products = list;
  writeJson(file, data);

  const label = kindOf(kind) === 'barter' ? describeBarter(removed) : normalizeId(removed.classname);
  note(serverId, `удалён ${kindOf(kind) === 'barter' ? 'бартер-рецепт' : 'товар'} ${label} из «${normalizeId(category)}»`);

  return { deleted: label };
}

function describeBarter(recipe) {
  const received = (Array.isArray(recipe.received_classname) ? recipe.received_classname : []).map(normalizeId);
  const required = (Array.isArray(recipe.required_classname) ? recipe.required_classname : []).map(normalizeId);
  return `${received.join(', ') || '—'} за ${required.join(', ') || '—'}`;
}

/* ------------------------------------------------- категории у торговцев */

function assignCategory(serverId, { traderId, category, kind = 'trader' }) {
  const trade = tradePath(serverId);
  const categoryId = normalizeId(category);

  if (!fs.existsSync(categoryPath(trade, categoryId, kind))) throw new TraderError('категория не найдена');

  const { file, data, traders: list } = loadTraders(trade);
  const trader = list.find((item) => normalizeId(item.trader_id).toLowerCase() === normalizeId(traderId).toLowerCase());
  if (!trader) throw new TraderError('торговец не найден');

  const field = kindOf(kind) === 'barter' ? 'category_list_barter' : 'category_list_trader';
  const allowed = kindOf(kind) === 'barter' ? ['barter', 'trader_barter'] : ['trader', 'trader_barter'];
  const mode = normalizeId(trader.trader_mode);

  if (!allowed.includes(mode)) {
    throw new TraderError(`режим торговца «${mode || 'не указан'}» не поддерживает категории типа ${kindOf(kind)}`);
  }

  if (!Array.isArray(trader[field])) trader[field] = [];
  if (trader[field].some((item) => normalizeId(item).toLowerCase() === categoryId.toLowerCase())) {
    throw new TraderError('категория уже назначена этому торговцу');
  }

  trader[field].push(categoryId);
  writeJson(file, data);

  note(serverId, `категория «${categoryId}» назначена торговцу ${normalizeId(trader.trader_id)}`);
  return { traderId: normalizeId(trader.trader_id), category: categoryId, kind: kindOf(kind) };
}

function removeCategory(serverId, { traderId, category, kind = 'trader' }) {
  const trade = tradePath(serverId);
  const categoryId = normalizeId(category);

  const { file, data, traders: list } = loadTraders(trade);
  const trader = list.find((item) => normalizeId(item.trader_id).toLowerCase() === normalizeId(traderId).toLowerCase());
  if (!trader) throw new TraderError('торговец не найден');

  const field = kindOf(kind) === 'barter' ? 'category_list_barter' : 'category_list_trader';
  const current = Array.isArray(trader[field]) ? trader[field] : [];

  if (!current.some((item) => normalizeId(item).toLowerCase() === categoryId.toLowerCase())) {
    throw new TraderError('эта категория не назначена торговцу');
  }

  trader[field] = current.filter((item) => normalizeId(item).toLowerCase() !== categoryId.toLowerCase());
  writeJson(file, data);

  note(serverId, `категория «${categoryId}» снята с торговца ${normalizeId(trader.trader_id)}`);
  return { traderId: normalizeId(trader.trader_id), category: categoryId, kind: kindOf(kind) };
}

/* ------------------------------------------------------------- проверка */

/**
 * Проверить все файлы торговца.
 *
 * Тот же набор проверок, что делал прежний бот при старте: валюты, категории,
 * товары, ссылки торговцев на категории. Смысл — узнать о поломке до того, как
 * её найдут игроки.
 */
function validateAll(serverId) {
  const trade = tradePath(serverId);
  const issues = [];

  // Валюты
  try {
    const data = readJson(path.join(trade, MAIN_SETTING));
    const list = Array.isArray(data.currency_list) ? data.currency_list : null;

    if (!list) issues.push(`${MAIN_SETTING}: currency_list должен быть массивом`);
    else {
      const seenIds = new Set();
      const seenClassnames = new Set();

      for (const currency of list) {
        const id = normalizeId(currency && currency.currency_id);
        if (!id) issues.push(`${MAIN_SETTING}: пустой currency_id`);
        else if (seenIds.has(id)) issues.push(`${MAIN_SETTING}: повтор currency_id «${id}»`);
        seenIds.add(id);

        for (const nominal of Array.isArray(currency.currency_nominal) ? currency.currency_nominal : []) {
          const classname = normalizeId(nominal && nominal.currency_classname);
          if (classname && seenClassnames.has(classname)) {
            issues.push(`${MAIN_SETTING}: classname валюты повторяется: «${classname}»`);
          }
          if (classname) seenClassnames.add(classname);
        }
      }
    }
  } catch (err) {
    issues.push(err.message);
  }

  // Категории и товары
  const known = { trader: new Set(), barter: new Set() };
  for (const kind of ['trader', 'barter']) {
    for (const [, file] of categoryIndex(trade, kind)) {
      const id = path.basename(file, '.json').trim();
      known[kind].add(id.toLowerCase());

      try {
        const data = readJson(file);
        if (!normalizeId(data.name_category)) issues.push(`${kind}:${id} — нет name_category`);

        if (!Array.isArray(data.products)) {
          issues.push(`${kind}:${id} — нет массива products`);
          continue;
        }

        data.products.forEach((product, i) => {
          if (!product || typeof product !== 'object') {
            issues.push(`${kind}:${id} — запись #${i + 1} не объект`);
            return;
          }

          if (kind === 'trader') {
            try {
              validateProduct(product);
            } catch (err) {
              issues.push(`${kind}:${id} — товар #${i + 1}: ${err.message}`);
            }
          } else {
            if (!Array.isArray(product.received_classname) || !product.received_classname.length) {
              issues.push(`${kind}:${id} — бартер #${i + 1} без received_classname`);
            }
            if (!Array.isArray(product.required_classname) || !product.required_classname.length) {
              issues.push(`${kind}:${id} — бартер #${i + 1} без required_classname`);
            }
          }
        });
      } catch (err) {
        issues.push(err.message);
      }
    }
  }

  // Торговцы
  try {
    const list = loadTraders(trade).traders;
    const seen = new Set();

    for (const trader of list) {
      const id = normalizeId(trader.trader_id);
      if (!id) {
        issues.push(`${TRADER_LIST}: торговец без trader_id`);
        continue;
      }
      if (seen.has(id)) issues.push(`${TRADER_LIST}: повтор trader_id «${id}»`);
      seen.add(id);

      const mode = normalizeId(trader.trader_mode);
      const forTrader = (Array.isArray(trader.category_list_trader) ? trader.category_list_trader : []).map(normalizeId);
      const forBarter = (Array.isArray(trader.category_list_barter) ? trader.category_list_barter : []).map(normalizeId);

      if (['trader', 'trader_barter'].includes(mode) && !forTrader.length) {
        issues.push(`${TRADER_LIST}: «${id}» без category_list_trader`);
      }
      if (['barter', 'trader_barter'].includes(mode) && !forBarter.length) {
        issues.push(`${TRADER_LIST}: «${id}» без category_list_barter`);
      }
      if (['trader', 'trader_barter'].includes(mode) && !normalizeId(trader.currency_id)) {
        issues.push(`${TRADER_LIST}: «${id}» без currency_id`);
      }

      for (const category of forTrader) {
        if (!known.trader.has(category.toLowerCase())) {
          issues.push(`${TRADER_LIST}: «${id}» ссылается на отсутствующую trader-категорию «${category}»`);
        }
      }
      for (const category of forBarter) {
        if (!known.barter.has(category.toLowerCase())) {
          issues.push(`${TRADER_LIST}: «${id}» ссылается на отсутствующую barter-категорию «${category}»`);
        }
      }
    }
  } catch (err) {
    issues.push(err.message);
  }

  return { ok: issues.length === 0, issues };
}

/** Полная копия папки торговца — перед крупными правками. */
function fullBackup(serverId) {
  const trade = tradePath(serverId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(trade, '_panel_backups', `full-${stamp}`);

  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (IGNORED.has(entry.name.toLowerCase())) continue;

      const source = path.join(from, entry.name);
      const destination = path.join(to, entry.name);
      if (entry.isDirectory()) copyDir(source, destination);
      else fs.copyFileSync(source, destination);
    }
  };

  copyDir(trade, target);
  note(serverId, 'сделана полная копия файлов торговца');

  return { path: target };
}

/** Общее состояние: путь, торговцы, категории, валюты, проверка. */
function status(serverId) {
  try {
    const trade = tradePath(serverId);
    const check = validateAll(serverId);

    return {
      ok: true,
      path: trade,
      traders: traders(serverId),
      currencies: currencies(serverId),
      categories: { trader: categories(serverId, 'trader'), barter: categories(serverId, 'barter') },
      issues: check.issues,
      reason: ''
    };
  } catch (err) {
    return {
      ok: false,
      path: '',
      traders: [],
      currencies: [],
      categories: { trader: [], barter: [] },
      issues: [],
      reason: err.message
    };
  }
}

/**
 * Правки торговца — в общий журнал событий.
 *
 * Иначе «кто уронил цены» выясняется только по памяти: файлы правит и панель, и
 * бот, и человек руками.
 */
function note(serverId, phrase) {
  try {
    eventlog.append(serverId, [
      { ts: Date.now(), type: 'admin', data: { source: 'trader', action: 'трейдер', phrase } }
    ]);
  } catch (_) {
    /* журнал не должен мешать правке */
  }
  logger.info(SOURCE, phrase, { serverId });
}

module.exports = {
  TraderError,
  tradePath,
  status,
  traders,
  currencies,
  categories,
  products,
  createCategory,
  deleteCategory,
  addProduct,
  updateProduct,
  deleteProduct,
  assignCategory,
  removeCategory,
  validateAll,
  validateProduct,
  fullBackup
};
