'use strict';

/**
 * База данных MySQL/MariaDB — общая для панели, сайта и Discord-бота.
 *
 * До этого панель обходилась файлами, и для неё одной этого хватало. Но у сайта
 * и бота уже есть своя MySQL (XAMPP), и держать истину в трёх местах — верный
 * способ получить расхождения: именно из-за этого сейчас криво работает
 * верификация (её состояние лежит и в JSON, и в user_profiles).
 *
 * Правила, по которым это сделано:
 *   - база необязательна. Пока panel.database.enabled = false, панель работает
 *     как раньше, на файлах: обновление не должно ломать рабочую панель;
 *   - панель не трогает чужие таблицы. Свои называются panel_*, а к таблицам
 *     сайта и бота (user_profiles, site_*, trader_*) она обращается только на
 *     чтение и только там, где это прямо описано;
 *   - подключение ленивое и переживает падение MySQL: XAMPP на рабочей машине
 *     выключают и включают, и панель от этого падать не должна.
 */

const mysql = require('mysql2/promise');

const config = require('./config');
const logger = require('./logger');

const SOURCE = 'db';

let pool = null;
/** Настройки, на которых создан текущий пул: сменились — пересоздаём. */
let poolKey = '';
let lastError = '';
let schemaReady = false;

/* --------------------------------------------------------------- настройки */

function settings() {
  const cfg = config.load();
  const db = (cfg.panel && cfg.panel.database) || {};

  return {
    enabled: Boolean(db.enabled),
    host: String(db.host || '127.0.0.1'),
    port: Number(db.port) || 3306,
    user: String(db.user || 'root'),
    password: String(db.password || ''),
    name: String(db.name || 'tfl_bot'),
    charset: String(db.charset || 'utf8mb4')
  };
}

const keyOf = (s) => `${s.host}:${s.port}/${s.name}?u=${s.user}&p=${s.password ? '1' : '0'}`;

/* ---------------------------------------------------------------- пул */

function getPool() {
  const s = settings();
  if (!s.enabled) return null;

  const key = keyOf(s);
  if (pool && poolKey === key) return pool;

  // Настройки поменяли — старый пул больше не нужен.
  if (pool) {
    const previous = pool;
    pool = null;
    previous.end().catch(() => {});
  }

  pool = mysql.createPool({
    host: s.host,
    port: s.port,
    user: s.user,
    password: s.password,
    database: s.name,
    charset: s.charset,
    waitForConnections: true,
    connectionLimit: 6,
    // Панель не должна зависать целиком, если MySQL выключили посреди работы.
    connectTimeout: 8000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    namedPlaceholders: true
  });

  poolKey = key;
  schemaReady = false;
  return pool;
}

/** Понятная причина, почему база не отвечает. */
function explain(err) {
  const code = err && err.code;

  if (code === 'ECONNREFUSED') return 'MySQL не отвечает: проверьте, запущен ли он в XAMPP Control Panel';
  if (code === 'ER_ACCESS_DENIED_ERROR') return 'MySQL отказал в доступе: неверный пользователь или пароль';
  if (code === 'ER_BAD_DB_ERROR') return `базы «${settings().name}» нет — создайте её в phpMyAdmin`;
  if (code === 'ETIMEDOUT') return 'MySQL не ответил вовремя: проверьте адрес и порт';
  if (code === 'ENOTFOUND') return 'адрес MySQL не найден: проверьте host';

  return (err && err.message) || 'неизвестная ошибка базы';
}

/**
 * Выполнить запрос.
 * @param {string} sql запрос с именованными параметрами (:name)
 * @param {object} params значения
 */
async function query(sql, params = {}) {
  const active = getPool();
  if (!active) throw new Error('база данных выключена в настройках панели');

  try {
    const [rows] = await active.execute(sql, params);
    lastError = '';
    return rows;
  } catch (err) {
    lastError = explain(err);
    throw new Error(lastError);
  }
}

/** Одна строка или null. */
async function one(sql, params = {}) {
  const rows = await query(sql, params);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/* -------------------------------------------------------------- схема */

/**
 * Свои таблицы панели.
 *
 * panel_identity — единственная истина о том, кто подтвердил владение Steam и
 * Discord. Именно её будут читать и сайт, и бот: в ней нет «почти привязано» и
 * нет второй копии в JSON.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS panel_identity (
     discord_id   VARCHAR(32)  NOT NULL,
     steam_id     VARCHAR(32)  NOT NULL,
     nickname     VARCHAR(64)  NULL,
     discord_tag  VARCHAR(64)  NULL,
     verified_at  DATETIME     NOT NULL,
     source       VARCHAR(24)  NOT NULL,
     note         VARCHAR(255) NULL,
     PRIMARY KEY (discord_id),
     UNIQUE KEY uniq_steam (steam_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS panel_verify_sessions (
     token        VARCHAR(64)  NOT NULL,
     discord_id   VARCHAR(32)  NULL,
     discord_tag  VARCHAR(64)  NULL,
     steam_id     VARCHAR(32)  NULL,
     guild_id     VARCHAR(32)  NULL,
     stage        VARCHAR(16)  NOT NULL,
     created_at   DATETIME     NOT NULL,
     expires_at   DATETIME     NOT NULL,
     PRIMARY KEY (token),
     KEY idx_discord (discord_id),
     KEY idx_expires (expires_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS panel_audit (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     ts         DATETIME     NOT NULL,
     actor      VARCHAR(64)  NULL,
     action     VARCHAR(48)  NOT NULL,
     target     VARCHAR(64)  NULL,
     details    TEXT         NULL,
     PRIMARY KEY (id),
     KEY idx_ts (ts)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

/** Создать свои таблицы, если их ещё нет. Чужие не трогаем. */
async function ensureSchema(force = false) {
  if (schemaReady && !force) return { ok: true, created: false };

  const active = getPool();
  if (!active) throw new Error('база данных выключена в настройках панели');

  for (const statement of SCHEMA) {
    try {
      await active.query(statement);
    } catch (err) {
      lastError = explain(err);
      throw new Error(`таблицы панели не созданы: ${lastError}`);
    }
  }

  schemaReady = true;
  logger.info(SOURCE, `Таблицы панели готовы в базе «${settings().name}»`);
  return { ok: true, created: true };
}

/* -------------------------------------------------------------- состояние */

/**
 * Проверить связь и показать, что видно в базе.
 *
 * Отдельно перечисляем таблицы сайта и бота: по ним видно, что панель смотрит в
 * ту же базу, а не в пустую новую.
 */
async function status() {
  const s = settings();
  const base = { enabled: s.enabled, host: s.host, port: s.port, name: s.name, user: s.user };

  if (!s.enabled) {
    return { ...base, ok: false, reason: 'база данных выключена — панель работает на файлах' };
  }

  try {
    const version = await one('SELECT VERSION() AS v');
    const tables = await query(
      `SELECT TABLE_NAME AS name, TABLE_ROWS AS rows_estimate
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = :db
        ORDER BY TABLE_NAME`,
      { db: s.name }
    );

    const names = tables.map((t) => t.name);
    return {
      ...base,
      ok: true,
      version: version ? version.v : '',
      tables: names,
      panelTables: names.filter((n) => n.startsWith('panel_')),
      // Таблицы, по которым узнаётся база сайта и бота.
      foreign: names.filter((n) => /^(user_profiles|site_|trader_|content_|guild_settings)/.test(n)),
      reason: ''
    };
  } catch (err) {
    return { ...base, ok: false, reason: err.message };
  }
}

async function close() {
  if (!pool) return;

  const previous = pool;
  pool = null;
  poolKey = '';
  await previous.end().catch(() => {});
}

module.exports = { settings, query, one, ensureSchema, status, close, explain, SCHEMA, lastError: () => lastError };
