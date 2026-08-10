/**
 * Состояние интерфейса и живой поток событий с сервера.
 *
 * Экраны не ходят в API за статусом наперегонки: они подписываются на
 * события store и перерисовываются, когда данные меняются.
 */

import { api } from './api.js';

const listeners = new Map();

export const state = {
  connected: false,
  auth: null,
  /** Кто вошёл и что ему можно: /api/auth/me. */
  me: null,
  permissions: [],
  panel: null,
  hasServers: false,
  activeServerId: null,
  servers: [],
  statuses: {},
  problems: [],
  steamcmd: null,
  config: null,
  mods: { mods: [], orphans: [], localCandidates: [] },
  jobs: new Map(),
  restarts: {},
  announcements: {},
  lastLogId: 0
};

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event).delete(handler);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[store] обработчик ${event}:`, err);
    }
  }
}

/* ------------------------------------------------------------ загрузка */

export async function refreshStatus() {
  const data = await api.status();
  state.panel = data.panel;
  state.hasServers = data.hasServers;
  state.activeServerId = data.activeServerId;
  state.servers = data.servers;
  state.statuses = data.statuses;
  state.problems = data.problems;
  state.steamcmd = data.steamcmd;
  state.restarts = data.restarts || {};
  state.announcements = data.announcements || {};

  for (const job of data.jobs || []) state.jobs.set(job.id, job);

  emit('status', data);
  emit('servers', state.servers);
  return data;
}

/**
 * Кто вошёл и какие у него права.
 *
 * По этому списку интерфейс скрывает недоступное: человеку с доступом «только
 * логи» незачем видеть моды и порты, а его браузеру — собирать отказы 403.
 */
export async function refreshMe() {
  try {
    const data = await api.me();
    state.me = data.user;
    state.permissions = data.permissions || [];
    // Вход по мастер-ключу при первичной настройке: прав ещё нет, но можно всё.
    if (!state.me && data.master) state.permissions = ['*'];
  } catch (_) {
    state.me = null;
    state.permissions = ['*'];
  }

  emit('me', state.me);
  return state.me;
}

/** Есть ли у вошедшего право. Владелец («*») может всё. */
export function can(permission) {
  if (!state.permissions || !state.permissions.length) return true;
  return state.permissions.includes('*') || state.permissions.includes(permission);
}

export async function refreshConfig() {
  try {
    state.config = await api.config();
  } catch (err) {
    // Настройки видны не всем: у «только логов» их нет, и это нормально.
    if (!/прав/i.test(err.message)) throw err;
    state.config = null;
  }

  emit('config', state.config);
  return state.config;
}

export async function refreshServers() {
  const data = await api.servers();
  state.servers = data.servers;
  state.activeServerId = data.activeServerId;
  state.hasServers = data.servers.length > 0;
  emit('servers', state.servers);
  return state.servers;
}

export async function refreshMods() {
  if (!state.activeServerId) return state.mods;
  state.mods = await api.mods();
  emit('mods', state.mods);
  return state.mods;
}

export const activeServer = () => state.servers.find((s) => s.id === state.activeServerId) || null;

export const activeStatus = () =>
  state.statuses[state.activeServerId] || { status: 'stopped', uptimeSec: 0, pid: null };

export const statusOf = (id) => state.statuses[id] || { status: 'stopped', uptimeSec: 0 };

export const restartOf = (id) => state.restarts[id] || { enabled: false, nextAt: null, secondsLeft: null };

export const announcementsOf = (id) =>
  state.announcements[id] || { enabled: false, count: 0, nextAt: null, secondsLeft: null };

/* ---------------------------------------------------------------- SSE */

let source = null;
let retry = 0;

export function connectStream() {
  if (source) source.close();
  source = new EventSource(`/api/stream?since=${state.lastLogId}`);

  source.addEventListener('open', () => {
    state.connected = true;
    retry = 0;
    emit('connection', true);
  });

  source.addEventListener('backlog', (e) => {
    const entries = JSON.parse(e.data);
    if (entries.length) state.lastLogId = entries[entries.length - 1].id;
    emit('backlog', entries);
  });

  source.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    state.lastLogId = entry.id;
    emit('log', entry);
  });

  source.addEventListener('status', (e) => {
    const status = JSON.parse(e.data);
    state.statuses[status.serverId] = status;
    const server = state.servers.find((s) => s.id === status.serverId);
    if (server) {
      server.status = status.status;
      server.uptimeSec = status.uptimeSec;
      server.lastError = status.lastError;
      server.lastCrashReport = status.lastCrashReport;
    }
    emit('server-status', status);
    emit('servers', state.servers);
  });

  source.addEventListener('statuses', (e) => {
    state.statuses = JSON.parse(e.data);
    emit('servers', state.servers);
  });

  source.addEventListener('job', (e) => {
    const job = JSON.parse(e.data);
    state.jobs.set(job.id, job);
    emit('job', job);
  });

  source.addEventListener('restarts', (e) => {
    state.restarts = JSON.parse(e.data);
    emit('restarts', state.restarts);
  });

  source.addEventListener('restart-plan', (e) => {
    const plan = JSON.parse(e.data);
    state.restarts[plan.serverId] = plan;
    emit('restarts', state.restarts);
  });

  source.addEventListener('restart-warning', (e) => {
    emit('restart-warning', JSON.parse(e.data));
  });

  source.addEventListener('announcements', (e) => {
    state.announcements = JSON.parse(e.data);
    emit('announcements', state.announcements);
  });

  // Объявление ушло в игру — панель показывает то же, что увидели игроки.
  source.addEventListener('announcement', (e) => {
    emit('announcement', JSON.parse(e.data));
  });

  source.addEventListener('servers', (e) => {
    state.servers = JSON.parse(e.data);
    state.hasServers = state.servers.length > 0;
    emit('servers', state.servers);
  });

  source.addEventListener('error', () => {
    state.connected = false;
    emit('connection', false);
    // EventSource переподключается сам; сообщаем об этом в интерфейсе.
    retry = Math.min(retry + 1, 10);
  });
}

/* ------------------------------------------------------------ навигация */

/** Переход между экранами: app.js слушает это событие. */
export function navigate(screen, params = {}) {
  emit('navigate', { screen, params });
}

/** Дождаться завершения задачи (для мастеров и кнопок с прогрессом). */
export function awaitJob(jobId) {
  return new Promise((resolve, reject) => {
    const existing = state.jobs.get(jobId);
    if (existing && existing.status !== 'running') {
      return existing.status === 'done' ? resolve(existing) : reject(new Error(existing.error || 'Задача прервана'));
    }

    const off = on('job', (job) => {
      if (job.id !== jobId) return;
      if (job.status === 'running') return;
      off();
      if (job.status === 'done') resolve(job);
      else reject(new Error(job.error || 'Задача отменена'));
    });
  });
}
