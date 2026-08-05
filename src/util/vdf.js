'use strict';

/**
 * Минимальный парсер Valve KeyValues (VDF/ACF).
 *
 * Нужен для чтения steamapps/workshop/appworkshop_221100.acf — оттуда панель
 * узнаёт установленную версию каждого мода (manifest / timeupdated) и сравнивает
 * её с той, что SteamCMD видит на стороне Steam.
 *
 * Формат:
 *   "AppWorkshop"
 *   {
 *       "appid"    "221100"
 *       "WorkshopItemsInstalled"
 *       {
 *           "1559212036"  {  "manifest" "..."  "timeupdated" "1700000000"  }
 *       }
 *   }
 */

function parse(text) {
  const tokens = tokenize(text);
  let pos = 0;

  function parseObject() {
    const obj = {};
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token === '}') {
        pos++;
        return obj;
      }
      pos++; // сам ключ
      const next = tokens[pos];
      if (next === '{') {
        pos++;
        obj[token] = parseObject();
      } else {
        pos++;
        obj[token] = next === undefined ? '' : next;
      }
    }
    return obj;
  }

  const root = {};
  while (pos < tokens.length) {
    const key = tokens[pos++];
    if (key === '}' || key === undefined) continue;
    if (tokens[pos] === '{') {
      pos++;
      root[key] = parseObject();
    } else {
      root[key] = tokens[pos++] ?? '';
    }
  }
  return root;
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (ch === '"') {
      i++;
      let value = '';
      while (i < len && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < len) {
          const escaped = text[i + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          i += 2;
          continue;
        }
        value += text[i++];
      }
      i++; // закрывающая кавычка
      tokens.push(value);
      continue;
    }

    if (ch === '{' || ch === '}') {
      tokens.push(ch);
      i++;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Токен без кавычек (в .acf встречается редко, но бывает).
    let value = '';
    while (i < len && !/[\s{}"]/.test(text[i])) value += text[i++];
    if (value) tokens.push(value);
  }

  return tokens;
}

/* ------------------------------------------------- правка текста .acf */

/**
 * Вырезать запись `"<key>" { … }` (или `"<key>" "значение"`) из секции файла.
 *
 * Работаем по тексту, а не по разобранному дереву: файл состояния SteamCMD
 * принадлежит Steam, и переписывать его целиком из своего парсера рискованно —
 * потеряются поля, о которых панель не знает. Точечный вырез сохраняет всё
 * остальное байт в байт.
 *
 * @param {string} text содержимое .acf
 * @param {string} section имя секции, например WorkshopItemsInstalled
 * @param {string} key ключ внутри секции (Workshop ID)
 * @returns {{text: string, removed: boolean}}
 */
function removeKeyBlock(text, section, key) {
  const sectionRe = new RegExp(`"${escapeRe(section)}"\\s*\\r?\\n?\\s*\\{`, 'i');
  const found = text.match(sectionRe);
  if (!found) return { text, removed: false };

  const bodyStart = found.index + found[0].length;
  const bodyEnd = matchingBrace(text, bodyStart);
  if (bodyEnd < 0) return { text, removed: false };

  const keyRe = new RegExp(`(^|\\r?\\n)([ \\t]*)"${escapeRe(key)}"`, 'g');
  keyRe.lastIndex = 0;

  let match;
  while ((match = keyRe.exec(text)) !== null) {
    const keyStart = match.index + match[1].length;
    if (keyStart < bodyStart) continue;
    if (keyStart >= bodyEnd) break;

    // За ключом идёт либо вложенный блок, либо значение в кавычках.
    let cursor = keyRe.lastIndex;
    while (cursor < bodyEnd && /[ \t\r\n]/.test(text[cursor])) cursor++;

    let end;
    if (text[cursor] === '{') {
      const close = matchingBrace(text, cursor + 1);
      if (close < 0) return { text, removed: false };
      end = close + 1;
    } else if (text[cursor] === '"') {
      const close = text.indexOf('"', cursor + 1);
      if (close < 0 || close > bodyEnd) return { text, removed: false };
      end = close + 1;
    } else {
      return { text, removed: false };
    }

    // Забираем перевод строки после записи, чтобы не оставлять пустых строк.
    while (end < text.length && /[ \t]/.test(text[end])) end++;
    if (text[end] === '\r') end++;
    if (text[end] === '\n') end++;

    return { text: text.slice(0, keyStart) + text.slice(end), removed: true };
  }

  return { text, removed: false };
}

/**
 * Индекс закрывающей `}` для блока, тело которого начинается с `from`.
 * Фигурные скобки внутри кавычек не считаются.
 */
function matchingBrace(text, from) {
  let depth = 1;
  let inString = false;

  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Первое значение по имени ключа на любой глубине (регистронезависимо). */
function findSection(obj, name) {
  const target = String(name).toLowerCase();
  if (!obj || typeof obj !== 'object') return null;
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === target) return value;
    if (value && typeof value === 'object') {
      const found = findSection(value, name);
      if (found) return found;
    }
  }
  return null;
}

module.exports = { parse, findSection, removeKeyBlock };
