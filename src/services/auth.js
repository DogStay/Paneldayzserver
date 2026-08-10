'use strict';

/**
 * Вход в панель по мастер-ключам.
 *
 * Панель задумана как локальный инструмент, но её удобно открыть наружу, чтобы
 * заходить с любого компьютера. Тогда без входа нельзя: панель управляет
 * сервером, файлами и SteamCMD, а значит доступ к ней — это доступ к машине.
 *
 * Как это работает:
 *   - при каждом запуске панель генерирует новые ключи (по умолчанию три) и
 *     печатает их в своём окне. Ключи живут только в памяти: перезапустили
 *     панель — прежние ключи мертвы, и это осознанно;
 *   - ключ обменивается на сессию (cookie), сессия живёт заданное число часов;
 *   - подбор ключа блокируется по IP: несколько неудач — и адрес отдыхает.
 *
 * Режим «auto» (по умолчанию): на 127.0.0.1 вход не спрашивается — панель и так
 * доступна только с этой машины; как только panel.host смотрит в сеть, вход
 * включается сам. Так локальные пользователи ничего не теряют, а выставленная
 * наружу панель не остаётся открытой.
 */

const crypto = require('crypto');

const config = require('./../config');
const users = require('./users');
const { permissionFor } = require('./permissions');
const logger = require('../logger');

const SOURCE = 'auth';

const COOKIE_NAME = 'dayzpanel_auth';

/** Сколько неудачных попыток подряд с одного адреса до блокировки. */
const MAX_ATTEMPTS = 5;

/** На сколько блокируется адрес после исчерпания попыток. */
const BLOCK_MS = 10 * 60 * 1000;

/** Ключи текущего запуска: обычные строки, наружу не отдаются без входа. */
let keys = [];

/** token -> { createdAt, expiresAt, keyIndex, ip, agent } */
const sessions = new Map();

/** ip -> { failures, blockedUntil } */
const attempts = new Map();

let generatedAt = 0;
let cleanupTimer = null;

/* ------------------------------------------------------------- настройки */

function settings() {
  const panel = config.load().panel;
  const auth = panel.auth || {};
  const host = panel.host || '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  let enabled;
  if (auth.enabled === true) enabled = true;
  else if (auth.enabled === false) enabled = false;
  else enabled = !loopback; // "auto"

  return {
    enabled,
    mode: auth.enabled === true || auth.enabled === false ? String(auth.enabled) : 'auto',
    keyCount: auth.keyCount,
    sessionHours: auth.sessionHours,
    trustProxy: Boolean(auth.trustProxy),
    loopback,
    host
  };
}

/* -------------------------------------------------------------- ключи */

/** Ключ вида A9F3-K2QD-7M1X: читается вслух и легко вводится руками. */
function makeKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O, 1/I
  const groups = [];

  for (let g = 0; g < 3; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Сгенерировать новые ключи. Прежние сессии при этом остаются жить: админ,
 * уже вошедший в панель, не должен вылетать из-за смены ключей.
 */
function generate(reason = 'запуск панели') {
  const s = settings();
  const count = Math.min(Math.max(parseInt(s.keyCount, 10) || 3, 1), 10);

  keys = [];
  for (let i = 0; i < count; i++) keys.push(makeKey());
  generatedAt = Date.now();

  logger.info(SOURCE, `Мастер-ключи выпущены заново (${reason}): ${count} шт.`);
  return keys;
}

/** Показать ключи в окне панели — единственное место, где они видны сразу. */
function announce() {
  const s = settings();

  if (!s.enabled) {
    logger.info(
      SOURCE,
      s.loopback
        ? 'Вход по ключам не требуется: панель слушает только 127.0.0.1'
        : 'ВНИМАНИЕ: вход по ключам выключен в настройках, а панель доступна по сети'
    );
    return;
  }

  /*
   * Сами ключи печатаются ТОЛЬКО в окно панели, минуя логгер.
   *
   * Логгер пишет всё в файл, хранит в памяти и раздаёт в браузер через поток
   * событий — а его может читать интеграция с токеном «только чтение». Попади
   * ключи туда, и токен на чтение превратился бы в полный доступ.
   */
  console.log('─'.repeat(60));
  console.log('МАСТЕР-КЛЮЧИ ДЛЯ ВХОДА В ПАНЕЛЬ (действуют до перезапуска):');
  keys.forEach((key, index) => console.log(`   ${index + 1}.  ${key}`));
  console.log(`Сессия живёт ${sessionHours()} ч. Ключи новые при каждом запуске панели.`);
  console.log('─'.repeat(60));

  logger.info(SOURCE, `Мастер-ключи (${keys.length} шт.) напечатаны в окне панели. Сессия: ${sessionHours()} ч.`);
}

function sessionHours() {
  const hours = parseInt(settings().sessionHours, 10);
  return Math.min(Math.max(Number.isFinite(hours) ? hours : 12, 1), 720);
}

/** Ключи для уже вошедшего администратора — чтобы передать коллеге. */
function listKeys() {
  return keys.map((key, index) => ({ index: index + 1, key }));
}

/* ------------------------------------------------------------- сессии */

function createSession(keyIndex, ip, agent, userId = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + sessionHours() * 3600_000;

  sessions.set(token, { createdAt: Date.now(), expiresAt, keyIndex, ip, agent, userId });
  return { token, expiresAt };
}

function sessionOf(req) {
  const token = cookieOf(req, COOKIE_NAME);
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function destroySession(req) {
  const token = cookieOf(req, COOKIE_NAME);
  if (token) sessions.delete(token);
  return Boolean(token);
}

function cookieOf(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';

  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

/* ---------------------------------------------------- защита от подбора */

function ipOf(req) {
  if (settings().trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'неизвестный адрес';
}

function blockedFor(ip) {
  const record = attempts.get(ip);
  if (!record || !record.blockedUntil) return 0;

  const left = record.blockedUntil - Date.now();
  if (left <= 0) {
    attempts.delete(ip);
    return 0;
  }
  return left;
}

function noteFailure(ip) {
  const record = attempts.get(ip) || { failures: 0, blockedUntil: 0 };
  record.failures++;

  if (record.failures >= MAX_ATTEMPTS) {
    record.blockedUntil = Date.now() + BLOCK_MS;
    record.failures = 0;
    logger.warn(SOURCE, `Адрес ${ip} заблокирован на ${BLOCK_MS / 60000} мин.: перебор ключей`);
  }

  attempts.set(ip, record);
}

/* ---------------------------------------------------------------- вход */

/**
 * Обменять ключ на сессию.
 * @returns {{ok: boolean, error?: string, status?: number, token?: string, expiresAt?: number}}
 */
function login(req, rawKey) {
  const ip = ipOf(req);
  const blocked = blockedFor(ip);

  if (blocked > 0) {
    return {
      ok: false,
      status: 429,
      error: `Слишком много неудачных попыток. Повторите через ${Math.ceil(blocked / 60000)} мин.`
    };
  }

  if (!users.isEmpty()) {
    return {
      ok: false,
      status: 400,
      error: 'Мастер-ключи выключены: в панели есть аккаунты. Входите логином и паролем или через Discord'
    };
  }

  const key = String(rawKey || '').trim().toUpperCase();
  if (!key) return { ok: false, status: 400, error: 'Введите мастер-ключ' };

  // Сравниваем все ключи и постоянным по времени сравнением: так по скорости
  // ответа нельзя понять, насколько ключ «почти угадан».
  let matched = -1;
  for (let i = 0; i < keys.length; i++) {
    const a = Buffer.from(keys[i]);
    const b = Buffer.from(key.padEnd(keys[i].length, ' ').slice(0, keys[i].length));
    if (crypto.timingSafeEqual(a, b)) matched = i;
  }

  if (matched < 0) {
    noteFailure(ip);
    logger.warn(SOURCE, `Неверный мастер-ключ с адреса ${ip}`);
    return { ok: false, status: 401, error: 'Неверный мастер-ключ' };
  }

  attempts.delete(ip);
  const session = createSession(matched + 1, ip, String(req.headers['user-agent'] || '').slice(0, 120));
  logger.info(SOURCE, `Вход по ключу №${matched + 1} с адреса ${ip}`);

  return { ok: true, ...session, keyIndex: matched + 1 };
}

/**
 * Вход по логину и паролю.
 *
 * Ограничитель попыток тот же, что у мастер-ключей: пять промахов с адреса — и
 * он отдыхает, иначе пароль можно перебирать.
 */
function loginWithPassword(req, rawLogin, rawPassword) {
  const ip = ipOf(req);
  const blocked = blockedFor(ip);

  if (blocked > 0) {
    return {
      ok: false,
      status: 429,
      error: `Слишком много неудачных попыток. Повторите через ${Math.ceil(blocked / 60000)} мин.`
    };
  }

  const login = String(rawLogin || '').trim();
  if (!login || !rawPassword) return { ok: false, status: 400, error: 'Введите логин и пароль' };

  const result = users.verify(login, rawPassword);
  if (!result.ok) {
    noteFailure(ip);
    logger.warn(SOURCE, `Неудачный вход «${login}» с адреса ${ip}: ${result.error}`);
    return { ok: false, status: 401, error: result.error };
  }

  attempts.delete(ip);
  const session = createSession(0, ip, String(req.headers['user-agent'] || '').slice(0, 120), result.user.id);
  users.touchLogin(result.user.id);

  logger.info(SOURCE, `Вход «${result.user.name}» (${login}) с адреса ${ip}`);
  return { ok: true, ...session, user: users.publicUser(result.user) };
}

/** Вошедший пользователь по сессии — либо null (мастер-ключ или нет входа). */
function userOf(req) {
  const session = sessionOf(req);
  if (!session || !session.userId) return null;

  const user = users.byId(session.userId);
  if (!user || user.disabled) return null;
  return user;
}

/** Создать сессию для пользователя (вход через Discord и первичная настройка). */
function sessionForUser(req, user) {
  const session = createSession(0, ipOf(req), String(req.headers['user-agent'] || '').slice(0, 120), user.id);
  users.touchLogin(user.id);
  return session;
}

/** Заголовок Set-Cookie для сессии. */
function cookieHeader(token, expiresAt) {
  const secure = tls().enabled ? '; Secure' : '';
  const maxAge = Math.max(1, Math.round((expiresAt - Date.now()) / 1000));
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const clearCookieHeader = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/* ----------------------------------------------------------------- TLS */

/** Настройки HTTPS: без них ключ и данные идут по сети открытым текстом. */
function tls() {
  const panel = config.load().panel;
  const t = panel.tls || {};
  return {
    enabled: Boolean(t.enabled && t.certFile && t.keyFile),
    certFile: t.certFile || '',
    keyFile: t.keyFile || ''
  };
}

/* ------------------------------------------------------------ middleware */

/** Пути, доступные без входа: страница входа и сам вход. */
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/api/auth/login',
  '/api/auth/login/password',
  '/api/auth/register',
  '/api/auth/status',
  '/api/auth/discord/start',
  '/api/auth/discord/callback',
  '/favicon.ico',
  // Мастер настройки: без входа, но только с самой машины — доступ проверяет
  // services/setup.js (pageGuard и localOnly у маршрутов).
  '/setup.html',
  '/js/setup.js',
  '/api/setup',
  '/api/setup/database',
  // Поток верификации игрока: он не пользователь панели и войти в неё не может.
  // Защита здесь — одноразовый токен ссылки, выданный ботом лично игроку.
  '/verify.html',
  '/js/verify.js',
  '/api/verify/session',
  '/api/verify/steam/start',
  '/api/verify/steam/callback'
]);

function middleware() {
  return (req, res, next) => {
    const s = settings();
    if (!s.enabled) return next();

    const url = req.path || req.url.split('?')[0];
    if (PUBLIC_PATHS.has(url)) return next();

    const session = sessionOf(req);
    if (session) {
      // Мастер-ключ действует только пока нет ни одного аккаунта: он для
      // первичной настройки, а дальше вход именной, с правами.
      if (!session.userId) return next();

      const user = users.byId(session.userId);
      if (!user || user.disabled) {
        sessions.delete(session.token);
        return deny(req, res, 'Аккаунт отключён — войдите заново');
      }

      req.panelUser = user;
      const needed = url.startsWith('/api/') ? permissionFor(req.method, url.slice(4)) : 'panel.view';

      if (!users.can(user, needed)) {
        return res.status(403).json({
          error: `Недостаточно прав: нужно «${users.PERMISSIONS[needed] || 'права владельца'}»`,
          auth: 'forbidden',
          needed
        });
      }
      return next();
    }

    // Сайт и бот ходят не мастер-ключом, а постоянным токеном: мастер-ключи
    // меняются при каждом запуске панели и для интеграций не годятся.
    const token = tokenCheck(req);
    if (token.ok) {
      req.panelToken = token.token;
      return next();
    }
    if (token.error) return res.status(token.status || 403).json({ error: token.error, auth: 'token' });

    return deny(req, res);
  };
}

/** Отказ во входе: браузеру — страница входа, программе — понятный JSON. */
function deny(req, res, message) {
  const wantsHtml = String(req.headers.accept || '').includes('text/html');
  if (wantsHtml) {
    res.setHeader('Location', '/login.html');
    return res.status(302).end();
  }

  return res.status(401).json({ error: message || 'Требуется вход в панель', auth: 'required' });
}

/* ------------------------------------------------------------- API-токены */

/**
 * Токены для интеграций (сайт, Discord-бот, свои скрипты).
 *
 * Отличие от мастер-ключей: токен живёт в config.json, переживает перезапуск
 * панели и отзывается по одному. Область прав всего две, и это осознанно:
 *   read  — только чтение (GET): статус, игроки, журнал, карта;
 *   admin — всё, что умеет панель, включая запуск сервера и команды игрокам.
 */
const TOKEN_SCOPES = ['read', 'admin'];

/** Когда последнее использование токена записывали на диск. */
let tokenTouchAt = 0;

function tokenList() {
  const cfg = config.load();
  return Array.isArray(cfg.panel.apiTokens) ? cfg.panel.apiTokens : [];
}

/** Токен из запроса: заголовок или ?token= (у EventSource заголовков нет). */
function tokenFromRequest(req) {
  const header = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();

  const custom = req.headers['x-panel-token'];
  if (custom) return String(custom).trim();

  if (req.query && req.query.token) return String(req.query.token).trim();
  return '';
}

/**
 * Проверить токен запроса.
 * @returns {{ok: boolean, token?: object, error?: string, status?: number}}
 */
function tokenCheck(req) {
  const value = tokenFromRequest(req);
  if (!value) return { ok: false };

  const found = tokenList().find((item) => {
    if (!item.token || item.token.length !== value.length) return false;
    return crypto.timingSafeEqual(Buffer.from(item.token), Buffer.from(value));
  });

  if (!found) {
    logger.warn(SOURCE, `Неизвестный API-токен с адреса ${ipOf(req)}`);
    return { ok: false, error: 'API-токен не найден или отозван', status: 403 };
  }

  // Токен «read» не должен ничего менять: бот с правами чтения не сможет
  // случайно перезапустить сервер или выдать предметы.
  const method = String(req.method || 'GET').toUpperCase();
  if (found.scope === 'read' && method !== 'GET' && method !== 'HEAD') {
    return {
      ok: false,
      error: `Токену «${found.name}» разрешено только чтение (${method} запрещён)`,
      status: 403
    };
  }

  touchToken(found);
  return { ok: true, token: { id: found.id, name: found.name, scope: found.scope } };
}

/** Отметить использование, но не чаще раза в минуту — это запись на диск. */
function touchToken(token) {
  const now = Date.now();
  token.lastUsedAt = now;
  if (now - tokenTouchAt < 60_000) return;

  tokenTouchAt = now;
  try {
    config.updateRoot({ panel: { apiTokens: tokenList() } });
  } catch (_) {
    /* не критично */
  }
}

/**
 * Создать токен. Полное значение возвращается один раз — дальше панель
 * показывает только начало, как это принято с ключами доступа.
 */
function createToken(name, scope) {
  const cleanName = String(name || '').trim().slice(0, 60) || 'интеграция';
  const cleanScope = TOKEN_SCOPES.includes(scope) ? scope : 'read';

  const token = {
    id: crypto.randomBytes(4).toString('hex'),
    name: cleanName,
    scope: cleanScope,
    token: `dzp_${crypto.randomBytes(24).toString('base64url')}`,
    createdAt: Date.now(),
    lastUsedAt: null
  };

  config.updateRoot({ panel: { apiTokens: [...tokenList(), token] } });
  logger.info(SOURCE, `Создан API-токен «${cleanName}» (${cleanScope})`);

  return token;
}

function revokeToken(id) {
  const tokens = tokenList();
  const found = tokens.find((item) => item.id === String(id));
  if (!found) return { revoked: false };

  config.updateRoot({ panel: { apiTokens: tokens.filter((item) => item.id !== String(id)) } });
  logger.warn(SOURCE, `API-токен «${found.name}» отозван`);
  return { revoked: true, name: found.name };
}

/** Список токенов для интерфейса: сами значения не отдаём. */
function publicTokens() {
  return tokenList().map((item) => ({
    id: item.id,
    name: item.name,
    scope: item.scope,
    createdAt: item.createdAt,
    lastUsedAt: item.lastUsedAt,
    preview: `${String(item.token || '').slice(0, 10)}…`
  }));
}

/** Состояние входа для страницы логина и интерфейса. */
function status(req) {
  const s = settings();
  const session = req ? sessionOf(req) : null;

  const cfg = config.load();
  const registration = (cfg.panel.auth && cfg.panel.auth.registration) || {};
  const discordCfg = (cfg.panel.auth && cfg.panel.auth.discord) || {};

  return {
    required: s.enabled,
    mode: s.mode,
    loopback: s.loopback,
    host: s.host,
    https: tls().enabled,
    // Первый запуск: аккаунтов нет, владельца создают по мастер-ключу.
    setup: users.isEmpty(),
    users: users.count(),
    registration: Boolean(registration.enabled),
    discord: Boolean(discordCfg.enabled && discordCfg.clientId && discordCfg.clientSecret),
    // Пароль по открытому HTTP — повод предупредить прямо на странице входа.
    insecure: !tls().enabled && !s.loopback,
    keyCount: keys.length,
    keysIssuedAt: generatedAt || null,
    sessionHours: sessionHours(),
    authenticated: Boolean(session),
    sessions: sessions.size,
    keyIndex: session ? session.keyIndex : null,
    expiresAt: session ? session.expiresAt : null
  };
}

/** Активные сессии — видно, кто и откуда сидит в панели. */
function listSessions() {
  const out = [];
  for (const [token, session] of sessions) {
    out.push({
      id: token.slice(0, 8),
      keyIndex: session.keyIndex,
      ip: session.ip,
      agent: session.agent,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Закрыть чужую сессию (или все). */
function revoke(id) {
  if (!id || id === 'all') {
    const count = sessions.size;
    sessions.clear();
    logger.warn(SOURCE, `Закрыты все сессии панели (${count})`);
    return count;
  }

  for (const token of sessions.keys()) {
    if (token.slice(0, 8) === id) {
      sessions.delete(token);
      logger.warn(SOURCE, `Сессия ${id} закрыта`);
      return 1;
    }
  }
  return 0;
}

/* ---------------------------------------------------------------- запуск */

function start() {
  generate('запуск панели');
  announce();

  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
    for (const [ip, record] of attempts) {
      if (record.blockedUntil && record.blockedUntil <= now) attempts.delete(ip);
    }
  }, 60_000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  const s = settings();
  if (!s.loopback && !tls().enabled) {
    logger.warn(
      SOURCE,
      'Панель доступна по сети без HTTPS: мастер-ключ и данные идут открытым текстом. ' +
        'Поставьте панель за reverse-proxy с сертификатом или укажите panel.tls в настройках.'
    );
  }
}

function stop() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}

module.exports = {
  loginWithPassword,
  userOf,
  sessionForUser,
  start,
  stop,
  settings,
  middleware,
  login,
  // API-токены для интеграций
  createToken,
  revokeToken,
  publicTokens,
  tokenCheck,
  TOKEN_SCOPES,
  status,
  generate,
  announce,
  listKeys,
  listSessions,
  revoke,
  destroySession,
  sessionOf,
  cookieHeader,
  clearCookieHeader,
  tls,
  COOKIE_NAME
};
