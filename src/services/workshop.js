'use strict';

/**
 * Поиск модификаций в Steam Workshop.
 *
 * Работает в трёх режимах, по убыванию надёжности:
 *   1. Запрос по ID или ссылке — Steam API ISteamRemoteStorage/GetPublishedFileDetails.
 *      Ключ Web API не нужен, это самый предсказуемый путь.
 *   2. Поиск по названию с ключом Web API — IPublishedFileService/QueryFiles.
 *      Ключ бесплатно берётся на https://steamcommunity.com/dev/apikey и
 *      указывается в настройках панели.
 *   3. Поиск по названию без ключа — разбор страницы поиска Workshop.
 *      Работает «как есть»: если Valve поменяет вёрстку, поиск по названию
 *      перестанет находить (поиск по ID продолжит работать всегда).
 *
 * Единственное место в панели, которому нужен интернет помимо SteamCMD.
 */

const config = require('../config');
const logger = require('../logger');

const SOURCE = 'workshop';

const API_BASE = process.env.DAYZPANEL_STEAM_API || 'https://api.steampowered.com';
const COMMUNITY_BASE = process.env.DAYZPANEL_STEAM_COMMUNITY || 'https://steamcommunity.com';
const TIMEOUT_MS = 15_000;

/* -------------------------------------------------------------------- утилиты */

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`Steam ответил ${res.status} ${res.statusText}`);
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Steam не ответил вовремя — проверьте интернет');
    if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(err.message)) {
      throw new Error('Нет соединения со Steam. Поиск модов требует интернета');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Вытащить Workshop ID из числа, ссылки или строки «id=123». */
function extractId(query) {
  const text = String(query || '').trim();
  if (/^\d{6,}$/.test(text)) return text;
  const match = text.match(/(?:\?|&)id=(\d{6,})/i) || text.match(/filedetails\/(?:\?id=)?(\d{6,})/i);
  return match ? match[1] : null;
}

function normalizeItem(raw) {
  return {
    id: String(raw.publishedfileid),
    title: raw.title || `Мод ${raw.publishedfileid}`,
    description: (raw.description || '').slice(0, 400),
    preview: raw.preview_url || '',
    sizeBytes: parseInt(raw.file_size, 10) || 0,
    timeUpdated: parseInt(raw.time_updated, 10) || 0,
    subscriptions: parseInt(raw.subscriptions, 10) || 0,
    favorited: parseInt(raw.favorited, 10) || 0,
    banned: Boolean(raw.banned),
    banReason: raw.ban_reason || '',
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => t.tag).filter(Boolean) : [],
    url: `${COMMUNITY_BASE}/sharedfiles/filedetails/?id=${raw.publishedfileid}`
  };
}

/* ------------------------------------------------------------- детали по ID */

/**
 * Подробности о модах по их ID. Ключ Web API не требуется.
 * @param {string[]} ids
 */
async function detailsByIds(ids) {
  const list = [...new Set(ids.map(String).filter(Boolean))];
  if (!list.length) return [];

  const body = new URLSearchParams();
  body.set('itemcount', String(list.length));
  list.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));

  const res = await request(`${API_BASE}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const data = await res.json();
  const items = (data && data.response && data.response.publishedfiledetails) || [];

  return items
    .filter((item) => Number(item.result) === 1 && item.publishedfileid)
    .map(normalizeItem);
}

/* --------------------------------------------------- поиск по названию (API) */

async function searchViaApi(query, { appId, page = 1, perPage = 24, key }) {
  const params = new URLSearchParams({
    key,
    query_type: '12', // RankedByTextSearch
    page: String(page),
    numperpage: String(perPage),
    appid: String(appId),
    search_text: query,
    return_details: 'true',
    return_metadata: 'true',
    return_tags: 'true',
    return_short_description: 'true'
  });

  const res = await request(`${API_BASE}/IPublishedFileService/QueryFiles/v1/?${params}`);
  const data = await res.json();
  const items = (data && data.response && data.response.publishedfiledetails) || [];

  return {
    total: (data && data.response && data.response.total) || items.length,
    items: items.filter((i) => i.publishedfileid).map(normalizeItem),
    mode: 'api'
  };
}

/* ------------------------------------------------- поиск по названию (без ключа) */

async function searchViaCommunity(query, { appId, page = 1 }) {
  const params = new URLSearchParams({
    appid: String(appId),
    searchtext: query,
    childpublishedfileid: '0',
    browsesort: 'textsearch',
    section: 'readytouseitems',
    p: String(page)
  });

  const res = await request(`${COMMUNITY_BASE}/workshop/browse/?${params}`, {
    headers: { 'Accept-Language': 'ru,en;q=0.8' }
  });

  const html = await res.text();
  const ids = parseWorkshopIds(html);
  if (!ids.length) return { total: 0, items: [], mode: 'community' };

  // Страница поиска даёт только id и заголовок — детали берём через API,
  // чтобы карточки были одинаковыми в обоих режимах.
  let items = [];
  try {
    items = await detailsByIds(ids);
  } catch (err) {
    logger.warn(SOURCE, `Детали модов не получены (${err.message}), показываю только названия`);
    items = ids.map((id) => ({
      id,
      title: `Мод ${id}`,
      description: '',
      preview: '',
      sizeBytes: 0,
      timeUpdated: 0,
      subscriptions: 0,
      tags: [],
      url: `${COMMUNITY_BASE}/sharedfiles/filedetails/?id=${id}`
    }));
  }

  // Сохраняем порядок выдачи Steam.
  const order = new Map(ids.map((id, i) => [id, i]));
  items.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));

  return { total: items.length, items, mode: 'community' };
}

/** Вытаскиваем id элементов со страницы поиска Workshop. */
function parseWorkshopIds(html) {
  const ids = [];
  const seen = new Set();
  const re = /sharedfiles\/filedetails\/\?id=(\d{6,})/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    ids.push(match[1]);
    if (ids.length >= 30) break;
  }
  return ids;
}

/* --------------------------------------------------------------- диспетчер */

/**
 * Поиск модов: по ID/ссылке — точный, по тексту — через API или страницу Workshop.
 * @param {string} query
 * @param {{page?: number}} [opts]
 */
async function search(query, opts = {}) {
  const cfg = config.load();
  const appId = cfg.steam.dayzAppId || '221100';
  const text = String(query || '').trim();

  if (!text) throw new Error('Введите название мода или его Workshop ID');

  const directId = extractId(text);
  if (directId) {
    logger.info(SOURCE, `Поиск по ID ${directId}`);
    const items = await detailsByIds([directId]);
    if (!items.length) throw new Error(`Мод с ID ${directId} не найден или скрыт автором`);
    return { total: items.length, items, mode: 'id', query: text };
  }

  logger.info(SOURCE, `Поиск по названию: «${text}»`);

  if (cfg.steam.webApiKey) {
    try {
      const result = await searchViaApi(text, { appId, page: opts.page || 1, key: cfg.steam.webApiKey });
      return { ...result, query: text };
    } catch (err) {
      logger.warn(SOURCE, `Поиск через Web API не удался (${err.message}), пробую страницу Workshop`);
    }
  }

  const result = await searchViaCommunity(text, { appId, page: opts.page || 1 });
  if (!result.items.length) {
    throw new Error(
      `По запросу «${text}» ничего не найдено. Попробуйте другое название или вставьте Workshop ID/ссылку.`
    );
  }
  return { ...result, query: text };
}

module.exports = { search, detailsByIds, extractId, parseWorkshopIds };
