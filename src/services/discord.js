'use strict';

/**
 * Вход в панель через Discord (OAuth2).
 *
 * Зачем: у команды сервера уже есть Discord, и заводить отдельные пароли всем
 * не хочется. Панель просит у Discord только «кто вы» (scope identify) — ни
 * писать в чат, ни читать сообщения она не может.
 *
 * Что нужно один раз сделать владельцу: в https://discord.com/developers создать
 * приложение, в разделе OAuth2 добавить Redirect URI вида
 * http://адрес-панели:8787/api/auth/discord/callback и вписать в настройки
 * панели Client ID и Client Secret.
 *
 * Secret наружу не отдаётся: в /api/config он маскируется, как пароль Steam.
 */

const https = require('https');
const crypto = require('crypto');

const config = require('./../config');
const logger = require('../logger');
const users = require('./users');

const SOURCE = 'discord';

const API = 'https://discord.com/api';
const AUTHORIZE = 'https://discord.com/oauth2/authorize';

/** Начатые входы: state -> когда начат. Живут недолго, чисто от подмены. */
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function settings() {
  const cfg = config.load();
  const auth = (cfg.panel && cfg.panel.auth) || {};
  const discord = auth.discord || {};

  return {
    enabled: Boolean(discord.enabled),
    clientId: String(discord.clientId || ''),
    clientSecret: String(discord.clientSecret || ''),
    redirectUri: String(discord.redirectUri || ''),
    /** Пускать ли незнакомые аккаунты и с какой ролью. */
    allowRegistration: discord.allowRegistration !== false,
    defaultRoleId: String(discord.defaultRoleId || 'watcher'),
    requireApproval: discord.requireApproval !== false
  };
}

function ready() {
  const s = settings();
  if (!s.enabled) return { ok: false, reason: 'вход через Discord выключен в настройках' };
  if (!s.clientId || !s.clientSecret) return { ok: false, reason: 'не заданы Client ID и Client Secret приложения Discord' };
  if (!s.redirectUri) return { ok: false, reason: 'не задан Redirect URI (тот же адрес нужно вписать в настройках приложения Discord)' };
  return { ok: true };
}

/** Адрес, куда отправить браузер. */
function startUrl() {
  const s = settings();
  const check = ready();
  if (!check.ok) throw new Error(check.reason);

  const state = crypto.randomBytes(16).toString('base64url');
  pending.set(state, Date.now());

  // Заодно убираем просроченные: карта не должна расти бесконечно.
  for (const [key, at] of pending) {
    if (Date.now() - at > STATE_TTL_MS) pending.delete(key);
  }

  const params = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: s.redirectUri,
    response_type: 'code',
    scope: 'identify',
    state
  });

  return `${AUTHORIZE}?${params.toString()}`;
}

function checkState(state) {
  const at = pending.get(String(state || ''));
  if (!at) return false;

  pending.delete(String(state));
  return Date.now() - at <= STATE_TTL_MS;
}

/* ------------------------------------------------------------------- запросы */

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: options.method || 'GET', headers: options.headers || {}, timeout: 15_000 },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (_) {
            data = null;
          }

          if ((res.statusCode || 0) >= 400) {
            const message = (data && (data.error_description || data.message || data.error)) || `ответ ${res.statusCode}`;
            return reject(new Error(`Discord: ${message}`));
          }
          resolve(data);
        });
        res.on('error', reject);
      }
    );

    req.on('timeout', () => req.destroy(new Error('Discord не ответил за 15 с')));
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

/** Код -> токен -> профиль пользователя Discord. */
async function profileByCode(code) {
  const s = settings();

  const form = new URLSearchParams({
    client_id: s.clientId,
    client_secret: s.clientSecret,
    grant_type: 'authorization_code',
    code: String(code || ''),
    redirect_uri: s.redirectUri
  }).toString();

  const token = await request(
    `${API}/oauth2/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form)
      }
    },
    form
  );

  if (!token || !token.access_token) throw new Error('Discord не выдал токен доступа');

  const me = await request(`${API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!me || !me.id) throw new Error('Discord не сообщил, кто вошёл');

  const tag = me.discriminator && me.discriminator !== '0' ? `${me.username}#${me.discriminator}` : me.username;
  return { id: String(me.id), tag: String(tag || me.id), name: String(me.global_name || me.username || me.id) };
}

/**
 * Найти или создать аккаунт панели по профилю Discord.
 * @returns {{user: object, created: boolean}}
 */
function linkAccount(profile) {
  const s = settings();
  const existing = users.byDiscord(profile.id);

  if (existing) {
    if (existing.disabled) throw new Error('аккаунт отключён — обратитесь к владельцу панели');
    return { user: existing, created: false };
  }

  if (!s.allowRegistration) {
    throw new Error('вход через Discord разрешён только тем, кого уже добавили в панель');
  }

  // Новичок ждёт подтверждения: иначе любой, кто узнал адрес панели, сразу
  // получил бы доступ к серверу.
  const created = users.create({
    discordId: profile.id,
    discordTag: profile.tag,
    name: profile.name,
    roleId: s.defaultRoleId,
    disabled: s.requireApproval
  });

  logger.info(SOURCE, `Через Discord зарегистрирован «${profile.tag}»${s.requireApproval ? ' (ждёт подтверждения)' : ''}`);

  const user = users.byId(created.id);
  if (user.disabled) throw new Error('аккаунт создан и ждёт подтверждения владельцем панели');

  return { user, created: true };
}

/** Что показать в настройках: без секрета. */
function status() {
  const s = settings();
  const check = ready();

  return {
    enabled: s.enabled,
    clientId: s.clientId,
    hasSecret: Boolean(s.clientSecret),
    redirectUri: s.redirectUri,
    allowRegistration: s.allowRegistration,
    requireApproval: s.requireApproval,
    defaultRoleId: s.defaultRoleId,
    ok: check.ok,
    reason: check.reason || ''
  };
}

module.exports = { settings, ready, status, startUrl, checkState, profileByCode, linkAccount };
