'use strict';

/**
 * Периодические объявления игрокам в чат.
 *
 * Сообщений может быть сколько угодно — они лежат списком у каждого сервера и
 * уходят в игру по кругу (или в случайном порядке) с заданным интервалом:
 * «Вы играете на сервере X», правила, ссылка на Discord, время до перезапуска.
 *
 * Отсчёт идёт только пока сервер работает: писать в чат остановленного сервера
 * некому. Первое объявление уходит не сразу после старта, а через интервал —
 * игрокам нужно время загрузиться в мир.
 *
 * Доставкой занимается ingame.js, поэтому здесь нет ни слова про CFTools.
 */

const config = require('../config');
const logger = require('../logger');
const bus = require('../events');
const ingame = require('./ingame');
const serverProcess = require('./serverProcess');

const SOURCE = 'announce';
const TICK_MS = 15_000;

/** serverId -> { index, lastSentAt, since, signature, busy } */
const states = new Map();
let timer = null;

function stateOf(serverId) {
  if (!states.has(serverId)) {
    states.set(serverId, { index: 0, lastSentAt: null, since: null, signature: null, busy: false });
  }
  return states.get(serverId);
}

/** Отпечаток настроек: при их смене отсчёт начинается заново. */
function signatureOf(a, startedAt) {
  return JSON.stringify([a.enabled, a.intervalMinutes, a.order, a.messages.length, startedAt]);
}

/* ---------------------------------------------------------------- состояние */

/** Состояние для интерфейса. */
function state(serverId) {
  let a;
  try {
    a = config.active(serverId).announcements;
  } catch (_) {
    return { enabled: false, count: 0, nextAt: null, secondsLeft: null };
  }

  const st = states.get(serverId);
  const base = st && st.since ? st.lastSentAt || st.since : null;
  const nextAt = base ? base + a.intervalMinutes * 60_000 : null;

  return {
    enabled: Boolean(a.enabled),
    count: a.messages.length,
    intervalMinutes: a.intervalMinutes,
    order: a.order,
    nextIndex: st ? st.index : 0,
    lastSentAt: st ? st.lastSentAt : null,
    nextAt,
    secondsLeft: nextAt ? Math.max(0, Math.round((nextAt - Date.now()) / 1000)) : null
  };
}

const allStates = () => Object.fromEntries(config.servers().map((s) => [s.id, state(s.id)]));

/* ------------------------------------------------------------ основной цикл */

function tick() {
  const now = Date.now();

  for (const server of config.servers()) {
    const a = server.announcements;
    const st = stateOf(server.id);
    const status = serverProcess.getStatus(server.id);
    const active = a.enabled && a.messages.length > 0 && status.status === 'running' && status.startedAt;

    if (!active) {
      if (st.since !== null) {
        st.since = null;
        st.lastSentAt = null;
        st.signature = null;
      }
      continue;
    }

    const signature = signatureOf(a, status.startedAt);
    if (st.signature !== signature) {
      st.signature = signature;
      // Первое объявление — через интервал от запуска сервера, а не сразу.
      st.since = status.startedAt;
      st.lastSentAt = null;
      st.index = 0;
      logger.info(
        SOURCE,
        `«${server.name}»: объявления в чат включены — ${a.messages.length} шт., каждые ${a.intervalMinutes} мин.`,
        { serverId: server.id }
      );
    }

    const base = st.lastSentAt || st.since;
    if (st.busy || now - base < a.intervalMinutes * 60_000) continue;

    sendNext(server, st);
  }
}

/** Отправить очередное объявление. */
function sendNext(server, st) {
  const a = server.announcements;
  const index = pickIndex(a, st);
  const template = a.messages[index];

  st.busy = true;
  st.lastSentAt = Date.now();

  ingame
    .say(server.id, ingame.render(template, server.id), { label: `объявление №${index + 1}` })
    .then((result) => {
      if (result.sent) bus.emit('announcement', { serverId: server.id, index, text: result.text });
    })
    .finally(() => {
      st.busy = false;
      bus.emit('announcements', allStates());
    });
}

/**
 * Какое сообщение отправлять.
 * В случайном режиме подряд одно и то же не повторяется, если сообщений больше
 * одного, — иначе «случайность» выглядит как поломка.
 */
function pickIndex(a, st) {
  if (a.order !== 'random') {
    const index = st.index % a.messages.length;
    st.index = (index + 1) % a.messages.length;
    return index;
  }

  if (a.messages.length === 1) return 0;

  let index;
  do {
    index = Math.floor(Math.random() * a.messages.length);
  } while (index === st.lastIndex);

  st.lastIndex = index;
  return index;
}

/**
 * Отправить объявление прямо сейчас — кнопка «Отправить сейчас» в интерфейсе.
 *
 * @param {string} serverId
 * @param {{index?: number, text?: string}} [opts] index — номер из списка,
 *        text — произвольный текст (шаблон тоже сработает)
 */
async function sendNow(serverId, opts = {}) {
  const v = config.active(serverId);
  const messages = v.announcements.messages;

  let template = opts.text;
  if (!template) {
    const index = Number.isFinite(Number(opts.index)) ? Number(opts.index) : 0;
    if (!messages.length) throw new Error('Список объявлений пуст — добавьте хотя бы одно сообщение.');
    if (index < 0 || index >= messages.length) throw new Error(`Объявления №${index + 1} нет в списке`);
    template = messages[index];
  }

  const text = ingame.render(template, serverId);
  const result = await ingame.say(serverId, text, { label: 'объявление вручную', quiet: true });

  // Ручная отправка — единственный случай, когда об ошибке нужно сказать в
  // ответе на запрос: пользователь стоит и смотрит на кнопку.
  if (!result.sent) throw new Error(`Не отправлено: ${result.reason}`);
  return result;
}

/* ---------------------------------------------------------------- запуск */

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  tick();

  const on = config.servers().filter((s) => s.announcements.enabled && s.announcements.messages.length);
  if (on.length) {
    logger.info(SOURCE, `Объявления в чат настроены для серверов: ${on.map((s) => s.name).join(', ')}`);
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Проблемы настройки — показываются в интерфейсе рядом с остальными. */
function warnings(serverId) {
  const out = [];
  let v;
  try {
    v = config.active(serverId);
  } catch (_) {
    return out;
  }
  if (!v.announcements.enabled) return out;

  if (!v.announcements.messages.length) {
    out.push('Объявления в чат включены, но список сообщений пуст.');
  }

  const ready = ingame.available(serverId);
  if (!ready.ok) out.push(`Объявления не дойдут до игроков: ${ready.reason}.`);

  const tooLong = v.announcements.messages
    .map((text, i) => ({ i, length: ingame.render(text, serverId).length }))
    .filter((m) => m.length > ingame.MAX_LENGTH);

  for (const m of tooLong) {
    out.push(`Объявление №${m.i + 1} длиннее ${ingame.MAX_LENGTH} символов (${m.length}) — оно не отправится.`);
  }

  return out;
}

module.exports = { start, stop, tick, state, allStates, sendNow, warnings };
