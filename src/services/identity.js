'use strict';

/**
 * Верификация игрока: доказанная связка Discord ↔ Steam и автоматическая
 * прописка в файлы сервера.
 *
 * Как это работает и почему именно так:
 *
 *   1. Игрок жмёт кнопку в Discord. Бот просит у панели одноразовую ссылку
 *      (`start`) и отправляет её **лично** этому игроку (ephemeral или в ЛС).
 *      Уже этим доказан Discord-аккаунт: ссылку получил ровно тот, кто нажал.
 *      Поэтому отдельного входа через Discord на странице нет — он бы ничего не
 *      добавил, зато добавил бы шаг, на котором люди отваливаются.
 *   2. Игрок открывает ссылку и входит через Steam (OpenID). Владение
 *      Steam-аккаунтом подтверждает сам Steam, а не поле ввода, — подделать
 *      steamId64 нельзя.
 *   3. Панель пишет связку и **сразу ставит прописку в очередь** (services/roster).
 *      Именно поэтому «пришёл, а его не прописало» больше не случается: запись
 *      не зависит ни от бота, ни от того, свободен ли файл.
 *   4. Бот узнаёт результат (`status`, `pending`) и выдаёт роль.
 *
 * Хранение: MySQL, если база включена, иначе файл data/identity.json. Панель
 * обязана работать без базы, поэтому оба пути равноправны, а не «файл как
 * заглушка».
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('./../config');
const logger = require('./../logger');
const db = require('./../db');
const bus = require('./../events');
const roster = require('./roster');
const eventlog = require('./eventlog');

const SOURCE = 'verify';

const FILE = path.join(__dirname, '..', '..', 'data', 'identity.json');

/** Сколько живёт ссылка. Больше — опаснее, меньше — люди не успевают. */
const TTL_MS = 15 * 60 * 1000;

/** Незавершённые верификации в памяти — на случай работы без базы. */
const sessions = new Map();

let sweeper = null;

/* ------------------------------------------------------------------ хранение */

function useDb() {
  return config.load().panel.database.enabled;
}

function readFileStore() {
  try {
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(stored.links) ? stored.links : [];
  } catch (_) {
    return [];
  }
}

function writeFileStore(links) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ links }, null, 2), 'utf8');
}

/** Найти связку по Discord или по Steam. */
async function find({ discordId, steamId }) {
  const wantedDiscord = String(discordId || '');
  const wantedSteam = String(steamId || '');

  if (useDb()) {
    const row = wantedDiscord
      ? await db.one('SELECT * FROM panel_identity WHERE discord_id = :id', { id: wantedDiscord })
      : await db.one('SELECT * FROM panel_identity WHERE steam_id = :id', { id: wantedSteam });

    if (!row) return null;
    return {
      discordId: row.discord_id,
      steamId: row.steam_id,
      nickname: row.nickname || '',
      discordTag: row.discord_tag || '',
      verifiedAt: row.verified_at ? new Date(row.verified_at).getTime() : 0,
      source: row.source || ''
    };
  }

  return readFileStore().find((link) =>
    wantedDiscord ? link.discordId === wantedDiscord : link.steamId === wantedSteam
  ) || null;
}

/**
 * Записать связку.
 *
 * Один Steam — один Discord и наоборот: иначе двое «делят» аккаунт, и потом не
 * понять, кого прописали. Старая запись заменяется, о замене остаётся отметка в
 * журнале.
 */
async function saveLink(link) {
  if (useDb()) {
    await db.ensureSchema();
    // Чужая связка с этим Steam мешает уникальному ключу — снимаем её осознанно.
    await db.query('DELETE FROM panel_identity WHERE steam_id = :steam AND discord_id <> :discord', {
      steam: link.steamId,
      discord: link.discordId
    });
    await db.query(
      `INSERT INTO panel_identity (discord_id, steam_id, nickname, discord_tag, verified_at, source, note)
            VALUES (:discord, :steam, :nick, :tag, NOW(), :source, NULL)
       ON DUPLICATE KEY UPDATE steam_id = :steam, nickname = :nick, discord_tag = :tag,
            verified_at = NOW(), source = :source`,
      { discord: link.discordId, steam: link.steamId, nick: link.nickname || null, tag: link.discordTag || null, source: link.source }
    );
    return;
  }

  const links = readFileStore().filter((item) => item.discordId !== link.discordId && item.steamId !== link.steamId);
  links.push({ ...link, verifiedAt: Date.now() });
  writeFileStore(links);
}

/* -------------------------------------------------------------------- сессии */

function baseUrl(req) {
  const cfg = config.load();
  const scheme = cfg.panel.tls && cfg.panel.tls.enabled ? 'https' : 'http';
  const host = (req && req.headers && req.headers.host) || `127.0.0.1:${cfg.panel.port}`;

  return `${scheme}://${host}`;
}

/**
 * Начать верификацию. Возвращает одноразовую ссылку для игрока.
 *
 * Ссылку нельзя показывать в общем канале: кто угодно открыл бы её и привязал
 * свой Steam к чужому Discord. Бот отправляет её ephemeral — об этом сказано в
 * docs/integration-prompt.md.
 */
function start({ discordId, discordTag, guildId, serverId, group } = {}, req) {
  const id = String(discordId || '').trim();
  if (!/^\d{5,32}$/.test(id)) throw new Error('нужен discordId');

  // Прежняя незавершённая попытка того же игрока больше не нужна: иначе у него
  // на руках две ссылки и непонятно, какая сработает.
  for (const [token, item] of sessions) if (item.discordId === id) sessions.delete(token);

  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();

  sessions.set(token, {
    token,
    discordId: id,
    discordTag: String(discordTag || '').slice(0, 64),
    guildId: String(guildId || ''),
    serverId: serverId ? String(serverId) : (config.activeServer() || {}).id || '',
    group: String(group || ''),
    stage: 'wait-steam',
    createdAt: now,
    expiresAt: now + TTL_MS,
    steamId: '',
    error: ''
  });

  logger.info(SOURCE, `Начата верификация Discord ${id}${discordTag ? ` (${discordTag})` : ''}`);

  return {
    token,
    url: `${baseUrl(req)}/verify.html?token=${encodeURIComponent(token)}`,
    expiresAt: now + TTL_MS,
    ttlSeconds: Math.round(TTL_MS / 1000)
  };
}

/** Сессия по токену — с внятной причиной, если она не годится. */
function sessionOf(token) {
  const item = sessions.get(String(token || ''));
  if (!item) return { ok: false, reason: 'Ссылка не найдена. Нажмите кнопку верификации в Discord заново' };
  if (item.expiresAt < Date.now()) {
    sessions.delete(item.token);
    return { ok: false, reason: 'Ссылка устарела (она живёт 15 минут). Нажмите кнопку в Discord заново' };
  }
  return { ok: true, session: item };
}

/** Что показать на странице верификации. */
function pageState(token) {
  const check = sessionOf(token);
  if (!check.ok) return { ok: false, reason: check.reason };

  const s = check.session;
  return {
    ok: true,
    stage: s.stage,
    discordTag: s.discordTag,
    steamId: s.steamId,
    secondsLeft: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000))
  };
}

/* --------------------------------------------------------------- завершение */

/**
 * Steam подтвердил вход: пишем связку и ставим прописку в очередь.
 *
 * Прописка идёт через services/roster именно потому, что она обязана
 * состояться: очередь на диске, повторы, идемпотентность.
 */
async function completeSteam(token, steamId, nickname) {
  const check = sessionOf(token);
  if (!check.ok) throw new Error(check.reason);

  const s = check.session;
  const previous = await find({ steamId });

  await saveLink({
    discordId: s.discordId,
    steamId,
    nickname: String(nickname || '').slice(0, 64),
    discordTag: s.discordTag,
    source: 'steam-openid'
  });

  s.stage = 'done';
  s.steamId = steamId;
  s.nickname = String(nickname || '');

  let queued = null;
  let rosterError = '';
  try {
    queued = roster.enqueue(s.serverId, {
      steamId,
      name: nickname || s.discordTag,
      discordId: s.discordId,
      group: s.group
    });
  } catch (err) {
    // Прописка не настроена — верификация всё равно состоялась, и об этом надо
    // сказать прямо, а не молча «всё хорошо».
    rosterError = err.message;
    logger.warn(SOURCE, `Связка записана, но прописка не поставлена: ${err.message}`);
  }

  logger.info(SOURCE, `Верифицирован: Discord ${s.discordId} ↔ Steam ${steamId}`);

  try {
    eventlog.append(s.serverId, [
      {
        ts: Date.now(),
        type: 'admin',
        player: { id: steamId, name: nickname || '' },
        data: {
          source: 'verify',
          action: 'верификация',
          phrase: `Discord ${s.discordTag || s.discordId} подтвердил Steam${previous && previous.discordId !== s.discordId ? ' (перепривязка)' : ''}`,
          discordId: s.discordId
        }
      }
    ]);
  } catch (_) {
    /* журнал не должен ломать верификацию */
  }

  // Боту не нужно опрашивать панель, если он слушает поток событий.
  bus.emit('verify', { discordId: s.discordId, steamId, nickname: nickname || '', guildId: s.guildId, queued: Boolean(queued) });

  return {
    ok: true,
    discordId: s.discordId,
    steamId,
    nickname: nickname || '',
    queued: Boolean(queued),
    rosterError,
    replaced: previous && previous.discordId !== s.discordId ? previous.discordId : ''
  };
}

/** Верифицирован ли этот игрок. Бот спрашивает это перед выдачей роли. */
async function status({ discordId, steamId }) {
  const link = await find({ discordId, steamId });
  if (!link) return { verified: false, reason: 'связка не найдена — игрок ещё не проходил верификацию' };

  // Связка не привязана к серверу — прописку проверяем по выбранному сейчас.
  const active = config.activeServer();
  const targets = active ? roster.check(active.id, link.steamId) : [];
  return { verified: true, ...link, roster: targets };
}

/** Кого верифицировали, но бот ещё не обработал — на случай, если он падал. */
function pendingSessions() {
  return [...sessions.values()]
    .filter((s) => s.stage === 'done')
    .map((s) => ({
      discordId: s.discordId,
      steamId: s.steamId,
      guildId: s.guildId,
      discordTag: s.discordTag,
      nickname: s.nickname || ''
    }));
}

/** Бот подтвердил, что роль выдана — сессию можно забыть. */
function acknowledge(discordId) {
  let removed = 0;
  for (const [token, item] of sessions) {
    if (item.discordId === String(discordId) && item.stage === 'done') {
      sessions.delete(token);
      removed++;
    }
  }
  return { removed };
}

/** Ручная связка админом — бывает нужно, когда у человека нет Steam-логина. */
async function link({ discordId, steamId, nickname, actor }) {
  const id = String(discordId || '').trim();
  const steam = String(steamId || '').trim();
  if (!/^\d{5,32}$/.test(id)) throw new Error('нужен discordId');
  if (!/^\d{17}$/.test(steam)) throw new Error('нужен steamId64 из 17 цифр');

  await saveLink({ discordId: id, steamId: steam, nickname: String(nickname || ''), discordTag: '', source: 'manual' });
  logger.info(SOURCE, `Связка вручную: Discord ${id} ↔ Steam ${steam}${actor ? ` (${actor})` : ''}`);

  const queued = roster.enqueue((config.activeServer() || {}).id, { steamId: steam, name: nickname, discordId: id });
  return { ok: true, discordId: id, steamId: steam, queued: Boolean(queued) };
}

/** Снять связку. */
async function unlink(discordId) {
  const id = String(discordId || '').trim();

  if (useDb()) {
    await db.query('DELETE FROM panel_identity WHERE discord_id = :id', { id });
  } else {
    writeFileStore(readFileStore().filter((item) => item.discordId !== id));
  }

  logger.info(SOURCE, `Связка снята: Discord ${id}`);
  return { ok: true };
}

/** Все связки — для сайта и для проверки глазами. */
async function all(limit = 500) {
  if (useDb()) {
    // LIMIT подставляется числом, а не параметром: подготовленные запросы
    // MySQL принимают его не во всех версиях, а значение здесь наше, не чужое.
    const n = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const rows = await db.query(`SELECT * FROM panel_identity ORDER BY verified_at DESC LIMIT ${n}`);
    return rows.map((row) => ({
      discordId: row.discord_id,
      steamId: row.steam_id,
      nickname: row.nickname || '',
      discordTag: row.discord_tag || '',
      verifiedAt: row.verified_at ? new Date(row.verified_at).getTime() : 0,
      source: row.source || ''
    }));
  }

  return readFileStore().slice(-Number(limit) || -500).reverse();
}

function start_() {
  if (sweeper) return;
  // Просроченные ссылки не должны копиться в памяти.
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [token, item] of sessions) if (item.expiresAt < now && item.stage !== 'done') sessions.delete(token);
  }, 60000);
  if (sweeper.unref) sweeper.unref();
}

function stop() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

module.exports = {
  TTL_MS,
  start: start_,
  stop,
  begin: start,
  sessionOf,
  pageState,
  completeSteam,
  status,
  pendingSessions,
  acknowledge,
  link,
  unlink,
  all,
  useDb
};
