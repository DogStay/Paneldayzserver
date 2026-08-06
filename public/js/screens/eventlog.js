/**
 * Вкладка «Логи» — всё, что делали игроки, в одном списке.
 *
 * События приходят от мода-моста и хранятся панелью: свежие в памяти, история —
 * файлами по дням. Здесь их можно фильтровать по типу, игроку и тексту, читать
 * вживую (новые события добавляются сверху) и подгружать более старые.
 */

import { api } from '../api.js';
import { on, activeServer } from '../store.js';
import { esc, icon, toast, busy, fmtDate } from '../ui.js';
import { EVENT_LABELS, eventLabel, eventText } from './map.js';

let paneRef = null;
let filters = { types: [], playerId: '', search: '', days: 3 };
let rows = [];
let live = true;

/** Типы, сгруппированные для галочек фильтра. */
const GROUPS = [
  { title: 'Бой', types: ['damage', 'kill', 'death', 'shot'] },
  { title: 'Вещи', types: ['item_take', 'item_drop', 'item_move', 'container_open'] },
  { title: 'Действия', types: ['action', 'build', 'dismantle', 'placement'] },
  { title: 'Транспорт', types: ['vehicle_enter', 'vehicle_exit', 'vehicle_engine', 'vehicle_destroy'] },
  { title: 'Игроки', types: ['connect', 'spawn', 'disconnect', 'chat', 'unconscious', 'bleeding'] },
  { title: 'Админы', types: ['admin', 'server'] }
];

/**
 * Строка о действиях админов.
 *
 * Панель пишет в журнал свои команды сама, а спавн и телепорты из VPPAdminTools
 * читает из его логов — если их не видно, это надо сказать прямо, иначе журнал
 * выглядит полным, хотя половины действий в нём нет.
 */
async function renderAdminLog() {
  const node = paneRef && paneRef.querySelector('#ev-adminlog');
  if (!node) return;

  let status;
  try {
    status = await api.adminlog();
  } catch (_) {
    return;
  }

  node.innerHTML = status.reason
    ? `Действия админов из игры: ${esc(status.reason)}`
    : `Действия админов из VPPAdminTools читаются: <span class="inline-code">${esc(status.file)}</span>.
       Команды самой панели попадают в журнал сразу.`;
}

export function initEventLogTab(pane) {
  paneRef = pane;
  pane.__load = load;

  on('bridge-events', (data) => {
    const server = activeServer();
    if (!server || data.serverId !== server.id) return;
    if (!live || !paneRef || !paneRef.classList.contains('active')) return;

    const fresh = (data.events || []).filter(matchesFilters);
    if (!fresh.length) return;

    rows = [...fresh.reverse(), ...rows].slice(0, 1000);
    renderRows(true);
  });
}

/** Клиентская проверка фильтров — для событий, пришедших живьём. */
function matchesFilters(event) {
  if (filters.types.length && !filters.types.includes(event.type)) return false;
  if (filters.playerId && event.playerId !== filters.playerId && event.targetId !== filters.playerId) return false;

  if (filters.search) {
    const haystack = `${event.type} ${event.playerName} ${event.targetName} ${JSON.stringify(event.data)}`;
    if (!haystack.toLowerCase().includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- загрузка */

async function load() {
  if (!paneRef) return;
  if (!paneRef.dataset.ready) {
    renderShell();
    paneRef.dataset.ready = '1';
  }
  await refresh();
  await refreshSummary();
}

function renderShell() {
  paneRef.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('activity')}</span>
        <div><h2>Журнал действий</h2>
          <div class="card-sub" id="ev-sub">события приходят от серверного мода-моста</div></div>
        <span class="spacer"></span>
        <div class="row wrap">
          <label class="switch" style="margin:0">
            <input type="checkbox" id="ev-live" checked>
            <span class="track"></span><span class="switch-text">Живая лента</span>
          </label>
          <button class="btn btn-sm" id="ev-reload">${icon('restart')} Обновить</button>
        </div>
      </div>

      <div class="form-grid" style="margin-bottom:14px">
        <div class="field">
          <label>Поиск по тексту</label>
          <input type="text" id="ev-search" placeholder="ник, класс предмета, оружие…">
        </div>
        <div class="field">
          <label>Игрок (Steam64)</label>
          <input type="text" id="ev-player" placeholder="пусто — все игроки">
        </div>
        <div class="field">
          <label>Глубина истории</label>
          <select id="ev-days">
            <option value="1">сутки</option>
            <option value="3" selected>3 дня</option>
            <option value="7">неделя</option>
            <option value="30">30 дней</option>
          </select>
        </div>
      </div>

      <div class="row wrap" style="gap:16px;margin-bottom:12px" id="ev-groups">
        ${GROUPS.map(
          (group) => `
            <div>
              <div class="small faint mb">${group.title}</div>
              <div class="row wrap" style="gap:6px">
                ${group.types
                  .map(
                    (type) => `
                      <label class="chip">
                        <input type="checkbox" data-type="${type}">
                        <span>${esc(EVENT_LABELS[type] || type)}</span>
                      </label>`
                  )
                  .join('')}
              </div>
            </div>`
        ).join('')}
      </div>

      <div class="row wrap" style="margin-bottom:14px">
        <button class="btn btn-sm" id="ev-apply">${icon('search')} Применить фильтры</button>
        <button class="btn btn-sm" id="ev-clear">Сбросить</button>
        <span class="spacer"></span>
        <span class="small faint" id="ev-count">—</span>
      </div>

      <div class="hint" id="ev-adminlog" style="margin-bottom:10px"></div>

      <div class="ev-list" id="ev-rows"></div>

      <div class="row" style="margin-top:14px">
        <button class="btn btn-sm" id="ev-more">${icon('chevron')} Показать более старые</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('activity')}</span>
        <div><h2>Сводка за сутки</h2><div class="card-sub">сколько каких событий записано</div></div>
      </div>
      <div id="ev-summary"><div class="small faint">—</div></div>
    </div>`;

  renderAdminLog();

  paneRef.querySelector('#ev-live').addEventListener('change', (e) => {
    live = e.currentTarget.checked;
  });
  paneRef.querySelector('#ev-reload').addEventListener('click', (e) => busy(e.currentTarget, load));
  paneRef.querySelector('#ev-apply').addEventListener('click', (e) => busy(e.currentTarget, applyFilters));
  paneRef.querySelector('#ev-more').addEventListener('click', (e) => busy(e.currentTarget, loadOlder));

  paneRef.querySelector('#ev-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyFilters().catch((err) => toast(err.message, 'err'));
  });

  paneRef.querySelector('#ev-clear').addEventListener('click', () => {
    filters = { types: [], playerId: '', search: '', days: 3 };
    paneRef.querySelector('#ev-search').value = '';
    paneRef.querySelector('#ev-player').value = '';
    paneRef.querySelector('#ev-days').value = '3';
    for (const box of paneRef.querySelectorAll('[data-type]')) box.checked = false;
    refresh().catch((err) => toast(err.message, 'err'));
  });
}

function readFilters() {
  filters = {
    types: [...paneRef.querySelectorAll('[data-type]:checked')].map((b) => b.dataset.type),
    playerId: paneRef.querySelector('#ev-player').value.trim(),
    search: paneRef.querySelector('#ev-search').value.trim(),
    days: Number(paneRef.querySelector('#ev-days').value) || 3
  };
}

const applyFilters = async () => {
  readFilters();
  await refresh();
};

async function refresh() {
  const data = await api.events({
    limit: 200,
    types: filters.types.join(','),
    playerId: filters.playerId,
    search: filters.search,
    days: filters.days
  });

  rows = data.events;
  renderRows();

  const sub = paneRef.querySelector('#ev-sub');
  if (sub) {
    sub.textContent = data.online
      ? 'мод-мост на связи, события пишутся'
      : 'мод-мост не на связи — показана сохранённая история';
  }
}

async function loadOlder() {
  const oldest = rows.length ? rows[rows.length - 1].ts : Date.now();
  const data = await api.events({
    limit: 200,
    before: oldest,
    types: filters.types.join(','),
    playerId: filters.playerId,
    search: filters.search,
    days: Math.max(filters.days, 7)
  });

  if (!data.events.length) return toast('Больше событий нет', 'info');
  rows = [...rows, ...data.events];
  renderRows();
}

/* ------------------------------------------------------------- отрисовка */

function renderRows(prepend = false) {
  const list = paneRef.querySelector('#ev-rows');
  const count = paneRef.querySelector('#ev-count');
  if (!list) return;

  if (!rows.length) {
    list.innerHTML = `<div class="notice info"><span class="ic">${icon('info')}</span>
      <div>Событий нет. Если мод-мост ещё не установлен — смотрите вкладку «Карта»,
      там есть инструкция.</div></div>`;
    if (count) count.textContent = '0 событий';
    return;
  }

  list.innerHTML = rows
    .map(
      (e) => `
        <div class="ev-row${prepend && e === rows[0] ? ' fresh' : ''}">
          <span class="ev-time">${esc(fmtDate(e.ts))}</span>
          <span class="ev-type t-${esc(e.type)}">${esc(eventLabel(e.type))}</span>
          <span class="ev-text">${esc(eventText(e))}</span>
          ${e.pos ? `<span class="ev-pos">${Math.round(e.pos[0])} / ${Math.round(e.pos[2])}</span>` : ''}
        </div>`
    )
    .join('');

  if (count) count.textContent = `${rows.length} событий в списке`;
}

async function refreshSummary() {
  const box = paneRef.querySelector('#ev-summary');
  if (!box) return;

  try {
    const data = await api.eventsSummary(24);
    const entries = Object.entries(data.counts).sort((a, b) => b[1] - a[1]);

    box.innerHTML = entries.length
      ? `<div class="row wrap" style="gap:8px">
          ${entries
            .map(
              ([type, n]) => `<span class="badge">${esc(eventLabel(type))}: ${n}</span>`
            )
            .join('')}
        </div>
        <div class="small faint" style="margin-top:10px">всего ${data.total} событий за 24 часа</div>`
      : '<div class="small faint">За последние сутки событий не записано.</div>';
  } catch (err) {
    box.innerHTML = `<div class="small faint">${esc(err.message)}</div>`;
  }
}
