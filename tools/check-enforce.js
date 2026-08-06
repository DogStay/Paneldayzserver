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

/** Ключевые слова Enforce, которые нельзя использовать как имя переменной. */
const RESERVED = ['out', 'inout', 'ref', 'proto', 'native', 'typedef', 'class', 'new', 'delete', 'owned'];

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


  for (const word of RESERVED) {
    const re = new RegExp(`\\b(string|int|float|bool|vector|auto)\\s+${word}\\b`);
    if (re.test(code)) problems.push(`«${word}» — ключевое слово Enforce, так называть переменную нельзя`);
  }

  return problems;
}

function checkFile(file) {
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

  return problems;
}

function main() {
  const root = process.argv[2] || 'mod/DayZPanelBridge';
  const files = collect(root);
  let bad = 0;

  for (const file of files) {
    const problems = checkFile(file);
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
