'use strict';

/**
 * Необязательная интеграция с CFTools Cloud (cftools.com).
 *
 * Панель управляет сервером «снизу» — файлами, процессом, модами. CFTools
 * смотрит на тот же сервер «сверху»: кто сейчас играет, кого забанили, что
 * происходит в игре. Ничего из этого панель сама узнать не может: DayZ не
 * отдаёт список игроков процессу, а RCon у него старый и неудобный.
 *
 * Поэтому интеграция именно опциональная: пока она выключена, панель работает
 * ровно как раньше и в интернет за этим не ходит. Включив её и указав ключи из
 * developer.cftools.cloud, вы получаете в панели живой список игроков, кик,
 * баны, сообщения в игру и RCon-команды.
 *
 * Устройство Data API:
 *   1. POST /v1/auth/register {application_id, secret} -> token (живёт сутки);
 *   2. дальше все запросы с заголовком Authorization: Bearer <token>;
 *   3. права выдаются на конкретный ресурс — сервер (Server API ID) или
 *      банлист, их список отдаёт GET /v1/@app/grants.
 */

const config = require('../config');
const logger = require('../logger');

const SOURCE = 'cftools';

const API_V1 = 'https://data.cftools.cloud/v1';
const API_V2 = 'https://data.cftools.cloud/v2';

const REQUEST_TIMEOUT_MS = 20_000;

/** Ограничение CFTools на сообщение игрокам. */
const MAX_MESSAGE_LENGTH = 256;
/** Минимальный промежуток между запросами: у API строгие лимиты частоты. */
const MIN_REQUEST_GAP_MS = 150;

/** Токены по Application ID: { token, expiresAt }. */
const tokens = new Map();

let lastRequestAt = 0;
let queue = Promise.resolve();

/* --------------------------------------------------------------- настройки */

/** Настройки интеграции для сервера (глобальные ключи + ID этого сервера). */
function settings(serverId) {
  const v = config.active(serverId);
  return { ...v.cftools, serverName: v.name, serverId: v.id };
}

/** Состояние интеграции без обращения к сети — для интерфейса. */
function status(serverId) {
  const cfg = config.load();
  let server = { serverApiId: '', banlistId: '' };
  try {
    const v = config.active(serverId);
    server = { serverApiId: v.cftools.serverApiId, banlistId: v.cftools.banlistId };
  } catch (_) {
    /* сервера может не быть вовсе */
  }

  const cached = tokens.get(cfg.cftools.applicationId);
  return {
    enabled: Boolean(cfg.cftools.enabled),
    hasApplicationId: Boolean(cfg.cftools.applicationId),
    hasSecret: Boolean(cfg.cftools.secret),
    ...server,
    ready: Boolean(cfg.cftools.enabled && cfg.cftools.applicationId && cfg.cftools.secret && server.serverApiId),
    tokenValidUntil: cached ? new Date(cached.expiresAt).toISOString() : null
  };
}

/**
 * Проверить, что интеграцией вообще можно пользоваться.
 * Сообщения намеренно подробные: это первое, что видит пользователь, когда
 * что-то не заполнено.
 */
function assertReady(serverId, { needServer = true, needBanlist = false } = {}) {
  const cfg = config.load();
  if (!cfg.cftools.enabled) {
    throw new Error('Интеграция с CFTools выключена. Включите её в настройках сервера.');
  }
  if (!cfg.cftools.applicationId || !cfg.cftools.secret) {
    throw new Error(
      'Не заполнены Application ID и Secret. Создайте приложение на developer.cftools.cloud ' +
        'и впишите ключи в настройках панели.'
    );
  }

  const s = settings(serverId);
  if (needServer && !s.serverApiId) {
    throw new Error(
      'Не указан Server API ID этого сервера. Он есть на странице сервера в CFTools Cloud ' +
        '(Settings → API), либо нажмите «Мои ресурсы» и выберите сервер из списка.'
    );
  }
  if (needBanlist && !s.banlistId) {
    throw new Error('Не указан Banlist ID. Возьмите его в CFTools Cloud или выберите в «Моих ресурсах».');
  }

  if (typeof fetch !== 'function') {
    throw new Error('Для работы с CFTools нужен Node.js 18 или новее (в старых версиях нет fetch).');
  }

  return s;
}

/* ------------------------------------------------------------ авторизация */

/** Токен доступа: берётся из кэша, пока не истёк. */
async function token(force = false) {
  const cfg = config.load();
  const appId = cfg.cftools.applicationId;
  const cached = tokens.get(appId);

  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const data = await send('POST', `${API_V1}/auth/register`, {
    body: { application_id: appId, secret: cfg.cftools.secret },
    anonymous: true
  });

  if (!data || !data.token) throw new Error('CFTools не вернул токен доступа — проверьте Application ID и Secret.');

  // valid_for приходит в секундах; на всякий случай держим не дольше суток.
  const validForMs = Math.min(Number(data.valid_for) || 0, 86_400) * 1000 || 20 * 60 * 60 * 1000;
  tokens.set(appId, { token: data.token, expiresAt: Date.now() + validForMs });
  logger.info(SOURCE, `Получен токен доступа CFTools (действует ${Math.round(validForMs / 3600000)} ч)`);

  return data.token;
}

/** Забыть токен — например, после смены ключей в настройках. */
function resetToken() {
  tokens.clear();
}

/* ---------------------------------------------------------------- запросы */

/**
 * Все запросы идут по одному в порядке очереди с небольшой паузой: CFTools
 * считает частоту обращений на приложение, и параллельные запросы из панели
 * быстро приводят к 429.
 */
function schedule(fn) {
  const run = queue.then(async () => {
    const gap = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  });

  // Очередь не должна ломаться из-за неудачного запроса.
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function send(method, url, opts = {}) {
  return schedule(async () => {
    const headers = { 'User-Agent': 'DayZPanel', Accept: 'application/json' };
    if (!opts.anonymous) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('CFTools не ответил за 20 секунд.');
      throw new Error(`Не удалось связаться с CFTools: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { raw: text.slice(0, 300) };
      }
    }

    if (!response.ok) throw httpError(response, data);
    return data;
  });
}

/** Понятное сообщение вместо кода ответа. */
function httpError(response, data) {
  const code = data && typeof data.error === 'string' ? data.error : '';
  const retryAfter = response.headers.get('retry-after');

  const messages = {
    'bad-secret': 'CFTools отклонил Secret приложения — проверьте ключ в настройках.',
    'bad-token': 'Токен доступа CFTools отклонён. Панель получит новый — повторите действие.',
    'expired-token': 'Токен доступа CFTools истёк. Повторите действие.',
    'token-regeneration-required': 'CFTools требует перевыпустить Secret приложения в панели разработчика.',
    'no-grant':
      'У приложения нет доступа к этому ресурсу. На developer.cftools.cloud выдайте приложению грант ' +
      'на нужный сервер или банлист.',
    'login-required': 'CFTools требует авторизацию — проверьте Application ID и Secret.',
    'not-found': 'CFTools не нашёл запрошенный ресурс: проверьте Server API ID / Banlist ID.',
    'invalid-resource': 'CFTools считает указанный ID некорректным.',
    'invalid-bucket': 'CFTools не нашёл такой банлист.',
    duplicate: 'Такая запись в CFTools уже есть.',
    'max-length-exceeded': 'Слишком длинный текст — CFTools ограничивает сообщения и причины.',
    'parameter-required': 'CFTools не хватило обязательного параметра запроса.',
    'system-unavailable': 'CFTools недоступен: сервис сообщает о проблемах на своей стороне.',
    timeout: 'CFTools не успел обработать запрос — попробуйте ещё раз.',
    unexpected: 'CFTools вернул внутреннюю ошибку.'
  };

  if (response.status === 429) {
    return new Error(
      'CFTools ограничил частоту запросов (429)' +
        (retryAfter ? `, повторить можно через ${retryAfter} с.` : ' — подождите немного.')
    );
  }
  if (response.status === 403 && !code) {
    return new Error('CFTools отказал в доступе (403). Проверьте гранты приложения и Server API ID.');
  }

  const known = messages[code];
  if (known) return new Error(known);

  return new Error(`CFTools ответил ошибкой ${response.status}${code ? ` (${code})` : ''}`);
}

/**
 * Запрос к API от имени приложения. Просроченный токен обновляется один раз
 * автоматически — пользователю про это знать не нужно.
 */
async function call(method, path, opts = {}) {
  const base = opts.v2 ? API_V2 : API_V1;
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(opts.query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const attempt = async (force) =>
    send(method, url.toString(), { body: opts.body, token: await token(force) });

  try {
    return await attempt(false);
  } catch (err) {
    if (/токен доступа/i.test(err.message)) {
      resetToken();
      return attempt(true);
    }
    throw err;
  }
}

/* ------------------------------------------------------------- ресурсы приложения */

/** Серверы и банлисты, к которым у приложения есть доступ. */
async function grants() {
  assertReady(undefined, { needServer: false });
  const data = await call('GET', '/@app/grants');
  const tokensBlock = (data && data.tokens) || {};

  const map = (list) =>
    (Array.isArray(list) ? list : []).map((grant) => ({
      id: (grant.resource && grant.resource.id) || '',
      identifier: (grant.resource && grant.resource.identifier) || '',
      objectId: (grant.resource && grant.resource.object_id) || '',
      gameserverId: (grant.resource && grant.resource.gameserver_id) || '',
      createdAt: grant.created_at || null
    }));

  return { servers: map(tokensBlock.server), banlists: map(tokensBlock.banlist) };
}

/* ------------------------------------------------------------------ сервер */

/** Информация о сервере: имя, аптайм, игровое время, следующий перезапуск. */
async function serverInfo(serverId) {
  const s = assertReady(serverId);
  const data = await call('GET', `/server/${encodeURIComponent(s.serverApiId)}/info`);
  const server = (data && data.server) || {};
  const gameserver = server.gameserver || {};
  const runtime = gameserver.runtime || {};
  const restart = (runtime.restart_schedule && runtime.restart_schedule.next) || {};

  return {
    nickname: (server._object && server._object.nickname) || '',
    online: (server.worker && server.worker.state) === 'WorkerState.CONNECTED',
    workerState: (server.worker && server.worker.state) || '',
    gameserverId: gameserver.gameserver_id || '',
    integration: {
      status: Boolean(gameserver.game_integration && gameserver.game_integration.status),
      version: (gameserver.game_integration && gameserver.game_integration.version) || '',
      capabilities: (gameserver.game_integration && gameserver.game_integration.capabilities) || []
    },
    gametime: runtime.gametime || '',
    uptimeSec: Number(runtime.uptime) || 0,
    nextRestart: restart.local || restart.utc || null,
    connection: server.connection || null
  };
}

/** Игроки онлайн. Формат CFTools упрощаем до того, что показывает панель. */
async function players(serverId) {
  const s = assertReady(serverId);
  const data = await call('GET', `/server/${encodeURIComponent(s.serverApiId)}/GSM/list`);
  const sessions = Array.isArray(data && data.sessions) ? data.sessions : [];

  return sessions.map((session) => {
    const live = session.live || {};
    const connection = session.connection || {};
    const persona = session.persona || {};
    const info = session.info || {};

    return {
      sessionId: session.id || '',
      cftoolsId: session.cftools_id || '',
      name: (session.gamedata && session.gamedata.player_name) || 'без имени',
      steam64: (session.gamedata && session.gamedata.steam64) || '',
      loaded: Boolean(live.loaded),
      loadTimeSec: Number(live.load_time) || 0,
      ping: (live.ping && Number(live.ping.actual)) || 0,
      position: (live.position && live.position.latest) || null,
      country: connection.country_code || '',
      countryName: (connection.country_names && connection.country_names.ru) || '',
      ipv4: connection.ipv4 || '',
      malicious: Boolean(connection.malicious),
      banCount: Number(info.ban_count) || 0,
      labels: Array.isArray(info.labels) ? info.labels : [],
      avatar: (persona.profile && persona.profile.avatar) || '',
      createdAt: session.created_at || null,
      stats: session.stats || {}
    };
  });
}

/** Статистика игрока на этом сервере. */
async function playerStats(serverId, cftoolsId) {
  const s = assertReady(serverId);
  if (!cftoolsId) throw new Error('Не указан CFTools ID игрока');

  return call('GET', `/server/${encodeURIComponent(s.serverApiId)}/player`, {
    v2: true,
    query: { cftools_id: cftoolsId }
  });
}

/** CFTools ID по Steam64 / имени / другому идентификатору. */
async function lookup(identifier) {
  assertReady(undefined, { needServer: false });
  if (!identifier) throw new Error('Не указан идентификатор игрока');
  const data = await call('GET', '/users/lookup', { query: { identifier } });
  return { cftoolsId: (data && data.cftools_id) || '', notice: (data && data.notice) || '' };
}

/* --------------------------------------------------------------- действия */

function limit(text, max, what) {
  const value = String(text ?? '').trim();
  if (!value) throw new Error(`${what} не может быть пустым`);
  if (value.length > max) throw new Error(`${what}: максимум ${max} символов`);
  return value;
}

/** Выкинуть игрока с сервера. */
async function kick(serverId, sessionId, reason) {
  const s = assertReady(serverId);
  if (!sessionId) throw new Error('Не указана игровая сессия игрока');

  await call('POST', `/server/${encodeURIComponent(s.serverApiId)}/kick`, {
    body: { gamesession_id: sessionId, reason: limit(reason || 'Kicked by admin', 128, 'Причина кика') }
  });

  logger.info(SOURCE, `«${s.serverName}»: игрок ${sessionId} исключён (${reason || 'без причины'})`);
  return { ok: true };
}

/** Личное сообщение игроку в игре. */
async function messagePrivate(serverId, sessionId, content) {
  const s = assertReady(serverId);
  if (!sessionId) throw new Error('Не указана игровая сессия игрока');

  await call('POST', `/server/${encodeURIComponent(s.serverApiId)}/message-private`, {
    body: { gamesession_id: sessionId, content: limit(content, 256, 'Сообщение') }
  });

  logger.info(SOURCE, `«${s.serverName}»: личное сообщение игроку ${sessionId}`);
  return { ok: true };
}

/**
 * Сообщение всем игрокам на сервере.
 *
 * У CFTools это платная возможность: на бесплатном тарифе запрос отклоняется.
 * Поэтому к отказу добавляется подсказка про BattlEye RCon — бесплатный канал,
 * который умеет то же самое.
 */
async function broadcast(serverId, content) {
  const s = assertReady(serverId);
  const body = { content: limit(content, MAX_MESSAGE_LENGTH, 'Сообщение') };

  try {
    await call('POST', `/server/${encodeURIComponent(s.serverApiId)}/message-server`, { body });
  } catch (err) {
    if (/доступ|грант|403|подписк/i.test(err.message)) {
      throw new Error(
        `${err.message} Отправка сообщений в игру у CFTools доступна на платной подписке — ` +
          'если её нет, переключите канал сообщений на BattlEye RCon в настройках сервера.'
      );
    }
    throw err;
  }

  logger.info(SOURCE, `«${s.serverName}»: сообщение всем игрокам отправлено`);
  return { ok: true };
}

/** RCon-команда серверу (то же, что консоль администратора DayZ). */
async function rcon(serverId, command) {
  const s = assertReady(serverId);

  await call('POST', `/server/${encodeURIComponent(s.serverApiId)}/raw`, {
    body: { command: limit(command, 256, 'Команда') }
  });

  logger.warn(SOURCE, `«${s.serverName}»: выполнена RCon-команда «${command}»`);
  return { ok: true };
}

/* ------------------------------------------------------------------- баны */

/** Список банов из банлиста. filter — CFTools ID, IPv4 или комментарий. */
async function listBans(serverId, filter) {
  const s = assertReady(serverId, { needServer: false, needBanlist: true });
  const data = await call('GET', `/banlist/${encodeURIComponent(s.banlistId)}/bans`, {
    query: { filter: filter || '' }
  });

  return (Array.isArray(data && data.entries) ? data.entries : []).map((entry) => ({
    id: entry.id || '',
    identifier: entry.identifier || '',
    reason: entry.reason || '',
    status: String(entry.status || '').replace('Ban.', ''),
    createdAt: entry.created_at || null,
    updatedAt: entry.updated_at || null,
    expiresAt: entry.expires_at || null
  }));
}

/**
 * Забанить игрока.
 * @param {{identifier: string, format?: 'cftools_id'|'ipv4', reason: string,
 *          expiresAt?: string|null}} input expiresAt пустой = навсегда
 */
async function createBan(serverId, input = {}) {
  const s = assertReady(serverId, { needServer: false, needBanlist: true });
  const format = input.format === 'ipv4' ? 'ipv4' : 'cftools_id';

  let identifier = String(input.identifier || '').trim();
  if (!identifier) throw new Error('Не указан идентификатор игрока');

  // По Steam64 или имени CFTools банить не умеет — сначала находим CFTools ID.
  if (format === 'cftools_id' && !/^[a-f0-9]{24}$/i.test(identifier)) {
    const found = await lookup(identifier);
    if (!found.cftoolsId) throw new Error(`CFTools не знает игрока ${identifier}`);
    identifier = found.cftoolsId;
  }

  await call('POST', `/banlist/${encodeURIComponent(s.banlistId)}/bans`, {
    body: {
      format,
      identifier,
      expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : 'PERMANENT',
      reason: limit(input.reason || 'Banned by admin', 128, 'Причина бана')
    }
  });

  logger.warn(
    SOURCE,
    `«${s.serverName}»: бан ${identifier} (${input.expiresAt ? `до ${input.expiresAt}` : 'навсегда'})`
  );
  return { ok: true, identifier, format };
}

/** Снять бан. */
async function deleteBan(serverId, banId) {
  const s = assertReady(serverId, { needServer: false, needBanlist: true });
  if (!banId) throw new Error('Не указан идентификатор бана');

  await call('DELETE', `/banlist/${encodeURIComponent(s.banlistId)}/bans`, { query: { ban_id: banId } });
  logger.info(SOURCE, `«${s.serverName}»: бан ${banId} снят`);
  return { ok: true };
}

/* --------------------------------------------------------- проверка связи */

/**
 * Проверка настроек одной кнопкой: логин, гранты и — если Server API ID
 * указан — реальный запрос информации о сервере.
 */
async function test(serverId) {
  const cfg = config.load();
  if (!cfg.cftools.applicationId || !cfg.cftools.secret) {
    throw new Error('Заполните Application ID и Secret, затем сохраните настройки.');
  }
  if (typeof fetch !== 'function') {
    throw new Error('Для работы с CFTools нужен Node.js 18 или новее.');
  }

  resetToken();
  await token(true);

  const resources = await grants();
  const s = settings(serverId);
  const result = {
    ok: true,
    servers: resources.servers,
    banlists: resources.banlists,
    serverApiId: s.serverApiId,
    banlistId: s.banlistId,
    server: null,
    playersOnline: null,
    warnings: []
  };

  if (!s.serverApiId) {
    result.warnings.push('Server API ID не указан — выберите сервер из списка доступных.');
    return result;
  }
  if (!resources.servers.some((g) => g.id === s.serverApiId || g.objectId === s.serverApiId)) {
    result.warnings.push('Указанного Server API ID нет среди ресурсов приложения — проверьте гранты в CFTools.');
  }

  result.server = await serverInfo(serverId);
  try {
    result.playersOnline = (await players(serverId)).length;
  } catch (err) {
    result.warnings.push(`Список игроков недоступен: ${err.message}`);
  }

  logger.info(SOURCE, `Связь с CFTools проверена: сервер «${result.server.nickname || s.serverApiId}»`);
  return result;
}

module.exports = {
  status,
  settings,
  test,
  grants,
  serverInfo,
  players,
  playerStats,
  lookup,
  kick,
  messagePrivate,
  broadcast,
  rcon,
  listBans,
  createBan,
  deleteBan,
  resetToken,
  MAX_MESSAGE_LENGTH
};
