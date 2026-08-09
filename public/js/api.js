/**
 * Тонкая обёртка над fetch для API панели.
 * Все ответы — JSON; текст ошибки из поля `error` превращается в Error.
 */

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`/api${url}`, opts);
  } catch (_) {
    throw new Error('Нет связи с панелью. Окно с панелью закрыто?');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { error: text.slice(0, 300) };
    }
  }

  // Сессия истекла или панель перезапустилась с новыми ключами — на страницу входа.
  if (res.status === 401 && data && data.auth === 'required') {
    if (!location.pathname.endsWith('/login.html')) location.href = '/login.html';
    throw new Error('Требуется вход по мастер-ключу');
  }

  if (!res.ok) throw new Error((data && data.error) || `Ошибка ${res.status}`);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url) => request('DELETE', url),

  /* Прикладные вызовы — чтобы экраны не собирали строки URL руками */
  access: (localOnly) => request('GET', `/access${localOnly ? '?local=1' : ''}`),
  accessOpenPort: () => request('POST', '/access/firewall', {}),
  accessExpose: (host) => request('POST', '/access/expose', { host: host || '0.0.0.0' }),

  authStatus: () => request('GET', '/auth/status'),
  authKeys: () => request('GET', '/auth/keys'),
  authRotate: () => request('POST', '/auth/rotate', {}),
  authSessions: () => request('GET', '/auth/sessions'),
  authTokens: () => request('GET', '/auth/tokens'),
  authCreateToken: (name, scope) => request('POST', '/auth/tokens', { name, scope }),
  authRevokeToken: (id) => request('DELETE', `/auth/tokens/${encodeURIComponent(id)}`),
  authCloseSession: (id) => request('DELETE', `/auth/sessions/${encodeURIComponent(id)}`),
  authLogout: () => request('POST', '/auth/logout', {}),

  status: () => request('GET', '/status'),
  config: () => request('GET', '/config'),
  saveConfig: (patch) => request('PUT', '/config', patch),

  servers: () => request('GET', '/servers'),
  suggest: (name) => request('GET', `/servers/suggest?name=${encodeURIComponent(name || '')}`),
  createServer: (data) => request('POST', '/servers', data),
  installServer: (id, body) => request('POST', `/servers/${id}/install`, body ?? {}),
  activateServer: (id) => request('POST', `/servers/${id}/activate`, {}),
  patchServer: (id, patch) => request('PATCH', `/servers/${id}`, patch),
  deleteServer: (id, deleteFiles) => request('DELETE', `/servers/${id}${deleteFiles ? '?deleteFiles=1' : ''}`),

  mods: () => request('GET', '/mods'),
  searchWorkshop: (q, page) => request('GET', `/workshop/search?q=${encodeURIComponent(q)}&page=${page || 1}`),
  downloadMods: (items, opts) => request('POST', '/mods/download', { items, ...(opts || {}) }),
  adoptMod: (id, type) => request('POST', '/mods/adopt', { id, type }),
  addLocalMod: (data) => request('POST', '/mods/local', data),
  patchMod: (id, patch) => request('PATCH', `/mods/${id}`, patch),
  modRemovalInfo: (id) => request('GET', `/mods/${id}/removal-info`),
  /** opts: { deleteFiles, deleteWorkshop, deleteKeys, force } */
  deleteMod: (id, opts) => {
    const flags = typeof opts === 'boolean' ? { deleteFiles: opts } : opts || {};
    const query = Object.entries(flags)
      .filter(([, value]) => value)
      .map(([key]) => `${key}=1`)
      .join('&');
    return request('DELETE', `/mods/${id}${query ? `?${query}` : ''}`);
  },
  deleteWorkshopItem: (id, force) => request('DELETE', `/mods/workshop/${id}${force ? '?force=1' : ''}`),
  reorderMods: (ids) => request('POST', '/mods/reorder', { ids }),
  updateMods: (opts) => request('POST', '/mods/update', opts || {}),
  forceUpdateMod: (id, opts) => request('POST', `/mods/${id}/force-update`, opts || {}),
  deployMods: (opts) => request('POST', '/mods/deploy', opts || {}),

  startServer: (opts) => request('POST', '/server/start', opts ?? {}),
  stopServer: () => request('POST', '/server/stop', {}),
  restartServer: () => request('POST', '/server/restart', {}),

  bat: () => request('GET', '/bat'),
  writeBat: () => request('POST', '/bat', {}),

  firewall: () => request('GET', '/firewall'),
  applyFirewall: (force) => request('POST', '/firewall/apply', { force: Boolean(force) }),
  firewallBat: () => request('POST', '/firewall/bat', {}),
  removeFirewall: () => request('DELETE', '/firewall'),

  serverCfg: () => request('GET', '/servercfg'),
  saveServerCfg: (content) => request('PUT', '/servercfg', { content }),
  syncServerCfg: () => request('POST', '/servercfg/sync', {}),

  /* Подложка карты: тайлы отдаёт сама панель, кэшируя их на диске */
  map: () => request('GET', '/map'),
  clearMapTiles: (all) => request('DELETE', `/map/tiles${all ? '?all=1' : ''}`),
  testMapTiles: (layer) => request('POST', '/map/test', { layer }),
  setMapImage: (url) => request('POST', '/map/image', { url }),

  /** Файл картинки отправляется байтами: multipart тут ни к чему. */
  uploadMapImage: async (file) => {
    const res = await fetch('/api/map/image/upload', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { error: text.slice(0, 300) };
    }

    if (!res.ok) throw new Error((data && data.error) || `Ошибка ${res.status}`);
    return data;
  },
  clearMapImage: () => request('DELETE', '/map/image'),

  missions: () => request('GET', '/missions'),
  selectMission: (mission, force) => request('POST', '/missions/select', { mission, force: Boolean(force) }),

  /* Мост с серверным модом: карта, игроки, действия, журнал событий */
  bridge: () => request('GET', '/bridge'),
  bridgePrepare: () => request('POST', '/bridge/prepare', {}),
  bridgePlayers: () => request('GET', '/bridge/players'),
  bridgeInventory: (id) => request('GET', `/bridge/players/${encodeURIComponent(id)}/inventory`),
  bridgeTrail: (id, minutes) =>
    request('GET', `/bridge/players/${encodeURIComponent(id)}/trail?minutes=${minutes || 30}`),
  bridgeTrails: (minutes) => request('GET', `/bridge/trails?minutes=${minutes || 15}`),
  bridgeCommand: (action, args) => request('POST', '/bridge/command', { action, args }),

  events: (query) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return request('GET', `/events${qs ? `?${qs}` : ''}`);
  },
  eventsSummary: (hours) => request('GET', `/events/summary${hours ? `?hours=${hours}` : ''}`),
  adminlog: () => request('GET', '/adminlog'),
  adminlogRescan: () => request('POST', '/adminlog/rescan', {}),

  ingame: () => request('GET', '/ingame'),
  ingameSay: (text) => request('POST', '/ingame/say', { text }),

  battleye: () => request('GET', '/battleye'),
  battleyeTest: () => request('POST', '/battleye/test', {}),
  battleyeSetup: (body) => request('POST', '/battleye/setup', body || {}),
  battleyePlayers: () => request('GET', '/battleye/players'),
  battleyeCommand: (command) => request('POST', '/battleye/command', { command }),

  announcements: () => request('GET', '/announcements'),
  sendAnnouncement: (body) => request('POST', '/announcements/send', body || {}),
  previewAnnouncements: (texts) => request('POST', '/announcements/preview', { texts }),

  /* CFTools Cloud — работают только при включённой интеграции */
  cfStatus: () => request('GET', '/cftools/status'),
  cfTest: () => request('POST', '/cftools/test', {}),
  cfGrants: () => request('GET', '/cftools/grants'),
  cfServer: () => request('GET', '/cftools/server'),
  cfPlayers: () => request('GET', '/cftools/players'),
  cfPlayer: (cftoolsId) => request('GET', `/cftools/player?cftoolsId=${encodeURIComponent(cftoolsId)}`),
  cfKick: (sessionId, reason) => request('POST', '/cftools/kick', { sessionId, reason }),
  cfMessage: (sessionId, content) => request('POST', '/cftools/message', { sessionId, content }),
  cfBroadcast: (content) => request('POST', '/cftools/broadcast', { content }),
  cfRcon: (command) => request('POST', '/cftools/rcon', { command }),
  cfBans: (filter) => request('GET', `/cftools/bans${filter ? `?filter=${encodeURIComponent(filter)}` : ''}`),
  cfBan: (data) => request('POST', '/cftools/bans', data),
  cfUnban: (banId) => request('DELETE', `/cftools/bans/${encodeURIComponent(banId)}`),

  diagnostics: () => request('GET', '/diagnostics'),
  buildReport: () => request('POST', '/diagnostics', {}),
  readReport: (name) => request('GET', `/diagnostics/${encodeURIComponent(name)}`),
  deleteReport: (name) => request('DELETE', `/diagnostics/${encodeURIComponent(name)}`),

  cancelJob: (id) => request('POST', `/jobs/${id}/cancel`, {}),
  clearLogs: () => request('DELETE', '/logs')
};
