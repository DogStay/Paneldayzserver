'use strict';

/**
 * Отправка текста игрокам в игру.
 *
 * Каналов два, и выбор за админом (настройка ingame.channel):
 *
 *   battleye — RCon-порт BattlEye, команда `say -1`. Работает у любого сервера
 *              DayZ и ничего не стоит; ровно так пишут в чат BEC и подобные
 *              инструменты. Требует пароль RCon в beserver_x64.cfg.
 *   cftools  — сообщение через CFTools Cloud. Удобно, если CFTools уже
 *              подключён, но отправка сообщений в игру у них доступна только
 *              на платной подписке.
 *   auto     — по умолчанию: BattlEye, если он настроен, иначе CFTools.
 *              Так панель пишет в чат «из коробки», без платных подписок.
 *
 * Предупреждения о перезапуске и периодические объявления зовут одну функцию
 * say() и не знают, чем именно доставляется текст. Появится третий канал —
 * менять придётся только этот файл.
 */

const config = require('../config');
const logger = require('../logger');
const cftools = require('./cftools');
const battleye = require('./battleye');

const SOURCE = 'ingame';

/**
 * Самое строгое из ограничений каналов: у BattlEye чат обрезает длинные
 * строки, у CFTools лимит 256 символов. Точный предел выбранного канала
 * отдаёт available().
 */
const MAX_LENGTH = battleye.MAX_LENGTH;

/**
 * Последняя причина недоставки по каждому серверу: одна и та же проблема
 * (выключенная интеграция, отсутствие связи) повторяется каждые несколько
 * минут, и лог из неё превратился бы в кашу.
 */
const lastFailure = new Map();

/** Выбранный админом канал: auto | battleye | cftools | off. */
function channelOf(serverId) {
  try {
    return config.active(serverId).ingame.channel;
  } catch (_) {
    return 'auto';
  }
}

/** Готовность CFTools как канала сообщений. */
function cftoolsReady(serverId) {
  let status;
  try {
    status = cftools.status(serverId);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  if (!status.enabled) {
    return { ok: false, reason: 'интеграция с CFTools выключена (включается в настройках сервера)' };
  }
  if (!status.hasApplicationId || !status.hasSecret) {
    return { ok: false, reason: 'в настройках CFTools не заполнены Application ID и Secret' };
  }
  if (!status.serverApiId) {
    return { ok: false, reason: 'в настройках CFTools не указан Server API ID этого сервера' };
  }

  return { ok: true, reason: '' };
}

/** Готовность BattlEye RCon как канала сообщений. */
function battleyeReady(serverId) {
  let status;
  try {
    status = battleye.status(serverId);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: Boolean(status.ready), reason: status.reason || '' };
}

/**
 * Можно ли сейчас писать в игру и каким каналом — без обращения к сети.
 * @returns {{ok: boolean, channel: string, reason: string, maxLength: number}}
 */
function available(serverId) {
  const channel = channelOf(serverId);
  const be = battleyeReady(serverId);
  const cf = cftoolsReady(serverId);

  const describe = (name, ready) => ({
    ok: ready.ok,
    channel: name,
    reason: ready.ok ? '' : `${name === 'battleye' ? 'BattlEye RCon' : 'CFTools'}: ${ready.reason}`,
    maxLength: name === 'battleye' ? battleye.MAX_LENGTH : cftools.MAX_MESSAGE_LENGTH
  });

  if (channel === 'off') {
    return { ok: false, channel: 'off', reason: 'сообщения в игру отключены в настройках сервера', maxLength: MAX_LENGTH };
  }
  if (channel === 'battleye') return describe('battleye', be);
  if (channel === 'cftools') return describe('cftools', cf);

  // auto: сначала бесплатный BattlEye, потом CFTools.
  if (be.ok) return describe('battleye', be);
  if (cf.ok) return describe('cftools', cf);

  return {
    ok: false,
    channel: 'auto',
    reason:
      `ни один канал не готов. BattlEye RCon: ${be.reason}. CFTools: ${cf.reason}. ` +
      'Проще всего настроить BattlEye — он есть у любого сервера DayZ и не требует подписки',
    maxLength: MAX_LENGTH
  };
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
    return { sent: false, reason: ready.reason, text: message, channel: ready.channel };
  }

  if (message.length > ready.maxLength) {
    const reason =
      `текст длиннее ${ready.maxLength} символов (${message.length}) — ` +
      `${ready.channel === 'battleye' ? 'в чате он обрежется' : 'CFTools такое не принимает'}`;
    noteFailure(serverId, reason, label, opts.quiet);
    return { sent: false, reason, text: message, channel: ready.channel };
  }

  try {
    if (ready.channel === 'battleye') await battleye.say(serverId, message);
    else await cftools.broadcast(serverId, message);

    lastFailure.delete(serverId);
    logger.info(SOURCE, `В игру отправлено через ${channelName(ready.channel)} (${label}): ${message}`, {
      serverId
    });
    return { sent: true, text: message, channel: ready.channel };
  } catch (err) {
    noteFailure(serverId, err.message, label, opts.quiet);
    return { sent: false, reason: err.message, text: message, channel: ready.channel };
  }
}

const channelName = (channel) => (channel === 'battleye' ? 'BattlEye RCon' : 'CFTools');

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

module.exports = { say, render, available, resetFailures, channelName, MAX_LENGTH };
