'use strict';

/**
 * Автоматический перезапуск серверов по расписанию.
 *
 * Два режима:
 *   interval — каждые N часов с момента запуска сервера (например, «каждые 3 часа»);
 *   schedule — в заданные часы суток (06:00, 12:00, 18:00, 00:00).
 *
 * За несколько минут до перезапуска панель предупреждает в логе и в интерфейсе,
 * чтобы админ успел вмешаться. Отсчёт идёт только пока сервер работает: если он
 * остановлен вручную, никакие таймеры не тикают.
 *
 * Важное про игровое время: чтобы после перезапуска время в игре продолжалось,
 * а не сбрасывалось на системное, в serverDZ.cfg должен стоять
 * serverTimePersistent = 1. Панель следит за этим и предупреждает, если
 * автоперезапуск включён, а сохранение времени — нет.
 */

const config = require('../config');
const logger = require('../logger');
const bus = require('../events');
const jobs = require('./jobs');
const serverProcess = require('./serverProcess');

const SOURCE = 'restart';
const TICK_MS = 10_000;

/** serverId -> { nextAt, warned: Set<number>, restarting: boolean } */
const states = new Map();
let timer = null;

function stateOf(serverId) {
  if (!states.has(serverId)) {
    states.set(serverId, { nextAt: null, warned: new Set(), restarting: false, signature: null });
  }
  return states.get(serverId);
}

/**
 * Отпечаток входных данных расписания.
 *
 * Пока он не менялся, момент перезапуска пересчитывать НЕЛЬЗЯ: иначе, как
 * только назначенное время наступает, расчёт честно выдаёт следующее (завтра),
 * и условие «пора перезапускать» не выполняется никогда. Поэтому время цели
 * фиксируется и живёт до срабатывания или до смены настроек/времени запуска.
 */
function signatureOf(restart, startedAt) {
  return JSON.stringify([restart.mode, restart.intervalHours, restart.times, startedAt]);
}

/* ------------------------------------------------------- расчёт времени */

/**
 * Когда сервер должен перезапуститься.
 * @param {object} restart настройки расписания
 * @param {number} startedAt метка запуска сервера
 * @param {number} now
 * @returns {number|null}
 */
function computeNextAt(restart, startedAt, now = Date.now()) {
  if (!restart.enabled) return null;

  if (restart.mode === 'schedule') {
    if (!restart.times.length) return null;

    // Ближайшее время из списка — сегодня или завтра.
    let best = null;
    for (const offset of [0, 1]) {
      for (const time of restart.times) {
        const [h, m] = time.split(':').map(Number);
        const date = new Date(now);
        date.setDate(date.getDate() + offset);
        date.setHours(h, m, 0, 0);

        const at = date.getTime();
        // Момент, наступивший до запуска сервера, уже неактуален.
        if (at <= now || at <= startedAt) continue;
        if (best === null || at < best) best = at;
      }
    }
    return best;
  }

  return startedAt + Math.round(restart.intervalHours * 3600 * 1000);
}

/** Состояние для интерфейса. */
function state(serverId) {
  const st = states.get(serverId);
  let restart;
  try {
    restart = config.active(serverId).restart;
  } catch (_) {
    return { enabled: false, nextAt: null, secondsLeft: null };
  }

  return {
    enabled: Boolean(restart.enabled),
    mode: restart.mode,
    intervalHours: restart.intervalHours,
    times: restart.times,
    warnMinutes: restart.warnMinutes,
    nextAt: st ? st.nextAt : null,
    secondsLeft: st && st.nextAt ? Math.max(0, Math.round((st.nextAt - Date.now()) / 1000)) : null
  };
}

const allStates = () => Object.fromEntries(config.servers().map((s) => [s.id, state(s.id)]));

/* ------------------------------------------------------------ основной цикл */

function tick() {
  const now = Date.now();

  for (const server of config.servers()) {
    const st = stateOf(server.id);
    const restart = server.restart;
    const status = serverProcess.getStatus(server.id);

    // Отсчёт идёт только для работающего сервера.
    if (!restart.enabled || status.status !== 'running' || !status.startedAt) {
      if (st.nextAt !== null || st.signature !== null) {
        st.nextAt = null;
        st.signature = null;
        st.warned.clear();
        bus.emit('restart-plan', { serverId: server.id, ...state(server.id) });
      }
      continue;
    }

    const signature = signatureOf(restart, status.startedAt);
    if (st.signature !== signature) {
      st.signature = signature;
      st.nextAt = computeNextAt(restart, status.startedAt, now);
      st.warned.clear();

      if (st.nextAt) {
        logger.info(
          SOURCE,
          `«${server.name}»: следующий автоперезапуск в ${new Date(st.nextAt).toLocaleString('ru-RU')}`,
          { serverId: server.id }
        );
      }
      bus.emit('restart-plan', { serverId: server.id, ...state(server.id) });
    }

    if (!st.nextAt || st.restarting) continue;

    const minutesLeft = (st.nextAt - now) / 60000;

    for (const warn of restart.warnMinutes) {
      if (minutesLeft <= warn && !st.warned.has(warn)) {
        st.warned.add(warn);
        logger.warn(SOURCE, `«${server.name}»: перезапуск через ${warn} мин.`, { serverId: server.id });
        bus.emit('restart-warning', { serverId: server.id, serverName: server.name, minutes: warn });
      }
    }

    if (now >= st.nextAt) trigger(server);
  }
}

function trigger(server) {
  const st = stateOf(server.id);
  if (st.restarting) return;

  st.restarting = true;
  st.nextAt = null;
  st.signature = null; // после перезапуска расписание считается заново от нового старта
  st.warned.clear();

  logger.info(SOURCE, `«${server.name}»: плановый перезапуск начался`, { serverId: server.id });
  bus.emit('restart-warning', { serverId: server.id, serverName: server.name, minutes: 0 });

  jobs.run(
    { type: 'restart-server', title: `Плановый перезапуск «${server.name}»`, serverId: server.id },
    async (job) =>
      config.withServer(server.id, () =>
        serverProcess.restart(server.id, {
          onProgress: (p) => jobs.update(job.id, { progress: p.percent, step: p.step })
        })
      )
  );

  // Дальше расписание пересчитается от нового времени старта; снимаем флаг,
  // когда сервер поднимется или окончательно останется остановленным.
  const release = setInterval(() => {
    const status = serverProcess.getStatus(server.id);
    if (status.status === 'running' || status.status === 'stopped') {
      st.restarting = false;
      clearInterval(release);
    }
  }, 5000);
  if (release.unref) release.unref();
}

/* ---------------------------------------------------------------- запуск */

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  tick();

  const planned = config.servers().filter((s) => s.restart.enabled);
  if (planned.length) {
    logger.info(SOURCE, `Автоперезапуск включён для серверов: ${planned.map((s) => s.name).join(', ')}`);
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Проблемы конфигурации автоперезапуска — показываются в интерфейсе.
 * @param {string} serverId
 */
function warnings(serverId) {
  const out = [];
  let v;
  try {
    v = config.active(serverId);
  } catch (_) {
    return out;
  }

  if (!v.restart.enabled) return out;

  if (!v.server.timePersistent) {
    out.push(
      'Автоперезапуск включён, но сохранение игрового времени выключено: ' +
        'после каждого перезапуска время в игре сбросится. Включите «Продолжать игровое время».'
    );
  }
  if (v.restart.mode === 'schedule' && !v.restart.times.length) {
    out.push('Выбран режим «по часам», но ни одно время не задано.');
  }

  return out;
}

module.exports = { start, stop, tick, state, allStates, computeNextAt, warnings };
