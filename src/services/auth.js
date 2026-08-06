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

  logger.info(SOURCE, '─'.repeat(60));
  logger.info(SOURCE, 'МАСТЕР-КЛЮЧИ ДЛЯ ВХОДА В ПАНЕЛЬ (действуют до перезапуска):');
  keys.forEach((key, index) => logger.info(SOURCE, `   ${index + 1}.  ${key}`));
  logger.info(SOURCE, `Сессия живёт ${sessionHours()} ч. Ключи новые при каждом запуске панели.`);
  logger.info(SOURCE, '─'.repeat(60));
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

function createSession(keyIndex, ip, agent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + sessionHours() * 3600_000;

  sessions.set(token, { createdAt: Date.now(), expiresAt, keyIndex, ip, agent });
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
const PUBLIC_PATHS = new Set(['/login.html', '/api/auth/login', '/api/auth/status', '/favicon.ico']);

function middleware() {
  return (req, res, next) => {
    const s = settings();
    if (!s.enabled) return next();

    const url = req.path || req.url.split('?')[0];
    if (PUBLIC_PATHS.has(url)) return next();

    if (sessionOf(req)) return next();

    // Браузеру отдаём страницу входа, программе — понятный отказ.
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      res.setHeader('Location', '/login.html');
      return res.status(302).end();
    }

    return res.status(401).json({ error: 'Требуется вход по мастер-ключу', auth: 'required' });
  };
}

/** Состояние входа для страницы логина и интерфейса. */
function status(req) {
  const s = settings();
  const session = req ? sessionOf(req) : null;

  return {
    required: s.enabled,
    mode: s.mode,
    loopback: s.loopback,
    host: s.host,
    https: tls().enabled,
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
  start,
  stop,
  settings,
  middleware,
  login,
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
