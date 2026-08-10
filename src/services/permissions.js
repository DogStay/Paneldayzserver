'use strict';

/**
 * Какое право нужно каждому маршруту API.
 *
 * Проверка живёт в одном месте, а не в каждом обработчике: так нельзя случайно
 * забыть её в новом маршруте. Правила разбираются по порядку, первое совпадение
 * решает; всё, что не совпало ни с одним правилом, требует прав владельца —
 * безопасная сторона по умолчанию, а не «разрешено, потому что забыли».
 *
 * Ключ правила — метод (или * для любого) и начало пути после /api.
 */

/** [метод, путь (regex или начало строки), право] */
const RULES = [
  // Вход и «кто я» — доступны любому вошедшему.
  ['*', '/auth/me', 'panel.view'],
  ['POST', '/auth/logout', 'panel.view'],

  // Управление собой и другими.
  ['*', '/auth/password', 'panel.view'],
  ['*', '/users', 'users.manage'],
  ['*', '/roles', 'users.manage'],
  ['*', '/auth/keys', 'users.manage'],
  ['*', '/auth/rotate', 'users.manage'],
  ['*', '/auth/sessions', 'users.manage'],
  ['*', '/auth/tokens', 'tokens.manage'],
  ['*', '/auth/discord', 'users.manage'],

  // Карта и игроки. Точные правила идут раньше общих: иначе «/bridge/players»
  // перехватило бы и инвентарь, и трассы.
  ['GET', '/map', 'map.view'],
  ['*', '/map', 'settings.manage'],
  ['GET', /^\/bridge\/players\/[^/]+\/inventory/, 'inventory.view'],
  ['GET', /^\/bridge\/players\/[^/]+\/trail/, 'map.trails'],
  ['GET', '/bridge/trails', 'map.trails'],
  ['GET', '/bridge/players', 'map.view'],
  ['GET', '/bridge', 'map.view'],
  ['POST', '/bridge/prepare', 'settings.manage'],
  /*
   * Команды моду проверяются по самой команде — см. commandPermission() и
   * обработчик маршрута. Здесь стоит самое мягкое условие: иначе общая проверка
   * отказала бы раньше, чем дело дошло до разбора действия.
   */
  ['POST', '/bridge/command', 'players.view'],

  // Журналы.
  ['GET', '/events', 'events.view'],
  ['GET', '/adminlog', 'events.view'],
  ['POST', '/adminlog/rescan', 'events.view'],
  ['GET', '/logs', 'logs.view'],
  ['DELETE', '/logs', 'logs.view'],

  // Сервер.
  ['GET', '/status', 'panel.view'],
  ['GET', '/servers', 'server.view'],
  /*
   * Переключение активного сервера — навигация, «на какой сервер я смотрю», а не
   * доступ к сведениям о нём. Поэтому хватает права входа: иначе человек с
   * доступом только к логам не смог бы даже открыть сервер и добраться до них.
   */
  ['POST', /^\/servers\/[^/]+\/activate$/, 'panel.view'],
  ['POST', '/server/', 'server.control'],
  ['*', '/servers', 'settings.manage'],
  ['GET', '/servercfg', 'settings.view'],
  ['*', '/servercfg', 'settings.manage'],
  ['GET', '/missions', 'settings.view'],
  ['POST', '/missions/select', 'settings.manage'],

  // Моды.
  ['GET', '/mods', 'mods.view'],
  ['GET', '/workshop/search', 'mods.view'],
  ['*', '/mods', 'mods.manage'],

  // Сообщения в игру и объявления.
  ['GET', '/ingame', 'players.view'],
  ['POST', '/ingame/say', 'ingame.say'],
  ['*', '/announcements', 'ingame.say'],
  ['GET', '/battleye', 'settings.view'],
  ['*', '/battleye', 'settings.manage'],

  // Файлы папки profiles.
  ['GET', '/files', 'files.read'],
  ['*', '/files', 'files.write'],

  // Прочее хозяйство панели.
  /*
   * Верификация. Три маршрута из потока игрока (session, steam/start,
   * steam/callback) вход не требуют совсем — они в PUBLIC_PATHS: игрок панели не
   * принадлежит и логина в ней не имеет. Остальное — для бота и админа.
   */
  // В ответе настоящий токен бота, поэтому право такое же, как у настроек.
  ['GET', '/bot/config', 'settings.manage'],

  ['POST', '/verify/start', 'files.write'],
  ['GET', '/verify/status', 'players.view'],
  ['GET', '/verify/pending', 'players.view'],
  ['POST', '/verify/ack', 'players.view'],
  ['GET', '/verify/links', 'players.view'],
  ['POST', '/verify/link', 'files.write'],
  ['POST', '/verify/unlink', 'files.write'],

  // Прописка игрока меняет файлы сервера — это право файлов, не просмотра.
  ['GET', '/roster/groups', 'files.read'],
  ['GET', '/roster', 'files.read'],
  ['POST', '/roster/add', 'files.write'],
  ['GET', '/db', 'settings.view'],
  ['POST', '/db/init', 'settings.manage'],
  ['GET', '/config', 'settings.view'],
  ['PUT', '/config', 'settings.manage'],
  ['*', '/firewall', 'settings.manage'],
  ['*', '/bat', 'settings.manage'],
  ['*', '/access', 'settings.manage'],
  ['*', '/diagnostics', 'settings.view'],
  ['*', '/cftools', 'settings.view'],
  ['*', '/jobs', 'panel.view'],
  ['*', '/steamcmd', 'mods.manage'],
  ['GET', '/stream', 'panel.view']
];

/** Команды моду требуют разных прав: смотреть — одно, править вещи — другое. */
const COMMAND_PERMISSIONS = {
  inventory: 'inventory.view',
  item_delete: 'inventory.edit',
  item_quantity: 'inventory.edit',
  item_health: 'inventory.edit',
  item_to_hands: 'inventory.edit',
  item_to_ground: 'inventory.edit',
  item_move: 'inventory.edit',
  item_spawn: 'inventory.edit',
  give_item: 'inventory.edit',
  remove_item: 'inventory.edit',
  clear_inventory: 'inventory.edit',

  spawn_object: 'map.spawn',
  teleport: 'map.spawn',
  teleport_to: 'map.spawn',

  set_time: 'settings.manage',
  set_weather: 'settings.manage'
};

/**
 * @param {string} method метод запроса
 * @param {string} path путь без префикса /api
 * @returns {string} нужное право («*» — только владелец)
 */
function permissionFor(method, path) {
  const verb = String(method || 'GET').toUpperCase();
  const url = String(path || '');

  for (const [ruleMethod, rulePath, permission] of RULES) {
    if (ruleMethod !== '*' && ruleMethod !== verb) continue;

    let matches;
    if (rulePath instanceof RegExp) {
      matches = rulePath.test(url);
    } else {
      // Правило может быть записано и как «/server/» — это префикс группы.
      const prefix = rulePath.endsWith('/') ? rulePath : `${rulePath}/`;
      matches = url === rulePath || url === rulePath.replace(/\/$/, '') || url.startsWith(prefix);
    }
    if (matches) return permission;
  }

  return '*';
}

/** Право для конкретной команды моду; по умолчанию — действия по игроку. */
function commandPermission(action) {
  return COMMAND_PERMISSIONS[String(action || '')] || 'players.actions';
}

module.exports = { RULES, permissionFor, commandPermission, COMMAND_PERMISSIONS };
