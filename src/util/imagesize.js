'use strict';

/**
 * Размеры картинки по её заголовку — без сторонних библиотек.
 *
 * Нужно ровно для одного: подложка карты должна быть квадратной, потому что
 * мир DayZ квадратный. Если админ загрузит скриншот с рамками, метки игроков
 * поедут, и об этом лучше предупредить сразу, а не выяснять по кривым меткам.
 *
 * Поддержаны PNG, JPEG и WebP (VP8/VP8L/VP8X) — это всё, что панель принимает.
 */

function png(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;

  return { type: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * JPEG: идём по маркерам до кадрового (SOF0…SOF3, SOF5…SOF7, SOF9…SOF11),
 * в нём и лежат размеры. Просто «взять из начала файла» нельзя: перед кадром
 * бывает EXIF с превью на десятки килобайт.
 */
function jpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let at = 2;
  while (at + 9 < buffer.length) {
    if (buffer[at] !== 0xff) {
      at++;
      continue;
    }

    const marker = buffer[at + 1];
    const length = buffer.readUInt16BE(at + 2);

    const isFrame =
      (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb);

    if (isFrame) {
      return { type: 'image/jpeg', height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
    }

    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function webp(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buffer.slice(8, 12).toString('ascii') !== 'WEBP') return null;

  const kind = buffer.slice(12, 16).toString('ascii');

  if (kind === 'VP8 ') {
    return {
      type: 'image/webp',
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }

  if (kind === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }

  if (kind === 'VP8X') {
    const width = buffer[24] | (buffer[25] << 8) | (buffer[26] << 16);
    const height = buffer[27] | (buffer[28] << 8) | (buffer[29] << 16);
    return { type: 'image/webp', width: width + 1, height: height + 1 };
  }

  return null;
}

/**
 * @param {Buffer} buffer первые килобайты файла или файл целиком
 * @returns {{type: string, width: number, height: number}|null}
 */
function imageSize(buffer) {
  if (!buffer || !buffer.length) return null;
  return png(buffer) || jpeg(buffer) || webp(buffer) || null;
}

module.exports = { imageSize };
