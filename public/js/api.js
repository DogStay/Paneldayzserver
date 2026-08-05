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
  downloadMods: (items) => request('POST', '/mods/download', { items }),
  adoptMod: (id, type) => request('POST', '/mods/adopt', { id, type }),
  addLocalMod: (data) => request('POST', '/mods/local', data),
  patchMod: (id, patch) => request('PATCH', `/mods/${id}`, patch),
  deleteMod: (id, deleteFiles) => request('DELETE', `/mods/${id}${deleteFiles ? '?deleteFiles=1' : ''}`),
  reorderMods: (ids) => request('POST', '/mods/reorder', { ids }),
  updateMods: () => request('POST', '/mods/update', {}),
  forceUpdateMod: (id) => request('POST', `/mods/${id}/force-update`, {}),
  deployMods: () => request('POST', '/mods/deploy', {}),

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

  diagnostics: () => request('GET', '/diagnostics'),
  buildReport: () => request('POST', '/diagnostics', {}),
  readReport: (name) => request('GET', `/diagnostics/${encodeURIComponent(name)}`),
  deleteReport: (name) => request('DELETE', `/diagnostics/${encodeURIComponent(name)}`),

  cancelJob: (id) => request('POST', `/jobs/${id}/cancel`, {}),
  clearLogs: () => request('DELETE', '/logs')
};
