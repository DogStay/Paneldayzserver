/**
 * Нижняя консоль: живой лог панели, SteamCMD и самого сервера.
 *
 * Свёрнута по умолчанию — в свёрнутом виде показывает последнюю строку,
 * чтобы было видно, что происходит, не открывая панель целиком.
 */

import { api } from './api.js';
import { on } from './store.js';
import { $, el, esc, icon, toast } from './ui.js';

const MAX_NODES = 2000;

let view = null;
let dock = null;
let autoscroll = true;
let filterSource = '';
let filterText = '';

export function initConsole() {
  dock = el(`
    <div class="console-dock" id="console-dock">
      <div class="console-bar" id="console-bar">
        <span class="live">${icon('terminal')} Консоль</span>
        <span class="badge" id="console-state">подключение…</span>
        <span class="last" id="console-last"></span>
        <span class="chev">${icon('chevron')}</span>
      </div>
      <div class="console-body">
        <div class="console-tools">
          <select id="console-filter" title="Источник сообщений">
            <option value="">все источники</option>
            <option value="server">сервер</option>
            <option value="steamcmd">SteamCMD</option>
            <option value="mods">моды</option>
            <option value="install">установка</option>
            <option value="firewall">брандмауэр</option>
            <option value="workshop">Workshop</option>
            <option value="bat">.bat</option>
            <option value="servercfg">serverDZ.cfg</option>
            <option value="panel">панель</option>
          </select>
          <input type="search" id="console-search" placeholder="Поиск по строкам…">
          <label class="check"><input type="checkbox" id="console-autoscroll" checked><span class="box"></span>
            <span class="small">автопрокрутка</span></label>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="console-clear">${icon('trash')} Очистить</button>
        </div>
        <div class="log-view" id="log-view"></div>
      </div>
    </div>`);

  document.body.appendChild(dock);
  view = $('#log-view', dock);

  $('#console-bar', dock).addEventListener('click', () => dock.classList.toggle('open'));

  $('#console-filter', dock).addEventListener('change', (e) => {
    filterSource = e.target.value;
    applyFilter();
  });

  $('#console-search', dock).addEventListener('input', (e) => {
    filterText = e.target.value.trim().toLowerCase();
    applyFilter();
  });

  $('#console-autoscroll', dock).addEventListener('change', (e) => {
    autoscroll = e.target.checked;
    if (autoscroll) scroll();
  });

  $('#console-clear', dock).addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.clearLogs();
    view.innerHTML = '';
    toast('Лог очищен', 'ok', 2000);
  });

  on('backlog', (entries) => {
    view.innerHTML = '';
    entries.forEach(append);
    scroll();
  });

  on('log', (entry) => {
    append(entry);
    scroll();
  });

  on('connection', (connected) => {
    const badge = $('#console-state', dock);
    badge.textContent = connected ? 'подключено' : 'переподключение…';
    badge.className = `badge ${connected ? 'ok' : 'warn'}`;
  });
}

/** Развернуть консоль программно (например, при старте сервера). */
export function openConsole() {
  if (dock) dock.classList.add('open');
}

function append(entry) {
  const node = el(`
    <div class="log-line ${entry.level}" data-source="${esc(entry.source)}">
      <span class="t">${new Date(entry.ts).toLocaleTimeString('ru-RU')}</span>
      <span class="s ${esc(entry.source)}">${esc(entry.source)}</span>
      <span class="m"></span>
    </div>`);

  node.querySelector('.m').textContent = entry.message;
  node.dataset.text = entry.message.toLowerCase();
  if (!matches(node)) node.style.display = 'none';

  view.appendChild(node);
  while (view.childElementCount > MAX_NODES) view.removeChild(view.firstChild);

  const last = $('#console-last', dock);
  if (last) last.textContent = `${entry.source}: ${entry.message}`.slice(0, 160);
}

function matches(node) {
  if (filterSource && node.dataset.source !== filterSource) return false;
  if (filterText && !node.dataset.text.includes(filterText)) return false;
  return true;
}

function applyFilter() {
  view.querySelectorAll('.log-line').forEach((node) => {
    node.style.display = matches(node) ? '' : 'none';
  });
  scroll();
}

function scroll() {
  if (autoscroll && view) view.scrollTop = view.scrollHeight;
}
