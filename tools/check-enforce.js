#!/usr/bin/env node
'use strict';

/**
 * Быстрая проверка исходников мода на конструкции, которые ломают парсер DayZ.
 *
 * Компилятор Enforce живёт только внутри игры, и любая мелочь роняет весь
 * модуль скриптов сразу: сервер пишет «Can't compile "Game" script module!» и
 * не запускается. Один такой случай уже был — литерал с экранированной кавычкой
 * («CParser: quoted string not closed»). Проверка ловит его и ещё несколько
 * известных грабель до того, как файл попадёт в PBO.
 *
 * Это не компилятор: она не проверяет типы и имена методов. Она проверяет то,
 * что можно проверить текстом.
 *
 * Использование: node tools/check-enforce.js mod/DayZPanelBridge
 */

const fs = require('fs');
const path = require('path');

/**
 * Ключевые слова Enforce, которые нельзя использовать как имя переменной.
 *
 * Список сверен по дампу ванильных скриптов DayZ: ни одно из этих слов там ни
 * разу не стоит на месте имени переменной. Из-за `event` (это модификатор
 * метода: `event protected void EOnTouch(...)` в 1_core/proto/enentity.c)
 * сборка 1.0.2 не компилировалась — «Broken expression (missing ';'?)».
 *
 * В списке только слова с прямым подтверждением: они либо встречаются в
 * ванилле как ключевые, либо ни разу — как имена. Слова «на всякий случай» тут
 * не нужны: например `spawn` выглядит служебным, но в ванилле это законное имя
 * параметра (`OnEntityYieldSpawned(EntityAI spawn)`), и запрет дал бы ложную
 * тревогу.
 */
const RESERVED = [
  'event', 'out', 'inout', 'ref', 'proto', 'native', 'typedef', 'class', 'new', 'delete', 'owned',
  'autoptr', 'notnull', 'typename', 'modded'
];

/** Модификаторы, которые могут стоять перед типом в объявлении. */
const MODIFIERS = 'private|protected|static|const|ref|autoptr|override|proto|native|volatile|notnull|out|inout';

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else if (entry.name.endsWith('.c')) files.push(full);
  }
  return files;
}

/**
 * Разбор строки кода так, как это делает лексер движка: escape-последовательности
 * внутри строковых литералов НЕ поддерживаются надёжно, поэтому любая кавычка
 * закрывает литерал. Именно из-за этого «\"» и ломает разбор файла.
 */
function scanLine(line) {
  const problems = [];

  // Комментарии до анализа кавычек: в них может быть что угодно.
  const code = line.replace(/\/\/.*$/, '');

  const escapes = code.match(/\\["\\]/g);
  if (escapes) {
    problems.push(
      `экранирование ${escapes.join(' ')} в строковом литерале — парсер Enforce обрывает на нём файл; ` +
        'соберите символ через int.AsciiToString() (см. PanelJson)'
    );
  }

  const quotes = (code.match(/"/g) || []).length;
  if (quotes % 2 !== 0) problems.push('нечётное число кавычек — литерал не закрыт');


  /*
   * Ключевое слово на месте имени. Два надёжных признака:
   *   1) объявление «<тип> слово» — тип может быть встроенным, шаблонным или
   *      именем класса, перед ним допустимы модификаторы;
   *   2) использование «слово = …», «слово += …», «слово.Метод()».
   * Само ключевое слово в роли типа (`ref array<int> x`, `modded class Foo`)
   * под правило не попадает: тогда «типом» оказывается другое ключевое слово.
   */
  for (const word of RESERVED) {
    // За именем переменной идёт «=», «;», «,», «)» или «[». Если за словом стоит
    // другой идентификатор — это не имя, а модификатор типа (`static ref map<…> m_X`).
    const declaration = new RegExp(
      `(?:^|[;{}(,])\\s*(?:(?:${MODIFIERS})\\s+)*([A-Za-z_]\\w*(?:<[^>]*>)?)\\s+${word}\\s*(?:[=;,)[]|$)`
    );
    const match = code.match(declaration);
    if (match && !RESERVED.includes(match[1]) && !new RegExp(`^(?:${MODIFIERS})$`).test(match[1])) {
      problems.push(`«${word}» — ключевое слово Enforce, так называть переменную нельзя`);
      continue;
    }

    const usage = new RegExp(`^\\s*${word}\\s*(?:=[^=]|\\+=|-=|\\.[A-Za-z_])`);
    if (usage.test(code)) {
      problems.push(`«${word}» используется как переменная, но это ключевое слово Enforce`);
    }
  }

  return problems;
}

/**
 * Имена классов и enum из ванильных скриптов DayZ.
 *
 * Нужны для проверки столкновений: если метод мода назван как ванильный класс,
 * вызов уходит в конструктор этого класса. Так сборка 1.0.3 не компилировалась —
 * метод `Inventory()` против класса `Inventory: LayoutHolder`:
 * «Types 'PanelCommandArgs' and 'LayoutHolder' are unrelated».
 *
 * Дамп скриптов есть не всегда, поэтому проверка необязательная: путь передаётся
 * вторым аргументом или переменной окружения DAYZ_SCRIPTS.
 */
function vanillaNames(dir) {
  const names = new Set();
  if (!dir || !fs.existsSync(dir)) return names;

  for (const file of collect(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*(?:modded\s+)?(?:class|enum)\s+([A-Za-z_]\w*)/gm)) {
      names.add(match[1]);
    }
  }
  return names;
}

/** Объявления методов в файле: [строка, имя]. */
function methodsOf(text) {
  const found = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  const declaration = /^\s*(?:(?:static|private|protected|override|ref)\s+)*[A-Za-z_][\w<>,\s]*?\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:\{|$)/gm;

  for (const match of code.matchAll(declaration)) {
    // Совпадение может начаться строкой выше (перед типом стоит перевод строки),
    // поэтому строку считаем по позиции самого имени, а не начала совпадения.
    const at = match.index + match[0].lastIndexOf(match[1]);
    found.push([code.slice(0, at).split('\n').length, match[1]]);
  }
  return found;
}

function checkFile(file, vanilla = new Set()) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const problems = [];

  lines.forEach((line, index) => {
    for (const problem of scanLine(line)) {
      problems.push({ line: index + 1, text: line.trim().slice(0, 90), problem });
    }
  });

  /*
   * Многострочный вызов, у которого закрывающая скобка стоит на отдельной
   * строке: во всех ванильных скриптах последний аргумент перед такой скобкой
   * заканчивается запятой. Без неё парсер считает вызов законченным и ругается
   * «Invalid statement ')'» — именно это уронило сборку 1.0.1.
   */
  lines.forEach((line, index) => {
    if (!/^\s*\)/.test(line)) return;

    let previous = '';
    for (let i = index - 1; i >= 0; i--) {
      const candidate = lines[i].replace(/\/\/.*$/, '').trimEnd();
      if (candidate.trim() === '') continue;
      previous = candidate;
      break;
    }

    // Открывающая скобка на предыдущей строке — аргументов нет вовсе, это норма.
    if (!previous || previous.endsWith(',') || previous.endsWith('(')) return;

    problems.push({
      line: index + 1,
      text: lines[index].trim().slice(0, 90),
      problem:
        'закрывающая скобка на отдельной строке, а последний аргумент выше не заканчивается запятой — ' +
        'парсер Enforce даёт «Invalid statement». Поставьте запятую или соберите вызов в одну строку'
    });
  });

  // Баланс фигурных скобок по файлу целиком: пропущенная скобка даёт ошибку
  // компиляции в совершенно другом месте, и искать её потом тяжело.
  const withoutStrings = text.replace(/"[^"\n]*"/g, '""').replace(/\/\/.*$/gm, '');
  const open = (withoutStrings.match(/\{/g) || []).length;
  const close = (withoutStrings.match(/\}/g) || []).length;
  if (open !== close) {
    problems.push({ line: 0, text: '', problem: `скобки не сходятся: { ${open}, } ${close}` });
  }

  // Метод, названный как ванильный класс: вызов уйдёт в конструктор этого класса.
  if (vanilla.size) {
    const own = new Set(
      [...text.matchAll(/^\s*(?:modded\s+)?class\s+([A-Za-z_]\w*)/gm)].map((match) => match[1])
    );

    for (const [line, name] of methodsOf(text)) {
      if (own.has(name) || !vanilla.has(name)) continue;
      problems.push({
        line,
        text: '',
        problem:
          `метод ${name}() назван как ванильный класс ${name} — вызов уйдёт в его конструктор ` +
          '(«Types ... are unrelated»). Переименуйте метод'
      });
    }
  }

  return problems;
}

function main() {
  const root = process.argv[2] || 'mod/DayZPanelBridge';
  const scriptsDir = process.argv[3] || process.env.DAYZ_SCRIPTS || '';
  const vanilla = vanillaNames(scriptsDir);
  const files = collect(root);
  let bad = 0;

  console.log(
    vanilla.size
      ? `Имён ванильных классов для сверки: ${vanilla.size} (${scriptsDir})`
      : 'Дамп ванильных скриптов не указан — проверка столкновений имён пропущена ' +
        '(передайте путь вторым аргументом или в DAYZ_SCRIPTS)'
  );

  for (const file of files) {
    const problems = checkFile(file, vanilla);
    if (!problems.length) continue;

    bad += problems.length;
    console.log(`\n${file}`);
    for (const item of problems) {
      console.log(`  ${item.line ? `строка ${item.line}` : 'файл'}: ${item.problem}`);
      if (item.text) console.log(`    ${item.text}`);
    }
  }

  console.log(`\nПроверено файлов: ${files.length}. Проблем: ${bad}.`);
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();

module.exports = { checkFile, scanLine };
