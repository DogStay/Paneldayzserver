'use strict';

/**
 * Отправка текста игрокам в игру.
 *
 * Отдельный модуль, потому что «написать в чат сервера» — не такая простая
 * вещь, как кажется. У DayZ Standalone нет ни своего RCon для чата, ни способа
 * передать строку работающему процессу: движок ничего подобного наружу не
 * отдаёт. Единственный рабочий канал — игровая интеграция CFTools Cloud
 * (мод CFTools / GameLabs на сервере), через неё сообщение и уходит.
 *
 * Здесь это спрятано за одной функцией say(), поэтому предупреждения о
 * перезапуске и периодические объявления не знают, чем именно доставляется
 * текст. Появится второй канал — менять придётся только этот файл.
 */

const config = require('../config');
const logger = require('../logger');
const cftools = require('./cftools');

const SOURCE = 'ingame';

/** Ограничение CFTools на сообщение всем игрокам. */
const MAX_LENGTH = 256;

/**
 * Последняя причина недоставки по каждому серверу: одна и та же проблема
 * (выключенная интеграция, отсутствие связи) повторяется каждые несколько
 * минут, и лог из неё превратился бы в кашу.
 */
const lastFailure = new Map();

/**
 * Можно ли сейчас писать в игру — без обращения к сети.
 * @returns {{ok: boolean, reason: string}}
 */
function available(serverId) {
  let status;
  try {
    status = cftools.status(serverId);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  if (!status.enabled) {
    return {
      ok: false,
      reason:
        'сообщения в игру идут через CFTools Cloud, а интеграция выключена ' +
        '(включается в настройках сервера)'
    };
  }
  if (!status.hasApplicationId || !status.hasSecret) {
    return { ok: false, reason: 'в настройках CFTools не заполнены Application ID и Secret' };
  }
  if (!status.serverApiId) {
    return { ok: false, reason: 'в настройках CFTools не указан Server API ID этого сервера' };
  }

  return { ok: true, reason: '' };
}

/**
 * Подставить значения в шаблон сообщения.
 *
 * Понимает {server}, {map}, {players}, {minutes} и {restart} — время до
 * ближайшего планового перезапуска. Неизвестные подстановки остаются как есть:
 * лучше показать игрокам «{foo}», чем молча съесть часть текста.
 *
 * @param {string} template
 * @param {object} [extra] дополнительные значения (например minutes)
 */
function render(template, serverId, extra = {}) {
  let v;
  try {
    v = config.active(serverId);
  } catch (_) {
    v = null;
  }

  const values = {
    server: v ? v.server.name || v.name : '',
    map: v ? mapName(v.server.mission) : '',
    restart: restartLeft(serverId),
    ...extra
  };

  return String(template || '').replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) && values[key] !== null && values[key] !== undefined
      ? String(values[key])
      : match
  );
}

/** «dayzOffline.chernarusplus» -> «Chernarus+ (Черноруссия)». */
function mapName(mission) {
  const missions = require('./missions');
  return mission ? missions.labelFor(mission) : '';
}

/**
 * «1 ч 20 мин» до планового перезапуска.
 *
 * Когда автоперезапуск выключен или момент ещё не рассчитан (сервер только что
 * поднялся), подставляется «неизвестно»: пустая строка превратила бы объявление
 * в «До перезапуска: .» — выглядит как поломка.
 */
function restartLeft(serverId) {
  let plan;
  try {
    plan = require('./scheduler').state(serverId);
  } catch (_) {
    return 'неизвестно';
  }
  if (!plan || !plan.enabled || !plan.secondsLeft) return 'неизвестно';

  const minutes = Math.round(plan.secondsLeft / 60);
  if (minutes < 60) return `${minutes} мин`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

/**
 * Отправить сообщение всем игрокам.
 *
 * Никогда не бросает исключение: и предупреждения о перезапуске, и объявления
 * работают по таймеру, и недоставленное сообщение не должно ломать перезапуск
 * сервера или останавливать планировщик.
 *
 * @param {string} serverId
 * @param {string} text уже готовый текст (подстановки сделаны вызывающим)
 * @param {{label?: string, quiet?: boolean}} [opts] label — что это было, для лога
 * @returns {Promise<{sent: boolean, reason?: string, text: string}>}
 */
async function say(serverId, text, opts = {}) {
  const label = opts.label || 'сообщение';
  const message = String(text || '').trim();
  if (!message) return { sent: false, reason: 'пустой текст', text: message };

  const ready = available(serverId);
  if (!ready.ok) {
    noteFailure(serverId, ready.reason, label, opts.quiet);
    return { sent: false, reason: ready.reason, text: message };
  }

  if (message.length > MAX_LENGTH) {
    const reason = `текст длиннее ${MAX_LENGTH} символов (${message.length}) — CFTools такое не принимает`;
    noteFailure(serverId, reason, label, opts.quiet);
    return { sent: false, reason, text: message };
  }

  try {
    await cftools.broadcast(serverId, message);
    lastFailure.delete(serverId);
    logger.info(SOURCE, `В игру отправлено (${label}): ${message}`, { serverId });
    return { sent: true, text: message };
  } catch (err) {
    noteFailure(serverId, err.message, label, opts.quiet);
    return { sent: false, reason: err.message, text: message };
  }
}

/**
 * Одна и та же причина не пишется в лог повторно.
 *
 * Ключ — именно причина, а не текст записи: предупреждения о перезапуске и
 * объявления идут пачками, и выключенная интеграция иначе оставляла бы в логе
 * десяток одинаковых по смыслу строк подряд. Постоянное напоминание о проблеме
 * живёт в предупреждениях сервера на вкладке «Обзор».
 */
function noteFailure(serverId, reason, label, quiet) {
  if (lastFailure.get(serverId) === reason) return;
  lastFailure.set(serverId, reason);
  if (!quiet) logger.warn(SOURCE, `${label} не отправлено в игру: ${reason}`, { serverId });
}

/** Сбросить память о неудачах — например, после смены настроек. */
function resetFailures(serverId) {
  if (serverId) lastFailure.delete(serverId);
  else lastFailure.clear();
}

module.exports = { say, render, available, resetFailures, MAX_LENGTH };
