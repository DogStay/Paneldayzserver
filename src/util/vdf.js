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

module.exports = { parse, findSection };
