'use strict';

/**
 * Мастер настройки, доступный только с самой машины панели.
 *
 * Зачем отдельный экран, если есть «Настройки»: там настройки разложены по
 * смыслу и рассчитаны на человека, который уже знает панель. Здесь наоборот —
 * один список шагов сверху вниз, в конце каждого написано, готов шаг или нет и
 * что именно мешает. Владелец запускает панель и настраивает всё в одном месте,
 * включая то, что раньше приходилось править руками в config.json (Discord,
 * база, прописка).
 *
 * Доступ только с localhost и это принципиально: страница показывает и меняет
 * секреты (пароль Steam, секрет Discord, токен бота), поэтому она не должна
 * открываться снаружи даже владельцу — снаружи для этого есть обычные
 * «Настройки» с правами и входом.
 *
 * Значения секретов наружу не отдаются никогда, даже на localhost: в ответе
 * приходит только признак «задано». Пустая строка при сохранении секрет не
 * стирает — для этого есть отдельная галочка «очистить».
 */

const config = require('./../config');
const db = require('./../db');
const users = require('./users');
const discord = require('./discord');
const bridge = require('./bridge');
const maptiles = require('./maptiles');
const roster = require('./roster');

/** Ключ секции конфига -> куда писать: корень или активный сервер. */
const SERVER_SECTIONS = new Set(['server', 'restart', 'ingame', 'announcements', 'features', 'roster', 'paths', 'cftools', 'mods']);

/** Секции, которые в конфиге есть и у корня, и у сервера. Пишем в сервер. */
const BOTH_SECTIONS = new Set(['paths', 'cftools']);

/**
 * Описание всех полей мастера.
 *
 * Страница рисуется по этому описанию, поэтому новое поле достаточно добавить
 * здесь — HTML менять не нужно. `path` — путь в конфиге, ровно тот, что в
 * config.json.
 */
const STEPS = [
  {
    id: 'panel',
    title: 'Панель',
    hint: 'Адрес и порт, по которым открывается сама панель.',
    fields: [
      { path: 'panel.host', label: 'Адрес прослушивания', type: 'text',
        hint: '127.0.0.1 — только эта машина, 0.0.0.0 — доступна по сети' },
      { path: 'panel.port', label: 'Порт', type: 'number' },
      { path: 'panel.logBufferLines', label: 'Строк лога в памяти', type: 'number' },
      { path: 'panel.tls.enabled', label: 'HTTPS (свой сертификат)', type: 'bool' },
      { path: 'panel.tls.certFile', label: 'Файл сертификата', type: 'text' },
      { path: 'panel.tls.keyFile', label: 'Файл ключа', type: 'text' }
    ]
  },
  {
    id: 'steam',
    title: 'SteamCMD',
    hint: 'Нужен, чтобы панель сама ставила сервер и моды из Workshop.',
    fields: [
      { path: 'paths.steamcmdExe', label: 'Путь к steamcmd.exe', type: 'text' },
      { path: 'steam.username', label: 'Логин Steam', type: 'text',
        hint: 'Аккаунт, у которого есть DayZ — иначе моды не скачаются' },
      { path: 'steam.password', label: 'Пароль Steam', type: 'secret' },
      { path: 'steam.anonymous', label: 'Анонимно (только файлы сервера)', type: 'bool' },
      { path: 'steam.webApiKey', label: 'Steam Web API Key', type: 'secret',
        hint: 'steamcommunity.com/dev/apikey — нужен для проверки Steam-аккаунта игрока' },
      { path: 'steam.downloadRetries', label: 'Повторов загрузки', type: 'number' },
      { path: 'steam.downloadTimeoutMinutes', label: 'Таймаут загрузки, мин', type: 'number' }
    ]
  },
  {
    id: 'server',
    title: 'Сервер DayZ',
    hint: 'Папка сервера, порты и основные настройки. Сервер должен быть создан в панели.',
    needsServer: true,
    fields: [
      { path: 'paths.serverPath', label: 'Папка сервера', type: 'text' },
      { path: 'paths.serverExe', label: 'Файл запуска', type: 'text' },
      { path: 'paths.profilesFolder', label: 'Папка профиля', type: 'text' },
      { path: 'server.name', label: 'Название в списке серверов', type: 'text' },
      { path: 'server.password', label: 'Пароль входа', type: 'secret' },
      { path: 'server.adminPassword', label: 'Пароль админа', type: 'secret' },
      { path: 'server.maxPlayers', label: 'Слотов', type: 'number' },
      { path: 'server.gamePort', label: 'Игровой порт', type: 'number' },
      { path: 'server.steamQueryPort', label: 'Порт запросов Steam', type: 'number' },
      { path: 'server.mission', label: 'Миссия (карта)', type: 'text' }
    ]
  },
  {
    id: 'ingame',
    title: 'Сообщения в игру',
    hint: 'Предупреждения о перезапуске и объявления. Через BattlEye RCon сервера.',
    needsServer: true,
    fields: [
      { path: 'ingame.channel', label: 'Канал', type: 'select',
        options: [['auto', 'Автоматически'], ['battleye', 'BattlEye RCon'], ['cftools', 'CFTools'], ['off', 'Не писать']] },
      { path: 'ingame.battleye.host', label: 'Адрес RCon', type: 'text' },
      { path: 'ingame.battleye.port', label: 'Порт RCon (0 — взять из файла сервера)', type: 'number' },
      { path: 'ingame.battleye.password', label: 'Пароль RCon', type: 'secret' },
      { path: 'announcements.enabled', label: 'Периодические объявления', type: 'bool' },
      { path: 'announcements.intervalMinutes', label: 'Раз в сколько минут', type: 'number' }
    ]
  },
  {
    id: 'map',
    title: 'Карта',
    hint: 'Подложка интерактивной карты. Свою картинку загружают на вкладке «Настройки» — там есть нарезка.',
    fields: [
      { path: 'panel.map.tiles.enabled', label: 'Показывать подложку', type: 'bool' },
      { path: 'panel.map.tiles.layer', label: 'Слой', type: 'select',
        options: [['topographic', 'Карта'], ['satellite', 'Спутник']] },
      { path: 'panel.map.tiles.urlTemplate', label: 'Свой источник тайлов', type: 'text',
        hint: 'Шаблон вида https://…/{z}/{x}/{y}.png — если задан, каталог карт панели не используется' }
    ]
  },
  {
    id: 'roster',
    title: 'Прописка игроков',
    hint: 'Куда бот и сайт записывают игрока после проверки. Относительные пути считаются от папки профиля.',
    needsServer: true,
    fields: [
      { path: 'roster.targets', label: 'Файлы для записи', type: 'roster' }
    ]
  },
  {
    id: 'discord',
    title: 'Discord',
    hint: 'Вход в панель через Discord и связь с ботом.',
    fields: [
      { path: 'panel.auth.discord.enabled', label: 'Вход через Discord', type: 'bool' },
      { path: 'panel.auth.discord.clientId', label: 'Client ID', type: 'text' },
      { path: 'panel.auth.discord.clientSecret', label: 'Client Secret', type: 'secret' },
      { path: 'panel.auth.discord.redirectUri', label: 'Redirect URI', type: 'text',
        hint: 'Ровно этот адрес добавьте в OAuth2 → Redirects приложения Discord' },
      { path: 'panel.auth.discord.allowRegistration', label: 'Разрешить новым входить', type: 'bool' },
      { path: 'panel.auth.discord.requireApproval', label: 'Новых подтверждает владелец', type: 'bool' },
      { path: 'panel.auth.discord.defaultRoleId', label: 'Роль новому', type: 'role' },
      { path: 'panel.discord.botToken', label: 'Токен бота', type: 'secret',
        hint: 'Bot → Reset Token. Нужен боту, панель его только хранит и отдаёт боту по API-токену' },
      { path: 'panel.discord.guildId', label: 'ID сервера Discord', type: 'text' },
      { path: 'panel.discord.verifiedRoleId', label: 'ID роли «проверен»', type: 'text' },
      { path: 'panel.discord.logChannelId', label: 'ID канала для журнала', type: 'text' }
    ]
  },
  {
    id: 'registration',
    title: 'Аккаунты панели',
    hint: 'Кто может заводить аккаунты в панели и с какими правами.',
    fields: [
      { path: 'panel.auth.registration.enabled', label: 'Разрешить регистрацию', type: 'bool' },
      { path: 'panel.auth.registration.requireApproval', label: 'Новых подтверждает владелец', type: 'bool' },
      { path: 'panel.auth.registration.defaultRoleId', label: 'Роль новому', type: 'role' },
      { path: 'panel.auth.sessionHours', label: 'Сколько часов держать вход', type: 'number' }
    ]
  },
  {
    id: 'database',
    title: 'Общая база (MySQL)',
    hint: 'Одна база на панель, сайт и бота. Без неё панель работает на файлах.',
    fields: [
      { path: 'panel.database.enabled', label: 'Использовать базу', type: 'bool' },
      { path: 'panel.database.host', label: 'Адрес', type: 'text' },
      { path: 'panel.database.port', label: 'Порт', type: 'number' },
      { path: 'panel.database.user', label: 'Пользователь', type: 'text' },
      { path: 'panel.database.password', label: 'Пароль', type: 'secret' },
      { path: 'panel.database.name', label: 'База', type: 'text' }
    ]
  },
  {
    id: 'cftools',
    title: 'CFTools Cloud',
    hint: 'Необязательно. Нужна платная подписка, поэтому по умолчанию выключено.',
    fields: [
      { path: 'cftools.enabled', label: 'Использовать CFTools', type: 'bool' },
      { path: 'cftools.applicationId', label: 'Application ID', type: 'text' },
      { path: 'cftools.secret', label: 'Secret', type: 'secret' },
      { path: 'cftools.serverApiId', label: 'Server API ID', type: 'text' }
    ]
  }
];

/* --------------------------------------------------------------- только свои */

/**
 * Запрос пришёл с этой же машины?
 *
 * Проверяется именно адрес соединения, а не заголовки: X-Forwarded-For подделать
 * может кто угодно, и через reverse-proxy мастер настройки открываться не должен.
 */
function isLocalRequest(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  const ip = raw.replace(/^::ffff:/, '');

  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

/** Ответ, когда мастер дёрнули снаружи. */
function refuse(res) {
  return res.status(403).json({
    error: 'Мастер настройки открывается только на самой машине панели: http://127.0.0.1:' +
      `${config.load().panel.port}/setup.html`,
    setup: 'local-only'
  });
}

/* ------------------------------------------------------- чтение и запись путей */

function getByPath(root, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), root);
}

function setByPath(root, dotted, value) {
  const keys = dotted.split('.');
  let node = root;

  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
  return root;
}

/** Куда пойдёт путь: в корень конфига или в настройки сервера. */
function scopeOf(dotted) {
  const head = dotted.split('.')[0];
  if (!SERVER_SECTIONS.has(head)) return 'root';

  // paths.steamcmdExe — общий для всех серверов, paths.serverPath — у сервера.
  if (BOTH_SECTIONS.has(head)) {
    const key = dotted.split('.')[1];
    if (head === 'paths') return ['steamcmdExe', 'workshopContentDir'].includes(key) ? 'root' : 'server';
    if (head === 'cftools') return ['enabled', 'applicationId', 'secret'].includes(key) ? 'root' : 'server';
  }
  return 'server';
}

/* -------------------------------------------------------------------- чтение */

function valueFor(field, root, serverView) {
  const source = scopeOf(field.path) === 'server' ? serverView : root;
  const value = getByPath(source, field.path);

  // Секрет наружу не уходит — только признак, что он задан.
  if (field.type === 'secret') return { set: Boolean(value), value: '' };
  if (field.type === 'roster') return { value: Array.isArray(value) ? value : [] };
  if (field.type === 'bool') return { value: Boolean(value) };

  return { value: value === undefined || value === null ? '' : value };
}

/**
 * Всё, что нужно странице: поля со значениями, роли, состояние шагов.
 */
function state() {
  const root = config.load();
  const server = config.hasServers() ? config.activeServer() : null;
  const serverView = server || {};

  const steps = STEPS.map((step) => ({
    id: step.id,
    title: step.title,
    hint: step.hint,
    blocked: step.needsServer && !server ? 'Сначала создайте сервер в панели («Мои серверы»)' : '',
    fields: step.fields.map((field) => ({
      ...field,
      scope: scopeOf(field.path),
      ...valueFor(field, root, serverView)
    }))
  }));

  return {
    local: true,
    configFile: config.CONFIG_FILE,
    node: process.version,
    platform: process.platform,
    server: server ? { id: server.id, name: server.name, installed: server.installed } : null,
    servers: config.servers().map((s) => ({ id: s.id, name: s.name })),
    roles: users.DEFAULT_ROLES.map((r) => ({ id: r.id, title: r.name })),
    steps,
    checklist: checklist(server)
  };
}

/**
 * Готовность по шагам: что уже работает, а что мешает.
 *
 * Каждый пункт — ok/warn/fail плюс человеческая причина. Владелец не должен
 * догадываться, почему «не работает карта»: здесь написано, что именно.
 */
function checklist(server) {
  const root = config.load();
  const items = [];
  const add = (id, title, ok, reason, hint) => items.push({ id, title, state: ok, reason: reason || '', hint: hint || '' });

  const major = Number(String(process.version).replace(/^v/, '').split('.')[0]);
  add('node', `Node.js ${process.version}`, major >= 18 ? 'ok' : 'fail',
    major >= 18 ? '' : 'нужен Node.js 18 или новее', 'nodejs.org');

  add('server', 'Сервер DayZ создан', server ? 'ok' : 'fail',
    server ? '' : 'ни одного сервера нет', 'Мои серверы → Создать сервер');

  if (server) {
    const v = config.active(server.id);
    add('files', 'Файлы сервера на месте', server.installed ? 'ok' : 'warn',
      server.installed ? '' : 'сервер не установлен — панель поставит его через SteamCMD');

    const b = bridge.status(server.id);
    add('bridge', 'Мод-мост на связи', b.online ? 'ok' : 'warn',
      b.online ? `версия мода ${b.modVersion || '?'}` : (b.reason || 'мод не прислал hello.json'),
      'Добавьте -serverMod=@DayZPanelBridge в строку запуска');

    const map = maptiles.status(b.world || v.server.mission);
    add('map', 'Подложка карты', map.tiles.hasSource || (map.image && map.image.exists) ? 'ok' : 'warn',
      map.reason || map.lastError || '', 'Настройки → Подложка карты');

    const r = roster.status(server.id);
    add('roster', 'Прописка настроена', r.targets.length ? 'ok' : 'warn', r.reason);
  }

  add('owner', 'Владелец панели создан', users.isEmpty() ? 'fail' : 'ok',
    users.isEmpty() ? 'аккаунтов нет — вход пока по мастер-ключу из окна панели' : '');

  const d = discord.status();
  add('discord', 'Вход через Discord', d.enabled ? (d.ok ? 'ok' : 'fail') : 'off',
    d.enabled && !d.ok ? d.reason || 'не хватает Client ID, Secret или Redirect URI' : '');

  add('bot', 'Токен бота Discord', root.panel.discord && root.panel.discord.botToken ? 'ok' : 'off',
    root.panel.discord && root.panel.discord.botToken ? '' : 'бот без токена работать не будет');

  const dbs = root.panel.database;
  add('database', 'Общая база MySQL', dbs.enabled ? 'ok' : 'off',
    dbs.enabled ? `${dbs.user}@${dbs.host}:${dbs.port}/${dbs.name}` : 'выключена — панель работает на файлах',
    'Проверить: кнопка «Проверить базу»');

  const tokens = root.panel.apiTokens || [];
  add('tokens', 'API-токены для сайта и бота', tokens.length ? 'ok' : 'warn',
    tokens.length ? `выдано: ${tokens.length}` : 'без токена бот и сайт не смогут обращаться к панели',
    'Настройки → Аккаунты и права → API-токены');

  return items;
}

/* --------------------------------------------------------------------- запись */

/** Все поля мастера, доступные для записи, по пути. */
function fieldIndex() {
  const map = new Map();
  for (const step of STEPS) for (const field of step.fields) map.set(field.path, field);
  return map;
}

/**
 * Применить изменения.
 *
 * `values` — { путь: значение }. Неизвестные пути отбрасываются: мастер не
 * должен превращаться в универсальную запись в конфиг.
 * `clear` — список путей-секретов, которые нужно именно стереть.
 */
function apply(payload = {}) {
  const fields = fieldIndex();
  const values = payload.values && typeof payload.values === 'object' ? payload.values : {};
  const clear = Array.isArray(payload.clear) ? payload.clear : [];

  const rootPatch = {};
  const serverPatch = {};
  const applied = [];
  const skipped = [];

  const put = (field, value) => {
    const target = scopeOf(field.path) === 'server' ? serverPatch : rootPatch;
    setByPath(target, field.path, value);
    applied.push(field.path);
  };

  for (const [dotted, raw] of Object.entries(values)) {
    const field = fields.get(dotted);
    if (!field) { skipped.push(dotted); continue; }

    if (field.type === 'bool') { put(field, Boolean(raw)); continue; }
    if (field.type === 'number') { put(field, Number(raw) || 0); continue; }

    if (field.type === 'roster') {
      const list = (Array.isArray(raw) ? raw : []).filter((t) => t && t.file);
      put(field, list);
      continue;
    }

    if (field.type === 'secret') {
      // Пустое поле означает «не менять»: страница секретов не знает, и без
      // этого правила обычное сохранение стирало бы все пароли.
      const text = String(raw == null ? '' : raw);
      if (!text) { skipped.push(dotted); continue; }
      put(field, text);
      continue;
    }

    put(field, String(raw == null ? '' : raw).trim());
  }

  for (const dotted of clear) {
    const field = fields.get(dotted);
    if (field && field.type === 'secret') put(field, '');
  }

  const restartNeeded = applied.some((p) => p.startsWith('panel.host') || p.startsWith('panel.port') || p.startsWith('panel.tls'));

  if (Object.keys(rootPatch).length) config.updateRoot(rootPatch);
  if (Object.keys(serverPatch).length) {
    if (!config.hasServers()) throw new Error('Сначала создайте сервер в панели — настройки сервера некуда записать');
    config.updateActive(serverPatch);
  }

  return {
    saved: applied.length,
    applied,
    skipped,
    restartNeeded,
    // Пересобранная сводка: страница сразу показывает, что изменилось.
    checklist: checklist(config.hasServers() ? config.activeServer() : null)
  };
}

/** Проверка базы по кнопке — чтобы не гадать, «а видит ли она XAMPP». */
async function testDatabase() {
  return db.status();
}

/**
 * Страница мастера отдаётся без входа, поэтому её нужно закрыть снаружи здесь:
 * express.static отдал бы файл кому угодно.
 */
const PAGES = new Set(['/setup.html', '/js/setup.js']);

function pageGuard() {
  return (req, res, next) => {
    const url = req.path || req.url.split('?')[0];
    if (!PAGES.has(url)) return next();
    if (isLocalRequest(req)) return next();

    return res.status(403).send('Мастер настройки открывается только на самой машине панели.');
  };
}

module.exports = { STEPS, PAGES, isLocalRequest, refuse, pageGuard, state, apply, checklist, testDatabase };
