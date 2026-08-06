#!/usr/bin/env node
'use strict';

/**
 * Упаковка и проверка PBO — формата addon-архивов движка Enfusion/Real Virtuality.
 *
 * Нужен, чтобы собрать мод-мост без DayZ Tools: у них Windows-only GUI, а
 * скриптовому моду бинаризация не требуется — движок читает .c и config.cpp из
 * PBO как есть. Так панель может отдать готовый мод сразу.
 *
 * Формат (все числа — 4 байта little-endian):
 *
 *   [запись свойств]  имя = "" (0), тип = "Vers" (0x56657273), четыре нуля,
 *                     затем пары «ключ\0значение\0», затем один нулевой байт
 *   [записи файлов]   имя\0, тип = 0, исходный размер, резерв, время, размер
 *   [пустая запись]   имя = "" (0) и пять нулей — конец оглавления
 *   [данные файлов]   в том же порядке, что записи
 *   [контрольная сумма] нулевой байт + SHA1 от всего, что выше
 *
 * Использование:
 *   node tools/pack-pbo.js <папка-источника> <файл.pbo> [префикс]
 *   node tools/pack-pbo.js --verify <файл.pbo>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME_VERS = 0x56657273;
const MIME_BLANK = 0x00000000;

/* --------------------------------------------------------------- упаковка */

/** Все файлы папки, отсортированные так, как ожидает движок. */
function collect(root) {
  const files = [];

  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Служебное в PBO не кладём: оно только раздувает мод.
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}\\${entry.name}` : entry.name;

      if (entry.isDirectory()) walk(full, relative);
      else files.push({ name: relative, path: full, size: fs.statSync(full).size });
    }
  };

  walk(root, '');

  // Движок ожидает оглавление, упорядоченное по имени без учёта регистра.
  files.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return files;
}

function cstring(text) {
  return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
}

/** Запись оглавления: имя, тип, исходный размер, резерв, время, размер. */
function header(name, mime, original, timestamp, size) {
  const numbers = Buffer.alloc(20);
  numbers.writeUInt32LE(mime, 0);
  numbers.writeUInt32LE(original, 4);
  numbers.writeUInt32LE(0, 8); // резерв, всегда ноль
  numbers.writeUInt32LE(timestamp, 12);
  numbers.writeUInt32LE(size, 16);
  return Buffer.concat([cstring(name), numbers]);
}

function pack(sourceDir, target, prefix) {
  const files = collect(sourceDir);
  if (!files.length) throw new Error(`В ${sourceDir} нет файлов для упаковки`);

  const timestamp = Math.floor(Date.now() / 1000);
  const parts = [];

  // Свойства: префикс обязателен — по нему движок понимает, куда «монтируется»
  // содержимое PBO (пути в config.cpp считаются от него).
  parts.push(header('', MIME_VERS, 0, 0, 0));
  parts.push(cstring('prefix'), cstring(prefix));
  parts.push(cstring('version'), cstring('1.0.0'));
  parts.push(Buffer.from([0]));

  for (const file of files) {
    parts.push(header(file.name, MIME_BLANK, file.size, timestamp, file.size));
  }
  parts.push(header('', MIME_BLANK, 0, 0, 0));

  const head = Buffer.concat(parts);
  const data = files.map((file) => fs.readFileSync(file.path));

  const body = Buffer.concat([head, ...data]);
  const checksum = crypto.createHash('sha1').update(body).digest();

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat([body, Buffer.from([0]), checksum]));

  return { target, files, bytes: body.length + 21, checksum: checksum.toString('hex') };
}

/* --------------------------------------------------------------- проверка */

/**
 * Читаем собранный PBO обратно тем же кодом, каким его читал бы движок:
 * оглавление, размеры, порядок данных и контрольную сумму. Без этого
 * «упаковщик, написанный по описанию формата» — просто надежда.
 */
function verify(file) {
  const buffer = fs.readFileSync(file);
  let offset = 0;

  const readCString = () => {
    const end = buffer.indexOf(0, offset);
    if (end < 0) throw new Error('оглавление обрывается на середине имени');
    const text = buffer.subarray(offset, end).toString('utf8');
    offset = end + 1;
    return text;
  };

  const readEntry = () => {
    const name = readCString();
    const mime = buffer.readUInt32LE(offset);
    const original = buffer.readUInt32LE(offset + 4);
    const reserved = buffer.readUInt32LE(offset + 8);
    const timestamp = buffer.readUInt32LE(offset + 12);
    const size = buffer.readUInt32LE(offset + 16);
    offset += 20;
    return { name, mime, original, reserved, timestamp, size };
  };

  const first = readEntry();
  const properties = {};

  if (first.mime === MIME_VERS) {
    for (;;) {
      const key = readCString();
      if (key === '') break;
      properties[key] = readCString();
    }
  } else {
    throw new Error('первая запись не Vers — движок такой PBO не примет');
  }

  const entries = [];
  for (;;) {
    const entry = readEntry();
    if (entry.name === '' && entry.size === 0) break;
    entries.push(entry);
  }

  const dataStart = offset;
  let cursor = dataStart;
  for (const entry of entries) {
    entry.offset = cursor;
    cursor += entry.size;
  }

  const checksumOffset = cursor;
  if (buffer[checksumOffset] !== 0) throw new Error('перед контрольной суммой нет нулевого байта');

  const stored = buffer.subarray(checksumOffset + 1, checksumOffset + 21);
  const computed = crypto.createHash('sha1').update(buffer.subarray(0, checksumOffset)).digest();

  if (!stored.equals(computed)) {
    throw new Error(`контрольная сумма не сходится: в файле ${stored.toString('hex')}, посчитано ${computed.toString('hex')}`);
  }
  if (buffer.length !== checksumOffset + 21) {
    throw new Error(`лишние ${buffer.length - checksumOffset - 21} байт после контрольной суммы`);
  }

  return { properties, entries, checksum: computed.toString('hex'), bytes: buffer.length };
}

/* ------------------------------------------------------------------- CLI */

function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--verify') {
    const info = verify(args[1]);
    console.log(`PBO в порядке: ${args[1]}`);
    console.log(`  свойства: ${JSON.stringify(info.properties)}`);
    console.log(`  файлов: ${info.entries.length}, размер ${info.bytes} байт`);
    console.log(`  SHA1: ${info.checksum}`);
    for (const entry of info.entries) console.log(`   - ${entry.name} (${entry.size} б)`);
    return;
  }

  const [source, target, prefix] = args;
  if (!source || !target) {
    console.error('Использование: node tools/pack-pbo.js <папка> <файл.pbo> [префикс]');
    process.exit(1);
  }

  const result = pack(source, target, prefix || path.basename(source));
  console.log(`Собран ${result.target}: файлов ${result.files.length}, ${result.bytes} байт`);

  // Сразу читаем обратно: битый PBO лучше поймать здесь, а не на сервере.
  verify(result.target);
  console.log('Проверка обратным чтением пройдена');
}

if (require.main === module) main();

module.exports = { pack, verify };
