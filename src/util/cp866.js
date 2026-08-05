'use strict';

/**
 * Кодирование текста в CP866 — родную кодировку консоли Windows на русских
 * системах.
 *
 * Зачем это нужно. Соблазн написать .bat в UTF-8 и поставить в начале
 * `chcp 65001` заканчивается плохо: cmd.exe запоминает позицию в файле
 * в байтах и после смены кодовой страницы пересчитывает её по-новому.
 * На файле с многобайтовой кириллицей парсер теряет место и молча
 * прекращает выполнение — окно открывается, заголовок ставится, а дальше
 * не происходит ничего. Поэтому .bat-файлы пишутся сразу в CP866 и никакого
 * chcp в них нет.
 */

/** Символы вне CP866, которым есть разумная замена. */
const REPLACEMENTS = {
  '«': '"',
  '»': '"',
  '„': '"',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '—': '-',
  '–': '-',
  '−': '-',
  '…': '...',
  '✓': '+',
  '✗': 'x',
  '↑': '^',
  '→': '->',
  '←': '<-',
  '⠿': '::',
  ' ': ' '
};

/** Символы псевдографики и знаки, у которых в CP866 есть свой код. */
const DIRECT = {
  '─': 0xc4,
  '│': 0xb3,
  '═': 0xcd,
  '║': 0xba,
  '┌': 0xda,
  '┐': 0xbf,
  '└': 0xc0,
  '┘': 0xd9,
  '█': 0xdb,
  '▀': 0xdf,
  '▄': 0xdc,
  '°': 0xf8,
  '·': 0xfa,
  '№': 0xfc,
  '√': 0xfb
};

/**
 * @param {string} text
 * @returns {{buffer: Buffer, lossy: boolean, lost: string[]}}
 */
function encodeDetailed(text) {
  const source = String(text ?? '');
  const bytes = [];
  const lost = new Set();

  for (const char of source) {
    const code = char.codePointAt(0);

    // ASCII — как есть
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(REPLACEMENTS, char)) {
      for (const ascii of REPLACEMENTS[char]) bytes.push(ascii.charCodeAt(0));
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(DIRECT, char)) {
      bytes.push(DIRECT[char]);
      continue;
    }

    // Кириллица
    if (code >= 0x410 && code <= 0x42f) bytes.push(0x80 + (code - 0x410)); // А..Я
    else if (code >= 0x430 && code <= 0x43f) bytes.push(0xa0 + (code - 0x430)); // а..п
    else if (code >= 0x440 && code <= 0x44f) bytes.push(0xe0 + (code - 0x440)); // р..я
    else if (code === 0x401) bytes.push(0xf0); // Ё
    else if (code === 0x451) bytes.push(0xf1); // ё
    else {
      bytes.push(0x3f); // «?»
      lost.add(char);
    }
  }

  return { buffer: Buffer.from(bytes), lossy: lost.size > 0, lost: [...lost] };
}

/** Короткая форма: только буфер. */
const encode = (text) => encodeDetailed(text).buffer;

/** Можно ли записать строку в CP866 без потерь (например, имя папки мода). */
const canEncode = (text) => !encodeDetailed(text).lossy;

module.exports = { encode, encodeDetailed, canEncode };
