'use strict';

/**
 * Аккаунты, роли и права доступа.
 *
 * Мастер-ключи годились, пока панелью пользовался один человек: они одинаковы
 * для всех и дают всё сразу. Здесь — обычные учётные записи с паролем или входом
 * через Discord, роли и права по каждой возможности панели. Владелец решает, кто
 * что видит: одному только журнал, другому карта и просмотр инвентаря, третьему
 * ещё и правка.
 *
 * Хранилище — data/users.json, отдельно от config/config.json: конфиг человек
 * правит руками, а хеши паролей туда попадать не должны.
 *
 * Пароли — scrypt из стандартной библиотеки Node (соль на пользователя,
 * сравнение через timingSafeEqual). Никаких сторонних зависимостей в проекте
 * нет и здесь тоже не появляется.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logger = require('../logger');

const SOURCE = 'users';

const FILE = path.join(__dirname, '..', '..', 'data', 'users.json');

/* --------------------------------------------------------------------- права */

/**
 * Каталог прав. Ключ — что проверяет код, значение — как назвать это человеку.
 *
 * Разбито мелко осознанно: «видеть карту» и «править инвентарь» — разные
 * обязанности, и выдавать их вместе незачем.
 */
const PERMISSIONS = {
  'panel.view': 'Входить в панель',

  'server.view': 'Видеть состояние сервера',
  'server.control': 'Запускать, останавливать, перезапускать сервер',

  'map.view': 'Смотреть карту и игроков онлайн',
  'map.trails': 'Смотреть трассы перемещений',
  'map.spawn': 'Спавнить объекты и телепортировать с карты',

  'players.view': 'Смотреть карточку игрока: здоровье, голод, координаты',
  'players.actions': 'Действия по игроку: лечить, кормить, сообщение, кик',

  'inventory.view': 'Смотреть инвентарь игрока',
  'inventory.edit': 'Править инвентарь: выдавать, удалять, менять вещи',

  'events.view': 'Журнал событий и действий админов',
  'logs.view': 'Лог самой панели и консоль',

  'mods.view': 'Видеть список модов',
  'mods.manage': 'Ставить, обновлять и удалять моды',

  'files.read': 'Читать файлы папки profiles',
  'files.write': 'Изменять файлы папки profiles',

  'ingame.say': 'Писать игрокам в игру и вести объявления',

  'settings.view': 'Смотреть настройки панели и сервера',
  'settings.manage': 'Менять настройки, карту, порты, брандмауэр',

  'trader.view': 'Смотреть торговцев, категории и цены',
  'trader.manage': 'Править категории, товары и цены торговцев',

  'tickets.view': 'Читать обращения игроков и переписку по ним',
  'tickets.manage': 'Настраивать формы обращений, брать и закрывать их',

  'users.manage': 'Управлять аккаунтами и правами',
  'tokens.manage': 'Выпускать API-токены для интеграций'
};

const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

/** Право «всё сразу» — только у владельца. */
const ALL = '*';

/**
 * Роли по умолчанию. Их можно менять и добавлять свои; удалить владельца нельзя.
 *
 * Набраны под то, как обычно устроена команда сервера: владелец, администратор,
 * модератор с правкой инвентаря, «смотрящий» без правок и человек только для
 * разбора логов.
 */
const DEFAULT_ROLES = [
  { id: 'owner', name: 'Владелец', permissions: [ALL], builtin: true },
  {
    id: 'admin',
    name: 'Администратор',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'users.manage'),
    builtin: true
  },
  {
    id: 'moderator',
    name: 'Модератор',
    permissions: [
      'panel.view',
      'server.view',
      'map.view',
      'map.trails',
      'players.view',
      'players.actions',
      'inventory.view',
      'inventory.edit',
      'events.view',
      'ingame.say',
      'tickets.view',
      'tickets.manage',
      'trader.view'
    ],
    builtin: true
  },
  {
    id: 'watcher',
    name: 'Наблюдатель',
    permissions: ['panel.view', 'server.view', 'map.view', 'players.view', 'inventory.view', 'events.view'],
    builtin: true
  },
  { id: 'logs', name: 'Только логи', permissions: ['panel.view', 'events.view', 'logs.view'], builtin: true }
];

/* ------------------------------------------------------------------ хранилище */

let state = null;

function blank() {
  return { v: 1, users: [], roles: DEFAULT_ROLES.map((role) => ({ ...role })) };
}

function load() {
  if (state) return state;

  try {
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = normalize(stored);
  } catch (_) {
    state = blank();
  }
  return state;
}

function normalize(stored) {
  const data = stored && typeof stored === 'object' ? stored : {};
  const roles = Array.isArray(data.roles) ? data.roles : [];

  // Встроенные роли всегда на месте: если файл правили руками и удалили роль,
  // пользователи с ней не должны остаться вообще без прав.
  const byId = new Map(roles.filter((r) => r && r.id).map((r) => [String(r.id), r]));
  for (const role of DEFAULT_ROLES) {
    if (!byId.has(role.id)) byId.set(role.id, { ...role });
  }

  return {
    v: 1,
    roles: [...byId.values()].map((role) => ({
      id: String(role.id),
      name: String(role.name || role.id),
      permissions: Array.isArray(role.permissions) ? role.permissions.filter((p) => p === ALL || PERMISSIONS[p]) : [],
      builtin: Boolean(DEFAULT_ROLES.find((r) => r.id === role.id))
    })),
    users: (Array.isArray(data.users) ? data.users : [])
      .map((user) => ({
        id: String(user.id || ''),
        login: String(user.login || '').toLowerCase(),
        name: String(user.name || user.login || 'без имени').slice(0, 60),
        password: String(user.password || ''),
        discordId: String(user.discordId || ''),
        discordTag: String(user.discordTag || ''),
        roleId: String(user.roleId || 'watcher'),
        grant: Array.isArray(user.grant) ? user.grant.filter((p) => PERMISSIONS[p]) : [],
        deny: Array.isArray(user.deny) ? user.deny.filter((p) => PERMISSIONS[p]) : [],
        disabled: Boolean(user.disabled),
        createdAt: Number(user.createdAt) || Date.now(),
        lastLoginAt: Number(user.lastLoginAt) || 0
      }))
      .filter((user) => user.id && (user.login || user.discordId))
  };
}

function save() {
  const data = load();
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.error(SOURCE, `Не удалось сохранить аккаунты: ${err.message}`);
    throw new Error('не удалось сохранить список аккаунтов');
  }
  return data;
}

/** Есть ли вообще аккаунты: пока нет — панель в режиме первичной настройки. */
const isEmpty = () => load().users.length === 0;

const count = () => load().users.length;

/* --------------------------------------------------------------------- пароли */

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p
  });

  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, salt, expected] = parts;
  const expectedKey = Buffer.from(expected, 'base64');

  let key;
  try {
    key = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expectedKey.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p)
    });
  } catch (_) {
    return false;
  }

  return key.length === expectedKey.length && crypto.timingSafeEqual(key, expectedKey);
}

/* ---------------------------------------------------------------------- поиск */

const byId = (id) => load().users.find((user) => user.id === String(id)) || null;
const byLogin = (login) => load().users.find((user) => user.login === String(login || '').toLowerCase()) || null;
const byDiscord = (discordId) => load().users.find((user) => user.discordId === String(discordId || '')) || null;

function roleOf(user) {
  const data = load();
  return data.roles.find((role) => role.id === (user ? user.roleId : '')) || null;
}

/**
 * Итоговые права пользователя: права роли, плюс личные добавки, минус личные
 * запреты. Запрет сильнее выдачи — так проще отобрать одну возможность, не
 * перебирая роль.
 */
function permissionsOf(user) {
  if (!user) return [];

  const role = roleOf(user);
  const rolePermissions = role ? role.permissions : [];
  if (rolePermissions.includes(ALL)) return [ALL];

  const result = new Set(rolePermissions);
  for (const permission of user.grant) result.add(permission);
  for (const permission of user.deny) result.delete(permission);

  return [...result];
}

function can(user, permission) {
  if (!user || user.disabled) return false;

  const list = permissionsOf(user);
  return list.includes(ALL) || list.includes(permission);
}

/* -------------------------------------------------------------------- правки */

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function validateLogin(login) {
  const value = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(value)) {
    throw new Error('логин: 3–32 знака, латиница, цифры, точка, дефис или подчёркивание');
  }
  return value;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new Error('пароль короче 8 знаков');
  if (value.length > 200) throw new Error('пароль длиннее 200 знаков');
  return value;
}

/**
 * Создать аккаунт.
 * @param {object} data login, password, name, roleId, discordId, discordTag, disabled
 */
function create(data = {}) {
  const store = load();
  const login = data.login ? validateLogin(data.login) : '';
  const discordId = String(data.discordId || '').trim();

  if (!login && !discordId) throw new Error('нужен логин или аккаунт Discord');
  if (login && byLogin(login)) throw new Error(`логин «${login}» уже занят`);
  if (discordId && byDiscord(discordId)) throw new Error('этот аккаунт Discord уже привязан');

  const roleId = String(data.roleId || 'watcher');
  if (!store.roles.find((role) => role.id === roleId)) throw new Error(`роли «${roleId}» нет`);

  // Первый аккаунт всегда владелец: иначе панель осталась бы без хозяина.
  const first = store.users.length === 0;

  const user = {
    id: newId(),
    login,
    name: String(data.name || login || data.discordTag || 'без имени').slice(0, 60),
    password: data.password ? hashPassword(validatePassword(data.password)) : '',
    discordId,
    discordTag: String(data.discordTag || ''),
    roleId: first ? 'owner' : roleId,
    grant: [],
    deny: [],
    disabled: first ? false : Boolean(data.disabled),
    createdAt: Date.now(),
    lastLoginAt: 0
  };

  store.users.push(user);
  save();

  logger.info(SOURCE, `Создан аккаунт «${user.name}» (${user.login || user.discordTag}), роль ${user.roleId}`);
  return publicUser(user);
}

function update(id, patch = {}) {
  const store = load();
  const user = byId(id);
  if (!user) throw new Error('аккаунт не найден');

  if (patch.name !== undefined) user.name = String(patch.name).slice(0, 60);

  if (patch.roleId !== undefined) {
    const roleId = String(patch.roleId);
    if (!store.roles.find((role) => role.id === roleId)) throw new Error(`роли «${roleId}» нет`);

    // Последнего владельца не разжаловываем: панель осталась бы без управления.
    if (user.roleId === 'owner' && roleId !== 'owner' && owners().length < 2) {
      throw new Error('это последний владелец — сначала назначьте другого');
    }
    user.roleId = roleId;
  }

  if (patch.password) user.password = hashPassword(validatePassword(patch.password));
  if (patch.login !== undefined && patch.login !== user.login) {
    const login = validateLogin(patch.login);
    if (byLogin(login)) throw new Error(`логин «${login}» уже занят`);
    user.login = login;
  }

  if (patch.disabled !== undefined) {
    if (user.roleId === 'owner' && patch.disabled && owners().length < 2) {
      throw new Error('это последний владелец — его нельзя отключить');
    }
    user.disabled = Boolean(patch.disabled);
  }

  if (Array.isArray(patch.grant)) user.grant = patch.grant.filter((p) => PERMISSIONS[p]);
  if (Array.isArray(patch.deny)) user.deny = patch.deny.filter((p) => PERMISSIONS[p]);

  if (patch.discordId !== undefined) {
    const discordId = String(patch.discordId).trim();
    const other = discordId ? byDiscord(discordId) : null;
    if (other && other.id !== user.id) throw new Error('этот аккаунт Discord уже привязан');
    user.discordId = discordId;
  }

  save();
  logger.info(SOURCE, `Аккаунт «${user.name}» изменён`);
  return publicUser(user);
}

function remove(id) {
  const store = load();
  const user = byId(id);
  if (!user) throw new Error('аккаунт не найден');
  if (user.roleId === 'owner' && owners().length < 2) throw new Error('это последний владелец — его нельзя удалить');

  store.users = store.users.filter((item) => item.id !== user.id);
  save();

  logger.info(SOURCE, `Аккаунт «${user.name}» удалён`);
  return { removed: true };
}

const owners = () => load().users.filter((user) => user.roleId === 'owner' && !user.disabled);

function touchLogin(id) {
  const user = byId(id);
  if (!user) return;

  user.lastLoginAt = Date.now();
  try {
    save();
  } catch (_) {
    /* не критично: время входа — не повод ронять вход */
  }
}

/* ---------------------------------------------------------------------- роли */

function saveRole(data = {}) {
  const store = load();
  const id = String(data.id || '')
    .trim()
    .toLowerCase();

  if (!/^[a-z0-9_-]{2,32}$/.test(id)) throw new Error('id роли: 2–32 знака, латиница, цифры, дефис');

  const permissions = (Array.isArray(data.permissions) ? data.permissions : []).filter(
    (p) => p === ALL || PERMISSIONS[p]
  );

  const existing = store.roles.find((role) => role.id === id);
  if (existing) {
    // У встроенных роль-имя не меняем: по нему их узнают в интерфейсе.
    if (!existing.builtin && data.name) existing.name = String(data.name).slice(0, 40);
    existing.permissions = permissions;
  } else {
    store.roles.push({ id, name: String(data.name || id).slice(0, 40), permissions, builtin: false });
  }

  save();
  return store.roles.find((role) => role.id === id);
}

function removeRole(id) {
  const store = load();
  const role = store.roles.find((item) => item.id === String(id));
  if (!role) throw new Error('роль не найдена');
  if (role.builtin) throw new Error('встроенную роль удалить нельзя');

  const used = store.users.filter((user) => user.roleId === role.id);
  if (used.length) throw new Error(`роль занята: ${used.length} аккаунт(ов). Сначала переведите их на другую роль`);

  store.roles = store.roles.filter((item) => item.id !== role.id);
  save();
  return { removed: true };
}

/* ------------------------------------------------------------------- наружу */

/** Пользователь для интерфейса: без хеша пароля. */
function publicUser(user) {
  if (!user) return null;

  const role = roleOf(user);
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    roleId: user.roleId,
    roleName: role ? role.name : user.roleId,
    discordTag: user.discordTag,
    hasPassword: Boolean(user.password),
    hasDiscord: Boolean(user.discordId),
    disabled: user.disabled,
    grant: user.grant,
    deny: user.deny,
    permissions: permissionsOf(user),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  };
}

const list = () => load().users.map(publicUser);
const roles = () => load().roles.map((role) => ({ ...role }));

/**
 * Проверить логин и пароль.
 * @returns {{ok: boolean, user?: object, error?: string}}
 */
function verify(login, password) {
  const user = byLogin(login);

  // Пароль проверяем всегда, даже если пользователя нет: иначе по времени
  // ответа можно перебрать существующие логины.
  const stored = user ? user.password : hashPassword(crypto.randomBytes(16).toString('hex'));
  const ok = checkPassword(password, stored);

  if (!user || !ok) return { ok: false, error: 'неверный логин или пароль' };
  if (!user.password) return { ok: false, error: 'у этого аккаунта нет пароля — входите через Discord' };
  if (user.disabled) return { ok: false, error: 'аккаунт отключён — обратитесь к владельцу панели' };

  return { ok: true, user };
}

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  ALL,
  DEFAULT_ROLES,
  FILE,
  load,
  save,
  isEmpty,
  count,
  list,
  roles,
  saveRole,
  removeRole,
  create,
  update,
  remove,
  byId,
  byLogin,
  byDiscord,
  can,
  permissionsOf,
  publicUser,
  verify,
  touchLogin,
  hashPassword,
  checkPassword
};
