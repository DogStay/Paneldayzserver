'use strict';

/**
 * Клиент BattlEye RCon (протокол BERCon) — на нём работают BEC, DaRT и другие
 * привычные админам инструменты DayZ.
 *
 * Это единственный бесплатный способ написать игрокам в чат: у CFTools
 * сообщения в игру доступны только на платной подписке, а BattlEye слушает
 * RCon-порт у любого сервера DayZ.
 *
 * Формат пакета (UDP):
 *
 *   'B' 'E' | CRC32 (4 байта, little-endian) | 0xFF | тип | данные
 *            └─ считается по байтам, начиная с 0xFF
 *
 *   тип 0x00 — вход: данные = пароль RCon.
 *              Ответ: 0xFF 0x00 0x01 — принят, 0xFF 0x00 0x00 — отказ.
 *   тип 0x01 — команда: данные = <номер> <команда>.
 *              Ответ: 0xFF 0x01 <номер> [текст]. Длинный ответ приходит
 *              частями: 0xFF 0x01 <номер> 0x00 <всего> <номер части> <текст>.
 *   тип 0x02 — сообщение от сервера (игровые события). Его обязательно нужно
 *              подтвердить: 0xFF 0x02 <номер>, иначе BattlEye повторяет.
 *
 * Соединение живёт недолго: панель подключается, выполняет команду и
 * отключается. Так не нужен keepalive-таймер (BattlEye разрывает связь после
 * 45 секунд тишины), а состояние не переживает перезапуск сервера.
 */

const dgram = require('dgram');

/** Таблица CRC32 (тот же полином, что в zlib). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Собрать пакет BERCon. */
function build(type, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([0xff, type]), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(body), 0);
  return Buffer.concat([Buffer.from('BE', 'ascii'), crc, body]);
}

/* ------------------------------------------------------------- кодировки */

/**
 * Кириллица в CP1251 — на случай, если сервер показывает русский текст
 * «кракозябрами». По умолчанию отправляем UTF-8: движок DayZ работает с
 * юникодом, и обычно этого достаточно.
 */
function encodeCommand(text, encoding) {
  if (encoding !== 'cp1251') return Buffer.from(text, 'utf8');

  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code < 0x80) out[i] = code;
    else if (code === 0x401) out[i] = 0xa8; // Ё
    else if (code === 0x451) out[i] = 0xb8; // ё
    else if (code >= 0x410 && code <= 0x44f) out[i] = code - 0x410 + 0xc0; // А-я
    else out[i] = 0x3f; // «?» вместо символа, которого в CP1251 нет
  }
  return out;
}

/* ------------------------------------------------------------- соединение */

/**
 * Подключиться и войти по паролю RCon.
 *
 * @param {{host?: string, port: number, password: string, timeoutMs?: number,
 *          encoding?: 'utf8'|'cp1251'}} opts
 * @returns {Promise<{command: (cmd: string) => Promise<string>, close: () => void}>}
 */
function connect(opts) {
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port);
  const timeoutMs = opts.timeoutMs || 5000;
  const encoding = opts.encoding === 'cp1251' ? 'cp1251' : 'utf8';

  if (!port) return Promise.reject(new Error('Не указан RCon-порт BattlEye'));
  if (!opts.password) return Promise.reject(new Error('Не указан пароль RCon (RConPassword)'));

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    /** Ожидающие ответа команды: номер -> { resolve, reject, parts } */
    const pending = new Map();
    let sequence = 0;
    let closed = false;
    let loginTimer = null;

    const fail = (err) => {
      if (closed) return;
      cleanup();
      reject(err);
    };

    function cleanup() {
      closed = true;
      if (loginTimer) clearTimeout(loginTimer);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Соединение с BattlEye закрыто до получения ответа'));
      }
      pending.clear();
      try {
        socket.close();
      } catch (_) {
        /* уже закрыт */
      }
    }

    socket.on('error', (err) => fail(new Error(`Ошибка сети при обращении к BattlEye: ${err.message}`)));

    socket.on('message', (msg) => {
      // Минимальный пакет: 'BE' + CRC(4) + 0xFF + тип
      if (msg.length < 8 || msg[0] !== 0x42 || msg[1] !== 0x45 || msg[6] !== 0xff) return;

      const type = msg[7];
      const data = msg.subarray(8);

      if (type === 0x00) {
        if (loginTimer) clearTimeout(loginTimer);
        if (data[0] === 0x01) return resolve({ command, close });

        // Неверный пароль. Дальше пробовать нельзя: BattlEye блокирует IP
        // после нескольких неудачных входов — об этом знает вызывающий код.
        const err = new Error('BattlEye отклонил пароль RCon');
        err.code = 'bad-password';
        return fail(err);
      }

      if (type === 0x01) return onCommandReply(data);

      if (type === 0x02) {
        // Игровое событие: подтверждаем получение и игнорируем — панель читает
        // события из логов сервера, а не отсюда.
        const seq = data[0];
        socket.send(build(0x02, Buffer.from([seq])), port, host, () => {});
      }
    });

    function onCommandReply(data) {
      const seq = data[0];
      const entry = pending.get(seq);
      if (!entry) return;

      let text;
      // Многочастный ответ: 0x00 <всего> <номер части> <текст>
      if (data.length >= 4 && data[1] === 0x00) {
        const total = data[2];
        const index = data[3];
        entry.parts[index] = data.subarray(4).toString('utf8');

        const collected = entry.parts.filter((part) => part !== undefined).length;
        if (collected < total) return; // ждём остальные части
        text = entry.parts.join('');
      } else {
        text = data.subarray(1).toString('utf8');
      }

      clearTimeout(entry.timer);
      pending.delete(seq);
      entry.resolve(text);
    }

    /**
     * Выполнить RCon-команду. Например: `say -1 текст`, `players`, `#shutdown`.
     * @returns {Promise<string>} текст ответа сервера (часто пустой)
     */
    function command(cmd) {
      if (closed) return Promise.reject(new Error('Соединение с BattlEye уже закрыто'));

      return new Promise((res, rej) => {
        const seq = sequence;
        sequence = (sequence + 1) % 256;

        const timer = setTimeout(() => {
          pending.delete(seq);
          rej(new Error(`BattlEye не ответил на команду за ${Math.round(timeoutMs / 1000)} с`));
        }, timeoutMs);

        pending.set(seq, { resolve: res, reject: rej, timer, parts: [] });

        const payload = Buffer.concat([Buffer.from([seq]), encodeCommand(cmd, encoding)]);
        socket.send(build(0x01, payload), port, host, (err) => {
          if (!err) return;
          clearTimeout(timer);
          pending.delete(seq);
          rej(new Error(`Не удалось отправить команду BattlEye: ${err.message}`));
        });
      });
    }

    function close() {
      if (!closed) cleanup();
    }

    // Вход. Ответа может не быть вовсе — если сервер остановлен или порт другой.
    loginTimer = setTimeout(() => {
      const err = new Error(
        `BattlEye не ответил за ${Math.round(timeoutMs / 1000)} с (${host}:${port}). ` +
          'Обычно это значит, что сервер не запущен или RCon-порт указан неверно.'
      );
      err.code = 'no-answer';
      fail(err);
    }, timeoutMs);

    socket.send(build(0x00, Buffer.from(opts.password, 'utf8')), port, host, (err) => {
      if (err) fail(new Error(`Не удалось отправить пакет BattlEye: ${err.message}`));
    });
  });
}

/**
 * Подключиться, выполнить команды и отключиться.
 * @param {object} opts то же, что у connect()
 * @param {(command: (cmd: string) => Promise<string>) => Promise<any>} fn
 */
async function withConnection(opts, fn) {
  const session = await connect(opts);
  try {
    return await fn(session.command);
  } finally {
    session.close();
  }
}

module.exports = { connect, withConnection, build, crc32, encodeCommand };
