/**
 * Точка входа интерфейса: собирает шапку, экраны, консоль и плашки задач,
 * подключает поток событий и переключает экраны.
 */

import {
  state, on, navigate, connectStream,
  refreshStatus, refreshConfig, refreshMods,
  activeServer, activeStatus
} from './store.js';
import { $, esc, icon, toast, modal, STATUS_LABEL } from './ui.js';

import { initServersScreen, openWizard } from './screens/servers.js';
import { initDashboardScreen, showDashboard } from './screens/dashboard.js';
import { initConsole, openConsole } from './console.js';
import { initJobsDock } from './jobsdock.js';

let currentScreen = 'servers';

/* ---------------------------------------------------------------- шапка */

function renderTopbar() {
  const bar = $('#topbar');
  const server = activeServer();
  const status = activeStatus();

  bar.innerHTML = `
    <div class="brand" id="brand">
      <div class="mark">${icon('server')}</div>
      <div>
        <div class="name">DayZ Panel</div>
        <div class="tag">управление сервером DayZ</div>
      </div>
    </div>

    <div class="topbar-nav">
      <button class="btn btn-sm ${currentScreen === 'servers' ? 'btn-primary' : 'btn-ghost'}" id="nav-servers">
        ${icon('home')} Мои серверы</button>
      ${server
        ? `<div class="server-chip" id="nav-current" title="Открыть панель сервера">
             <span class="status-pill ${status.status}" style="padding:3px 9px 3px 8px;font-size:11px">
               <span class="dot" style="width:7px;height:7px"></span>${STATUS_LABEL[status.status] || ''}</span>
             <div style="min-width:0">
               <div class="nm">${esc(server.name)}</div>
               <div class="mt">порт ${server.gamePort} · ${server.modsEnabled}/${server.modsTotal} модов</div>
             </div>
           </div>`
        : ''}
    </div>

    <div class="topbar-actions">
      <button class="btn btn-sm" id="nav-new">${icon('plus')} Новый сервер</button>
      <button class="btn btn-sm btn-ghost btn-icon" id="nav-help" title="Помощь">${icon('info')}</button>
    </div>`;

  $('#brand').addEventListener('click', () => navigate('servers'));
  $('#nav-servers').addEventListener('click', () => navigate('servers'));
  $('#nav-new').addEventListener('click', () => openWizard());
  $('#nav-help').addEventListener('click', showHelp);

  const chip = $('#nav-current');
  if (chip) chip.addEventListener('click', () => navigate('dashboard'));
}

function showHelp() {
  modal({
    title: 'Как пользоваться панелью',
    subtitle: 'Короткая шпаргалка',
    icon: 'info',
    wide: true,
    body: `
      <div class="col" style="gap:16px">
        <div class="notice info"><span class="ic">${icon('plus')}</span>
          <div><b>1. Создать сервер</b><br>Мастер спросит название, слоты, пароли, карту и порты,
          затем SteamCMD скачает файлы сервера DayZ в указанную папку.</div></div>

        <div class="notice info"><span class="ic">${icon('search')}</span>
          <div><b>2. Подписаться на модификации</b><br>Вкладка «Модификации» → кнопка «Подписаться».
          Введите название мода или его Workshop ID, добавьте нужные в список и нажмите «Загрузить».
          Панель скачает их через SteamCMD, разложит в папку сервера и скопирует ключи .bikey.</div></div>

        <div class="notice info"><span class="ic">${icon('play')}</span>
          <div><b>3. Запустить сервер</b><br>Кнопка «Запустить» сама: откроет порты в брандмауэре,
          обновит serverDZ.cfg, проверит обновления модов, соберёт .bat и запустит сервер.</div></div>

        <div class="notice warn"><span class="ic">${icon('shield')}</span>
          <div><b>Права администратора</b><br>Чтобы панель могла открывать порты через netsh,
          запускайте <span class="inline-code">start-panel.bat</span> от имени администратора.</div></div>

        <div class="notice err"><span class="ic">${icon('bug')}</span>
          <div><b>Если что-то пошло не так</b><br>Вкладка «Диагностика» → «Собрать отчёт».
          Файл <span class="inline-code">diagnostic-report-*.txt</span> появится в корне папки панели —
          его можно целиком отправить для разбора. При падении сервера отчёт создаётся автоматически
          в папке <span class="inline-code">logs</span>.</div></div>
      </div>`,
    footer: `<span class="spacer"></span><button class="btn btn-primary" data-close>Понятно</button>`
  });
}

/* -------------------------------------------------------------- экраны */

function showScreen(name) {
  currentScreen = name;

  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.toggle('active', s.id === `screen-${name}`);
  });

  if (name === 'dashboard') {
    if (!activeServer()) {
      toast('Сначала выберите сервер', 'warn');
      return showScreen('servers');
    }
    showDashboard();
    refreshMods().catch(() => {});
  }

  renderTopbar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------------------------------------------------------- старт */

async function init() {
  // Ошибки, о которых пользователь уже уведомлён тостом, не должны сыпаться
  // в консоль браузера как необработанные промисы.
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason && e.reason.shownToUser) e.preventDefault();
  });

  initConsole();
  initJobsDock();
  initServersScreen();
  initDashboardScreen();

  on('navigate', ({ screen }) => showScreen(screen));
  on('servers', renderTopbar);
  on('server-status', renderTopbar);

  // Разворачиваем консоль, когда начинается что-то длительное.
  on('job', (job) => {
    if (job.status === 'running' && (job.type === 'install-server' || job.type === 'download-mods')) openConsole();
  });

  connectStream();

  try {
    await refreshStatus();
    await refreshConfig();
  } catch (err) {
    toast(err.message, 'err');
  }

  showScreen('servers');
  renderTopbar();

  if (!state.hasServers) showWelcome();

  // Периодическая сверка на случай, если поток событий подвиснет.
  setInterval(() => refreshStatus().catch(() => {}), 15000);
}

/** Приветственное окно при первом запуске — панель ещё без серверов. */
function showWelcome() {
  const steamcmdOk = state.steamcmd && state.steamcmd.exists;

  modal({
    title: 'Добро пожаловать в DayZ Panel',
    subtitle: 'Панель ещё не знает ни одного сервера — давайте создадим первый',
    icon: 'server',
    wide: true,
    body: `
      <div class="col" style="gap:14px">
        <div class="notice ${steamcmdOk ? 'ok' : 'warn'}">
          <span class="ic">${icon(steamcmdOk ? 'check' : 'alert')}</span>
          <div><b>SteamCMD ${steamcmdOk ? 'найден' : 'не найден'}</b><br>
          ${steamcmdOk
            ? `Панель будет использовать <span class="inline-code">${esc(state.steamcmd.exe)}</span>`
            : `Скачайте SteamCMD с сайта Valve и распакуйте, например, в <span class="inline-code">C:\\SteamCMD</span>.
               Путь можно указать прямо в мастере создания сервера.`}</div>
        </div>

        <div class="notice info"><span class="ic">${icon('info')}</span>
          <div>Понадобится аккаунт Steam, на котором <b>куплен DayZ</b> — иначе Steam не отдаст ни файлы
          сервера, ни моды из Workshop.</div></div>

        ${state.panel && !state.panel.isWindows
          ? `<div class="notice warn"><span class="ic">${icon('alert')}</span>
              <div>Панель запущена не в Windows: открытие портов через netsh и запуск
              DayZServer_x64.exe работать не будут. Интерфейс и настройки доступны полностью.</div></div>`
          : ''}
      </div>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn" data-close>Позже</button>
      <button class="btn btn-success" id="welcome-create">${icon('plus')} Создать сервер</button>`,
    onMount: (m) => {
      m.footer.querySelector('#welcome-create').addEventListener('click', () => {
        m.close();
        openWizard();
      });
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
