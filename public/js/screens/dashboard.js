/**
 * Экран управления конкретным сервером: шапка с кнопками старт/стоп,
 * вкладки и содержимое вкладки «Обзор».
 *
 * Остальные вкладки живут в своих модулях (mods.js, settings.js,
 * tools.js, diagnostics.js) и монтируются в контейнеры этого экрана.
 */

import { api } from '../api.js';
import {
  state, on, activeServer, activeStatus, restartOf,
  refreshStatus, refreshServers, navigate, awaitJob
} from '../store.js';
import {
  $, $$, esc, icon, toast, busy,
  fmtUptime, fmtDate, animateNumber, STATUS_LABEL
} from '../ui.js';

import { initModsTab, askStopServer } from './mods.js';
import { initSettingsTab } from './settings.js';
import { initToolsTabs } from './tools.js';
import { initDiagnosticsTab } from './diagnostics.js';
import { initCFToolsTab } from './cftools.js';
import { initMapTab } from './map.js';
import { initEventLogTab } from './eventlog.js';

const TABS = [
  { id: 'overview', label: 'Обзор', icon: 'activity' },
  // Карта и журнал действий работают через серверный мод-мост; если его нет,
  // вкладки сами объясняют, как его подключить.
  { id: 'map', label: 'Карта', icon: 'map' },
  { id: 'events', label: 'Логи', icon: 'file' },
  { id: 'mods', label: 'Модификации', icon: 'package' },
  { id: 'settings', label: 'Настройки сервера', icon: 'settings' },
  { id: 'cfg', label: 'Конфигурация', icon: 'file' },
  { id: 'bat', label: 'Файл запуска', icon: 'terminal' },
  { id: 'firewall', label: 'Порты', icon: 'shield' },
  // Вкладка нужна только тем, кто пользуется CFTools: скрыта, пока интеграция
  // выключена в настройках сервера.
  { id: 'cftools', label: 'CFTools', icon: 'link', optional: true },
  { id: 'diag', label: 'Диагностика', icon: 'bug' }
];

let currentTab = 'overview';

export function initDashboardScreen() {
  const root = $('#screen-dashboard');

  root.innerHTML = `
    <div class="dash-head" id="dash-head"></div>
    <div class="tabs" id="dash-tabs">
      ${TABS.map(
        (t) => `<button class="tab ${t.id === 'overview' ? 'active' : ''}" data-tab="${t.id}">
          ${icon(t.icon)} ${t.label}${t.id === 'mods' ? '<span class="count" id="tab-mods-count">0</span>' : ''}
        </button>`
      ).join('')}
    </div>
    ${TABS.map((t) => `<div class="tab-pane ${t.id === 'overview' ? 'active' : ''}" id="pane-${t.id}"></div>`).join('')}`;

  $('#dash-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showTab(tab.dataset.tab);
  });

  initModsTab($('#pane-mods'));
  initSettingsTab($('#pane-settings'));
  initToolsTabs({ cfg: $('#pane-cfg'), bat: $('#pane-bat'), firewall: $('#pane-firewall') });
  initCFToolsTab($('#pane-cftools'));
  initMapTab($('#pane-map'));
  initEventLogTab($('#pane-events'));
  initDiagnosticsTab($('#pane-diag'));

  on('config', syncOptionalTabs);
  syncOptionalTabs();

  on('server-status', () => {
    renderHead();
    if (currentTab === 'overview') renderOverview();
  });
  on('servers', () => {
    renderHead();
    updateModsCount();
    if (currentTab === 'overview') renderOverview();
  });
  on('mods', updateModsCount);
  on('restarts', () => {
    if (currentTab === 'overview') renderOverview();
  });
  on('status', () => {
    renderHead();
    if (currentTab === 'overview') renderOverview();
  });

  // Аптайм и обратный отсчёт до перезапуска тикают раз в секунду, не дёргая сервер.
  setInterval(() => {
    const status = activeStatus();
    const server = activeServer();

    const uptime = document.getElementById('stat-uptime');
    if (uptime && status.status === 'running' && status.startedAt) {
      uptime.textContent = fmtUptime(Math.floor((Date.now() - status.startedAt) / 1000));
    }

    const countdown = document.getElementById('stat-restart');
    if (countdown && server) countdown.textContent = restartLabel(restartOf(server.id), status);
  }, 1000);
}

export function showDashboard() {
  renderHead();
  updateModsCount();
  syncOptionalTabs();
  showTab(currentTab);
}

/** Вкладки необязательных интеграций видны только когда те включены. */
function syncOptionalTabs() {
  const cfEnabled = Boolean(state.config && state.config.cftools && state.config.cftools.enabled);
  const tab = document.querySelector('#dash-tabs [data-tab="cftools"]');
  if (tab) tab.classList.toggle('hidden', !cfEnabled);

  // Интеграцию могли выключить, пока её вкладка открыта.
  if (!cfEnabled && currentTab === 'cftools') showTab('overview');
}

export function showTab(id) {
  currentTab = id;
  $$('.tab', $('#dash-tabs')).forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  document.querySelectorAll('#screen-dashboard .tab-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `pane-${id}`);
  });

  const pane = document.getElementById(`pane-${id}`);
  if (pane && pane.__load) pane.__load();
  if (id === 'overview') renderOverview();
}

function updateModsCount() {
  const server = activeServer();
  const node = document.getElementById('tab-mods-count');
  if (node && server) node.textContent = String(server.modsTotal || 0);
}

/* --------------------------------------------------------------- шапка */

function renderHead() {
  const head = $('#dash-head');
  const server = activeServer();
  if (!head || !server) return;

  const status = activeStatus();
  const busyState = status.status === 'preparing' || status.status === 'stopping';
  const running = status.status === 'running';

  head.innerHTML = `
    <button class="btn btn-ghost btn-icon" id="dash-back" title="Ко всем серверам">${icon('back')}</button>
    <div class="title">
      <h1>${esc(server.name)}</h1>
      <div class="meta">
        <span>${icon('hash')} порт ${server.gamePort}</span>
        <span>${icon('users')} ${server.maxPlayers} слотов</span>
        <span>${icon('package')} ${server.modsEnabled} из ${server.modsTotal} модов</span>
        <span>${icon('map')} ${esc((server.mission || '').replace('dayzOffline.', ''))}</span>
        <span>${icon('folder')} ${esc(server.serverPath)}</span>
      </div>
    </div>
    <div class="ctl">
      <span class="status-pill ${status.status}"><span class="dot"></span>${STATUS_LABEL[status.status] || status.status}</span>
      <button class="btn btn-success" id="dash-start" ${running || busyState ? 'disabled' : ''}>${icon('play')} Запустить</button>
      <button class="btn btn-danger" id="dash-stop" ${!running || busyState ? 'disabled' : ''}>${icon('stop')} Остановить</button>
      <button class="btn" id="dash-restart" ${busyState ? 'disabled' : ''}>${icon('restart')} Перезапуск</button>
    </div>`;

  $('#dash-back').addEventListener('click', () => navigate('servers'));

  $('#dash-start').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const { job } = await api.startServer();
      toast('Запуск начался: порты, моды, .bat, затем сам сервер', 'info');
      await awaitJob(job.id).catch((err) => toast(`Запуск не удался: ${err.message}`, 'err', 14000));
    })
  );

  $('#dash-stop').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await api.stopServer();
      toast('Сервер остановлен', 'ok');
    })
  );

  $('#dash-restart').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const { job } = await api.restartServer();
      toast('Перезапуск начался', 'info');
      await awaitJob(job.id).catch((err) => toast(`Перезапуск не удался: ${err.message}`, 'err', 14000));
    })
  );
}

/* --------------------------------------------------------------- обзор */

function renderOverview() {
  const pane = $('#pane-overview');
  const server = activeServer();
  if (!pane || !server) return;

  const status = activeStatus();
  const restart = restartOf(server.id);
  const problems = state.problems || [];
  const summary = status.lastStartSummary;

  pane.innerHTML = `
    ${problems.length ? `
      <div class="notice warn mb"><span class="ic">${icon('alert')}</span>
        <div><b>Сервер не готов к запуску</b><br>${problems.map(esc).join('<br>')}</div></div>` : ''}

    ${(status.lastIssues || []).map((issue, i) => `
      <div class="notice err mb">
        <span class="ic">${icon('alert')}</span>
        <div>
          <b>${status.status === 'running' ? 'Проблема с модами' : 'Вероятная причина остановки'}: ${esc(issue.title)}</b><br>
          ${esc(issue.detail).replace(/\n/g, '<br>')}
          ${issue.action && issue.action.type === 'add-mod'
            ? `<button class="btn btn-sm btn-success mt" data-fix="${i}">
                 ${icon('download')} Добавить «${esc(issue.action.name)}» и поставить первым</button>`
            : ''}
          ${issue.action && (issue.action.type === 'move-before' || issue.action.type === 'move-first')
            ? `<button class="btn btn-sm btn-success mt" data-order="${i}">
                 ${icon('refresh')} Исправить порядок модов</button>`
            : ''}
        </div>
      </div>`).join('')}

    ${status.lastCrashReport ? `
      <div class="notice err mb"><span class="ic">${icon('bug')}</span>
        <div><b>Последний запуск завершился сбоем</b><br>
        Панель сохранила подробный отчёт: <span class="inline-code">${esc(shortPath(status.lastCrashReport))}</span><br>
        <button class="btn btn-sm mt" id="ov-open-diag">${icon('bug')} Открыть диагностику</button></div></div>` : ''}

    ${!server.installed ? `
      <div class="notice warn mb"><span class="ic">${icon('download')}</span>
        <div><b>Файлы сервера не установлены</b><br>
        Нажмите «Установить», чтобы SteamCMD скачал DayZ Server в папку сервера.
        <button class="btn btn-sm mt" id="ov-install">${icon('download')} Установить файлы сервера</button></div></div>` : ''}

    <div class="stat-grid">
      <div class="stat ${status.status === 'running' ? 'accent' : ''}">
        <div class="k">${icon('activity')} состояние</div>
        <div class="v" style="font-size:19px">${STATUS_LABEL[status.status] || status.status}</div>
        <div class="s">${status.pid ? `PID ${status.pid}` : 'процесс не запущен'}</div>
      </div>
      <div class="stat">
        <div class="k">${icon('clock')} аптайм</div>
        <div class="v" id="stat-uptime">${status.status === 'running' ? fmtUptime(status.uptimeSec) : '—'}</div>
        <div class="s">${status.startedAt ? `старт ${fmtDate(status.startedAt)}` : 'нет данных'}</div>
      </div>
      <div class="stat info">
        <div class="k">${icon('package')} модификации</div>
        <div class="v" id="stat-mods">0</div>
        <div class="s">включено из ${server.modsTotal}</div>
      </div>
      <div class="stat">
        <div class="k">${icon('hash')} порты</div>
        <div class="v" style="font-size:19px">${server.gamePort} / ${server.steamQueryPort}</div>
        <div class="s">игровой / Steam query</div>
      </div>
      <div class="stat">
        <div class="k">${icon('users')} слотов</div>
        <div class="v" id="stat-slots">0</div>
        <div class="s">${server.hasPassword ? 'вход по паролю' : 'открытый сервер'}</div>
      </div>
      <div class="stat ${restart.enabled ? 'warn' : ''}">
        <div class="k">${icon('restart')} автоперезапуск</div>
        <div class="v" id="stat-restart" style="font-size:19px">${restartLabel(restart, status)}</div>
        <div class="s">${restartHint(restart)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('zap')}</span>
        <div><h2>Быстрые действия</h2><div class="card-sub">Всё то же самое панель делает и сама при запуске</div></div>
      </div>
      <div class="row wrap">
        <button class="btn" id="ov-mods">${icon('search')} Подписаться на модификации</button>
        <button class="btn" id="ov-update">${icon('refresh')} Проверить обновления модов</button>
        <button class="btn" id="ov-deploy">${icon('package')} Разложить моды в папку сервера</button>
        <button class="btn" id="ov-firewall">${icon('shield')} Открыть порты сейчас</button>
        <button class="btn" id="ov-bat">${icon('terminal')} Перегенерировать .bat</button>
        <button class="btn" id="ov-report">${icon('bug')} Собрать отчёт для диагностики</button>
      </div>
    </div>

    ${summary ? renderSummary(summary) : ''}`;

  animateNumber($('#stat-mods'), server.modsEnabled);
  animateNumber($('#stat-slots'), server.maxPlayers);

  bindOverviewActions(server);
}

function renderSummary(summary) {
  const rows = [];

  if (summary.firewall) {
    const fw = summary.firewall;
    rows.push(['Брандмауэр', `создано ${fw.created.length}, уже было ${fw.skipped.length}, ошибок ${fw.failed.length}`]);
  }
  if (summary.serverCfg) {
    rows.push(['serverDZ.cfg', summary.serverCfg.changed ? 'обновлён из настроек панели' : 'изменений не потребовалось']);
  }
  if (summary.mods) {
    const m = summary.mods;
    const updated = (m.updated || []).length;
    rows.push([
      'Модификации',
      m.skipped
        ? 'обновление пропущено, моды разложены как есть'
        : updated
          ? `обновлено ${updated}: ${m.updated.map((u) => u.name).join(', ')}`
          : 'все моды актуальны'
    ]);
    if ((m.failed || []).length) rows.push(['Ошибки модов', m.failed.map((f) => `${f.name}: ${f.error}`).join('; ')]);
  }
  if (summary.bat) rows.push(['Файл запуска', summary.bat.written ? `перезаписан ${summary.bat.path}` : 'уже был актуален']);

  if (!rows.length) return '';

  return `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('info')}</span>
        <div><h2>Что сделал последний запуск</h2>
          <div class="card-sub">${fmtDate(summary.startedAt)}</div></div>
      </div>
      <div class="summary-list">
        ${rows.map(([k, v]) => `<div class="r"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
      </div>
    </div>`;
}

function bindOverviewActions(server) {
  const bind = (id, handler) => {
    const node = document.getElementById(id);
    if (node) node.addEventListener('click', (e) => busy(e.currentTarget, () => handler(e)));
  };

  bind('ov-mods', async () => {
    showTab('mods');
    const pane = document.getElementById('pane-mods');
    if (pane && pane.__openSearch) pane.__openSearch();
  });

  bind('ov-update', async () => {
    const ask = await askStopServer('обновить моды');
    if (!ask.go) return;
    await api.updateMods({ stopServer: ask.stopServer });
    toast('Проверка обновлений запущена', 'info');
  });

  bind('ov-deploy', async () => {
    const ask = await askStopServer('разложить моды');
    if (!ask.go) return;

    const data = await api.deployMods({ stopServer: ask.stopServer });
    const bad = data.report.filter((r) => !r.ok);
    toast(bad.length ? `Не разложено модов: ${bad.length}` : 'Моды разложены в папку сервера', bad.length ? 'err' : 'ok');
  });

  bind('ov-firewall', async () => {
    const report = await api.applyFirewall(false);
    if (!report.platform || report.platform !== 'win32') return toast('Открытие портов работает только в Windows', 'warn');
    if (report.failed.length) toast('Нужны права администратора — запустите панель от имени администратора', 'err');
    else toast(`Порты открыты (создано ${report.created.length})`, 'ok');
  });

  bind('ov-bat', async () => {
    const data = await api.writeBat();
    toast(data.written ? `Файл записан: ${data.path}` : '.bat уже был актуален', 'ok');
  });

  bind('ov-report', async () => {
    const report = await api.buildReport();
    toast(`Отчёт сохранён: ${report.name}`, 'ok');
    showTab('diag');
  });

  bind('ov-install', async () => {
    const { job } = await api.installServer(server.id);
    toast('Установка файлов сервера начата — прогресс виден в консоли', 'info');
    await awaitJob(job.id)
      .then(() => toast('Файлы сервера установлены', 'ok'))
      .catch((err) => toast(`Установка не удалась: ${err.message}`, 'err', 14000));
    await refreshStatus();
    await refreshServers();
  });

  const diagBtn = document.getElementById('ov-open-diag');
  if (diagBtn) diagBtn.addEventListener('click', () => showTab('diag'));

  // Кнопка «Исправить порядок модов»: двигает мод-зависимость выше того,
  // кто её требует (или в самый верх, если это фреймворк).
  for (const node of document.querySelectorAll('[data-order]')) {
    const issue = (activeStatus().lastIssues || [])[Number(node.dataset.order)];
    if (!issue || !issue.action) continue;

    node.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const list = await api.mods();
        const idOf = (folder) => (list.mods.find((m) => m.folder === folder) || {}).id;

        const moved = idOf(issue.action.folder);
        if (!moved) return toast(`Мод ${issue.action.folder} не найден в списке`, 'err');

        const rest = list.mods.map((m) => m.id).filter((id) => id !== moved);
        const at = issue.action.before ? rest.indexOf(idOf(issue.action.before)) : 0;
        rest.splice(at < 0 ? 0 : at, 0, moved);

        await api.reorderMods(rest);
        toast('Порядок модов исправлен. Перезапустите сервер, чтобы он вступил в силу.', 'ok', 12000);
        await refreshServers();
      })
    );
  }

  // Кнопки «починить»: добавляют недостающий мод-фреймворк и поднимают его наверх.
  const status = activeStatus();
  for (const node of document.querySelectorAll('[data-fix]')) {
    const issue = (status.lastIssues || [])[Number(node.dataset.fix)];
    if (!issue || !issue.action || issue.action.type !== 'add-mod') continue;

    node.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const ask = await askStopServer(`установить «${issue.action.name}»`);
        if (!ask.go) return;

        const { job } = await api.downloadMods(
          [{ id: issue.action.workshopId, name: issue.action.name, type: 'client' }],
          { stopServer: ask.stopServer }
        );
        toast(`Скачиваю «${issue.action.name}»…`, 'info');

        await awaitJob(job.id).catch((err) => {
          toast(`Не удалось скачать: ${err.message}`, 'err', 14000);
          throw err;
        });

        // Фреймворк обязан грузиться раньше зависимых модов.
        const list = await api.mods();
        const ids = list.mods.map((m) => m.id);
        const target = issue.action.workshopId;
        if (ids.includes(target)) {
          await api.reorderMods([target, ...ids.filter((id) => id !== target)]);
        }

        toast(`«${issue.action.name}» добавлен и поставлен первым. Запустите сервер заново.`, 'ok', 12000);
        await refreshStatus();
        await refreshServers();
      })
    );
  }
}

const shortPath = (value) => String(value || '').split(/[\\/]/).pop();

/** Текст плитки автоперезапуска. */
function restartLabel(restart, status) {
  if (!restart.enabled) return 'выключен';
  if (status.status !== 'running') return 'ждёт запуска';
  if (!restart.nextAt) return 'рассчитывается';
  return fmtUptime(Math.max(0, Math.round((restart.nextAt - Date.now()) / 1000)));
}

function restartHint(restart) {
  if (!restart.enabled) return 'включается в настройках сервера';
  if (restart.mode === 'schedule') {
    return restart.times && restart.times.length ? `по часам: ${restart.times.join(', ')}` : 'часы не заданы';
  }
  return `каждые ${restart.intervalHours} ч`;
}
