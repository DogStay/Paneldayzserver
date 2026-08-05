/**
 * Экран управления конкретным сервером: шапка с кнопками старт/стоп,
 * вкладки и содержимое вкладки «Обзор».
 *
 * Остальные вкладки живут в своих модулях (mods.js, settings.js,
 * tools.js, diagnostics.js) и монтируются в контейнеры этого экрана.
 */

import { api } from '../api.js';
import { state, on, activeServer, activeStatus, refreshStatus, refreshServers, navigate } from '../store.js';
import {
  $, $$, esc, icon, toast, busy,
  fmtUptime, fmtDate, animateNumber, STATUS_LABEL
} from '../ui.js';

import { initModsTab } from './mods.js';
import { initSettingsTab } from './settings.js';
import { initToolsTabs } from './tools.js';
import { initDiagnosticsTab } from './diagnostics.js';

const TABS = [
  { id: 'overview', label: 'Обзор', icon: 'activity' },
  { id: 'mods', label: 'Модификации', icon: 'package' },
  { id: 'settings', label: 'Настройки сервера', icon: 'settings' },
  { id: 'cfg', label: 'Конфигурация', icon: 'file' },
  { id: 'bat', label: 'Файл запуска', icon: 'terminal' },
  { id: 'firewall', label: 'Порты', icon: 'shield' },
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
  initDiagnosticsTab($('#pane-diag'));

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
  on('status', () => {
    renderHead();
    if (currentTab === 'overview') renderOverview();
  });

  // Аптайм тикает раз в секунду, не дёргая сервер.
  setInterval(() => {
    const node = document.getElementById('stat-uptime');
    const status = activeStatus();
    if (node && status.status === 'running' && status.startedAt) {
      node.textContent = fmtUptime(Math.floor((Date.now() - status.startedAt) / 1000));
    }
  }, 1000);
}

export function showDashboard() {
  renderHead();
  updateModsCount();
  showTab(currentTab);
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
      await api.startServer();
      toast('Запуск начался: порты, моды, .bat, затем сам сервер', 'info');
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
      await api.restartServer();
      toast('Перезапуск начался', 'info');
    })
  );
}

/* --------------------------------------------------------------- обзор */

function renderOverview() {
  const pane = $('#pane-overview');
  const server = activeServer();
  if (!pane || !server) return;

  const status = activeStatus();
  const problems = state.problems || [];
  const summary = status.lastStartSummary;

  pane.innerHTML = `
    ${problems.length ? `
      <div class="notice warn mb"><span class="ic">${icon('alert')}</span>
        <div><b>Сервер не готов к запуску</b><br>${problems.map(esc).join('<br>')}</div></div>` : ''}

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
    await api.updateMods();
    toast('Проверка обновлений запущена', 'info');
  });

  bind('ov-deploy', async () => {
    const data = await api.deployMods();
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
    await api.installServer(server.id);
    toast('Установка файлов сервера начата', 'info');
  });

  const diagBtn = document.getElementById('ov-open-diag');
  if (diagBtn) diagBtn.addEventListener('click', () => showTab('diag'));
}

const shortPath = (value) => String(value || '').split(/[\\/]/).pop();
