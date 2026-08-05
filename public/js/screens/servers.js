/**
 * Экран «Мои серверы»: карточки серверов и мастер создания нового.
 *
 * Мастер — четыре шага (основное → мир и сеть → установка → проверка),
 * после подтверждения запускается установка файлов сервера через SteamCMD
 * с живым прогрессом прямо в окне мастера.
 */

import { api } from '../api.js';
import { state, on, refreshServers, refreshStatus, navigate, awaitJob, statusOf, restartOf } from '../store.js';
import {
  $, el, esc, icon, modal, toast, busy, confirmDialog,
  fmtUptime, trackPointer, STATUS_LABEL
} from '../ui.js';

export function initServersScreen() {
  const root = $('#screen-servers');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Мои серверы</h1>
        <p>Создавайте и запускайте серверы DayZ. Каждый сервер — своя папка, свои порты и свой набор модов.</p>
      </div>
      <span class="spacer"></span>
      <button class="btn btn-success btn-lg" id="btn-create-server">${icon('plus')} Создать сервер</button>
    </div>
    <div class="server-grid stagger" id="server-grid"></div>`;

  $('#btn-create-server').addEventListener('click', () => openWizard());

  on('servers', render);
  on('server-status', render);
  on('restarts', render);
  render();
}

/* ------------------------------------------------------- список серверов */

function render() {
  const grid = $('#server-grid');
  if (!grid) return;

  grid.innerHTML = '';

  for (const server of state.servers) {
    const status = statusOf(server.id);
    const card = el(serverCardHtml(server, status));
    trackPointer(card);

    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      openServer(server.id);
    });

    card.querySelector('[data-act="open"]')?.addEventListener('click', () => openServer(server.id));

    card.querySelector('[data-act="power"]')?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        await api.activateServer(server.id);
        await refreshServers();
        if (status.status === 'running') {
          await api.stopServer();
          toast('Сервер остановлен', 'ok');
        } else {
          const { job } = await api.startServer();
          toast('Запуск начался — следите за прогрессом', 'info');
          await awaitJob(job.id).catch((err) => toast(`Запуск не удался: ${err.message}`, 'err', 14000));
          await refreshServers();
        }
      })
    );

    card.querySelector('[data-act="install"]')?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const { job } = await api.installServer(server.id);
        toast('Установка файлов сервера начата — прогресс виден в консоли', 'info');
        await awaitJob(job.id)
          .then(() => toast(`Сервер «${server.name}» установлен`, 'ok'))
          .catch((err) => toast(`Установка не удалась: ${err.message}`, 'err', 14000));
        await refreshServers();
        await refreshStatus();
      })
    );

    card.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: 'Удалить сервер?',
        message: `Сервер <b>${esc(server.name)}</b> будет удалён из панели.<br><br>
          Файлы в папке <span class="inline-code">${esc(server.serverPath)}</span> останутся на диске —
          удалить их можно вручную.`,
        confirmText: 'Удалить из панели',
        danger: true
      });
      if (!yes) return;
      await api.deleteServer(server.id, false);
      await refreshServers();
      await refreshStatus();
      toast('Сервер удалён из панели', 'ok');
    });

    grid.appendChild(card);
  }

  const add = el(`
    <div class="server-card add" id="card-add">
      <div class="plus">${icon('plus')}</div>
      <div style="font-weight:600">Создать сервер</div>
      <div class="small faint center">Мастер настроит имя, слоты, пароли и порты,<br>затем скачает файлы через SteamCMD</div>
    </div>`);
  add.addEventListener('click', () => openWizard());
  grid.appendChild(add);
}

function serverCardHtml(server, status) {
  const cls = [server.status === 'running' ? 'running' : '', status.status === 'preparing' ? 'preparing' : '',
    server.installed ? '' : 'not-installed'].filter(Boolean).join(' ');

  const restart = restartOf(server.id);

  const badges = [];
  if (!server.installed) badges.push('<span class="badge warn">не установлен</span>');
  if (restart.enabled) {
    const left = restart.nextAt ? fmtUptime(Math.max(0, Math.round((restart.nextAt - Date.now()) / 1000))) : null;
    badges.push(`<span class="badge info">${icon('restart')} ${left ? `рестарт через ${left}` : 'автоперезапуск'}</span>`);
  }
  if (server.hasPassword) badges.push(`<span class="badge">${icon('key')} пароль</span>`);
  if (server.lastCrashReport) badges.push('<span class="badge err">был сбой</span>');

  const running = status.status === 'running';
  const powerLabel = running ? `${icon('stop')} Остановить` : `${icon('play')} Запустить`;

  return `
    <div class="server-card ${cls}">
      <div class="accent-line"></div>
      <div class="sc-head">
        <div class="sc-title">
          <h3>${esc(server.name)}</h3>
          <div class="path">${esc(server.serverPath || 'путь не задан')}</div>
        </div>
        <span class="status-pill ${status.status}">
          <span class="dot"></span>${STATUS_LABEL[status.status] || status.status}
        </span>
      </div>

      ${badges.length ? `<div class="row wrap" style="margin-bottom:12px">${badges.join('')}</div>` : ''}

      <div class="sc-stats">
        <div class="sc-stat"><div class="v">${server.gamePort}</div><div class="k">порт</div></div>
        <div class="sc-stat"><div class="v">${server.modsEnabled}/${server.modsTotal}</div><div class="k">моды</div></div>
        <div class="sc-stat"><div class="v">${running ? fmtUptime(status.uptimeSec) : server.maxPlayers}</div>
          <div class="k">${running ? 'аптайм' : 'слотов'}</div></div>
      </div>

      <div class="sc-actions">
        ${server.installed
          ? `<button class="btn ${running ? 'btn-danger' : 'btn-success'} btn-sm" data-act="power">${powerLabel}</button>`
          : `<button class="btn btn-primary btn-sm" data-act="install">${icon('download')} Установить</button>`}
        <button class="btn btn-sm" data-act="open">${icon('settings')} Открыть</button>
        <button class="btn btn-sm btn-ghost" data-act="delete" title="Удалить из панели">${icon('trash')}</button>
      </div>
    </div>`;
}

async function openServer(id) {
  await api.activateServer(id);
  await refreshStatus();
  navigate('dashboard');
}

/* ------------------------------------------------------------- мастер */

const STEPS = ['Основное', 'Мир и сеть', 'Установка', 'Проверка'];

export async function openWizard() {
  let suggestion = { gamePort: 2302, steamQueryPort: 27016, serverPath: '', missions: [] };
  try {
    suggestion = await api.suggest('DayZ Server');
  } catch (_) {
    /* подсказки не критичны */
  }

  let config = null;
  try {
    config = await api.config();
  } catch (_) {
    /* конфиг может быть недоступен только при сбое панели */
  }

  const data = {
    name: 'Мой сервер DayZ',
    password: '',
    adminPassword: '',
    maxPlayers: 60,
    mission: 'dayzOffline.chernarusplus',
    gamePort: suggestion.gamePort,
    steamQueryPort: suggestion.steamQueryPort,
    timeAcceleration: 12,
    disable3rdPerson: false,
    serverPath: suggestion.serverPath,
    steamcmdExe: config ? config.paths.steamcmdExe : '',
    steamUser: config ? config.steam.username : '',
    steamPass: '',
    hasStoredPass: config ? config.steam.hasPassword : false
  };

  let step = 0;
  let installing = false;
  let createdServer = null; // чтобы «Повторить установку» не плодила серверы

  const m = modal({
    title: 'Создание сервера DayZ',
    subtitle: 'Четыре шага — и сервер готов к запуску',
    icon: 'server',
    wide: true,
    body: '<div id="wz-pane"></div>',
    footer: `
      <button class="btn btn-ghost" id="wz-back">${icon('back')} Назад</button>
      <span class="spacer"></span>
      <span class="small faint" id="wz-hint"></span>
      <button class="btn btn-primary" id="wz-next">Далее ${icon('play')}</button>`
  });

  // Полоска шагов вставляется между заголовком и телом окна.
  const stepsBar = el(`<div class="wizard-steps">${STEPS.map(
    (label, i) => `
      <div class="wstep" data-step="${i}">
        <div class="num">${i + 1}</div>
        <div class="lbl">${label}</div>
        ${i < STEPS.length - 1 ? '<div class="bar"></div>' : ''}
      </div>`
  ).join('')}</div>`);
  m.body.parentElement.insertBefore(stepsBar, m.body);

  const paneBox = () => m.body.querySelector('#wz-pane');

  function renderStep(direction = 'fwd') {
    stepsBar.querySelectorAll('.wstep').forEach((node, i) => {
      node.classList.toggle('active', i === step);
      node.classList.toggle('done', i < step);
    });

    const html = [stepBasics, stepWorld, stepInstall, stepReview][step](data, suggestion);
    const pane = el(`<div class="wizard-pane ${direction === 'back' ? 'back' : ''}">${html}</div>`);
    paneBox().innerHTML = '';
    paneBox().appendChild(pane);

    bindInputs(pane, data);

    $('#wz-back').style.visibility = step === 0 ? 'hidden' : 'visible';
    $('#wz-next').innerHTML = step === STEPS.length - 1
      ? `${icon('download')} Создать и установить`
      : `Далее ${icon('play')}`;
    $('#wz-next').className = step === STEPS.length - 1 ? 'btn btn-success' : 'btn btn-primary';
    $('#wz-hint').textContent = '';
  }

  $('#wz-back').addEventListener('click', () => {
    if (installing || step === 0) return;
    step--;
    renderStep('back');
  });

  $('#wz-next').addEventListener('click', async (e) => {
    if (installing) return;

    const error = validateStep(step, data);
    if (error) {
      $('#wz-hint').textContent = error;
      toast(error, 'warn');
      return;
    }

    if (step < STEPS.length - 1) {
      step++;
      renderStep('fwd');
      return;
    }

    await runInstall(e.currentTarget);
  });

  async function runInstall(btn) {
    installing = true;
    $('#wz-back').disabled = true;
    btn.classList.add('loading');

    try {
      // Общие настройки (SteamCMD и аккаунт) сохраняем до создания сервера.
      const patch = { paths: { steamcmdExe: data.steamcmdExe }, steam: { username: data.steamUser } };
      if (data.steamPass) patch.steam.password = data.steamPass;
      await api.saveConfig(patch);

      let server = createdServer;
      let job;

      if (server) {
        // Повторная попытка: сервер уже есть, запускаем только установку.
        job = (await api.installServer(server.id)).job;
      } else {
        const created = await api.createServer({
          name: data.name,
          password: data.password,
          adminPassword: data.adminPassword,
          maxPlayers: data.maxPlayers,
          gamePort: data.gamePort,
          steamQueryPort: data.steamQueryPort,
          mission: data.mission,
          timeAcceleration: data.timeAcceleration,
          disable3rdPerson: data.disable3rdPerson,
          serverPath: data.serverPath
        });
        server = created.server;
        job = created.job;
        createdServer = server;
      }

      btn.classList.remove('loading');
      showInstallPane(server);
      await refreshServers();

      const finished = await awaitJob(job.id);
      finishInstall(server, finished);
    } catch (err) {
      installing = false;
      btn.classList.remove('loading');

      // showInstallPane прячет кнопки — обязательно возвращаем их,
      // иначе после сбоя окно превращается в тупик без единой кнопки.
      const next = $('#wz-next');
      const back = $('#wz-back');
      back.disabled = false;
      back.classList.remove('hidden');
      next.classList.remove('hidden', 'loading');
      next.innerHTML = `${icon('refresh')} Повторить установку`;
      next.className = 'btn btn-primary';

      const pane = paneBox().querySelector('.install-live') || paneBox();
      pane.innerHTML = `
        <div class="notice err"><span class="ic">${icon('alert')}</span>
          <div><b>Установка не удалась</b><br>${esc(err.message)}<br><br>
          Что проверить: путь к steamcmd.exe, логин и пароль Steam, наличие DayZ на аккаунте,
          свободное место на диске. Полный вывод SteamCMD — в консоли внизу окна.<br><br>
          Сервер уже создан, поэтому «Повторить установку» продолжит с того же места —
          SteamCMD докачает недостающее, а не начнёт заново.</div></div>`;

      toast(err.message, 'err');
      createdServer = createdServer || null;
    }
  }

  function showInstallPane(server) {
    stepsBar.querySelectorAll('.wstep').forEach((n) => n.classList.add('done'));
    paneBox().innerHTML = `
      <div class="wizard-pane install-live">
        <div class="row" style="gap:14px;margin-bottom:18px">
          <div class="card-title-icon">${icon('download')}</div>
          <div>
            <h3>Устанавливаю «${esc(server.name)}»</h3>
            <div class="small dim">SteamCMD скачивает файлы сервера DayZ. Это занимает от 5 до 30 минут.</div>
          </div>
        </div>
        <div class="progress info"><div class="bar" id="wz-bar"></div></div>
        <div class="row" style="justify-content:space-between;margin-top:9px">
          <span class="small dim" id="wz-step">Запуск SteamCMD…</span>
          <span class="small mono faint" id="wz-pct">0%</span>
        </div>
        <div class="notice info" style="margin-top:18px"><span class="ic">${icon('info')}</span>
          <div>Окно можно закрыть — установка продолжится, а прогресс будет виден в плашке справа внизу
          и в консоли логов.</div></div>
      </div>`;
    $('#wz-next').classList.add('hidden');
    $('#wz-back').classList.add('hidden');

    const off = on('job', (job) => {
      if (job.serverId !== server.id) return;
      const bar = document.getElementById('wz-bar');
      if (!bar) return off();
      bar.style.width = `${job.progress}%`;
      const stepEl = document.getElementById('wz-step');
      const pctEl = document.getElementById('wz-pct');
      if (stepEl) stepEl.textContent = job.step;
      if (pctEl) pctEl.textContent = `${job.progress}%`;
      if (job.status !== 'running') off();
    });
  }

  function finishInstall(server, job) {
    installing = false;
    paneBox().innerHTML = `
      <div class="wizard-pane">
        <div class="empty-state" style="padding:24px 10px">
          <div class="ic" style="color:var(--acc);border-color:rgba(127,210,95,.4);background:rgba(127,210,95,.1)">
            ${icon('check')}</div>
          <h3>Сервер «${esc(server.name)}» установлен</h3>
          <p>Файлы скачаны, serverDZ.cfg и .bat созданы. Теперь можно подписаться на модификации
             и запустить сервер.</p>
          <div class="row" style="justify-content:center">
            <button class="btn btn-primary" id="wz-open">${icon('settings')} Открыть панель сервера</button>
            <button class="btn btn-success" id="wz-start">${icon('play')} Запустить сразу</button>
          </div>
        </div>
      </div>`;

    document.getElementById('wz-open').addEventListener('click', async () => {
      m.close();
      await openServer(server.id);
    });

    document.getElementById('wz-start').addEventListener('click', async (e) => {
      await busy(e.currentTarget, async () => {
        await api.activateServer(server.id);
        await api.startServer();
      });
      m.close();
      await openServer(server.id);
      toast('Запуск сервера начался', 'info');
    });

    toast(`Сервер «${server.name}» готов`, 'ok');
    refreshServers();
    void job;
  }

  renderStep();
}

/* --------------------------------------------------------- шаги мастера */

function stepBasics(d) {
  return `
    <div class="form-grid one">
      <div class="field">
        <label>${icon('server')} Название сервера</label>
        <input type="text" data-k="name" value="${esc(d.name)}" maxlength="60" placeholder="Например: Русский PVE Chernarus">
        <div class="hint">Именно это название игроки увидят в браузере серверов DayZ.</div>
      </div>
    </div>
    <div class="form-grid" style="margin-top:16px">
      <div class="field">
        <label>${icon('users')} Максимум игроков</label>
        <input type="number" data-k="maxPlayers" value="${d.maxPlayers}" min="1" max="200">
        <div class="hint">Обычно 40–80. Каждый слот — это память и нагрузка на процессор.</div>
      </div>
      <div class="field">
        <label>${icon('key')} Пароль для входа</label>
        <input type="text" data-k="password" value="${esc(d.password)}" placeholder="пусто — открытый сервер">
        <div class="hint">Оставьте пустым, чтобы сервер был доступен всем.</div>
      </div>
      <div class="field">
        <label>${icon('shield')} Пароль администратора</label>
        <input type="text" data-k="adminPassword" value="${esc(d.adminPassword)}" placeholder="пароль для #login">
        <div class="hint">Нужен для админ-команд в игре. Задайте что-то длинное.</div>
      </div>
    </div>`;
}

function stepWorld(d, suggestion) {
  const missions = suggestion.missions && suggestion.missions.length
    ? suggestion.missions
    : [{ value: 'dayzOffline.chernarusplus', label: 'Chernarus+' }];

  return `
    <div class="form-grid">
      <div class="field">
        <label>${icon('map')} Карта</label>
        <select data-k="mission">
          ${missions.map((mi) => `<option value="${esc(mi.value)}" ${mi.value === d.mission ? 'selected' : ''}>${esc(mi.label)}</option>`).join('')}
        </select>
        <div class="hint">Ливония и Сахал требуют, чтобы у игроков было куплено соответствующее DLC.</div>
      </div>
      <div class="field">
        <label>${icon('clock')} Ускорение времени</label>
        <input type="number" data-k="timeAcceleration" value="${d.timeAcceleration}" min="1" max="64" step="1">
        <div class="hint">12 — сутки проходят за 2 часа реального времени.</div>
      </div>
      <div class="field">
        <label>${icon('hash')} Игровой порт (UDP)</label>
        <input type="number" data-k="gamePort" value="${d.gamePort}" min="1" max="65535">
        <div class="hint">Панель откроет этот порт в брандмауэре Windows при запуске.</div>
      </div>
      <div class="field">
        <label>${icon('hash')} Steam query порт</label>
        <input type="number" data-k="steamQueryPort" value="${d.steamQueryPort}" min="1" max="65535">
        <div class="hint">По нему сервер виден в списке Steam. Обычно 27016.</div>
      </div>
    </div>
    <label class="switch" style="margin-top:18px">
      <input type="checkbox" data-k="disable3rdPerson" ${d.disable3rdPerson ? 'checked' : ''}>
      <span class="track"></span>
      <span class="switch-text">Только вид от первого лица
        <small>Классический хардкорный режим: камера от третьего лица запрещена</small></span>
    </label>`;
}

function stepInstall(d) {
  return `
    <div class="form-grid one">
      <div class="field">
        <label>${icon('folder')} Папка установки сервера</label>
        <input type="text" data-k="serverPath" value="${esc(d.serverPath)}" placeholder="C:\\DayZServers\\MyServer">
        <div class="hint">Пустая папка на диске с 15+ ГБ свободного места. Будет создана автоматически.</div>
      </div>
      <div class="field">
        <label>${icon('terminal')} Путь к steamcmd.exe</label>
        <input type="text" data-k="steamcmdExe" value="${esc(d.steamcmdExe)}" placeholder="C:\\SteamCMD\\steamcmd.exe">
        <div class="hint">Скачайте SteamCMD с сайта Valve и распакуйте, например, в C:\\SteamCMD.</div>
      </div>
    </div>
    <div class="form-grid" style="margin-top:16px">
      <div class="field">
        <label>${icon('users')} Логин Steam</label>
        <input type="text" data-k="steamUser" value="${esc(d.steamUser)}" autocomplete="off" placeholder="ваш аккаунт Steam">
        <div class="hint">Нужен аккаунт, на котором куплен DayZ — иначе моды скачать нельзя.</div>
      </div>
      <div class="field">
        <label>${icon('key')} Пароль Steam ${d.hasStoredPass ? '<span class="badge ok">сохранён</span>' : ''}</label>
        <input type="password" data-k="steamPass" value="" autocomplete="new-password"
               placeholder="${d.hasStoredPass ? 'оставьте пустым, чтобы не менять' : 'пароль от аккаунта'}">
        <div class="hint">При Steam Guard выполните один раз в консоли:
          <span class="inline-code">steamcmd +login ЛОГИН +quit</span> — тогда пароль здесь не нужен.</div>
      </div>
    </div>
    <div class="notice warn" style="margin-top:18px"><span class="ic">${icon('alert')}</span>
      <div>Пароль хранится в <span class="inline-code">config/config.json</span> в открытом виде.
      Безопаснее авторизоваться в SteamCMD один раз вручную и оставить поле пустым.</div></div>`;
}

function stepReview(d, suggestion) {
  const mission = (suggestion.missions || []).find((mi) => mi.value === d.mission);
  const rows = [
    ['Название', d.name],
    ['Слотов', d.maxPlayers],
    ['Пароль входа', d.password ? '••••••' : 'нет (открытый сервер)'],
    ['Пароль админа', d.adminPassword ? '••••••' : 'не задан'],
    ['Карта', mission ? mission.label : d.mission],
    ['Игровой порт', `${d.gamePort} / UDP`],
    ['Steam query порт', d.steamQueryPort],
    ['Вид от 1-го лица', d.disable3rdPerson ? 'только первое лицо' : 'разрешён третий вид'],
    ['Папка сервера', d.serverPath],
    ['SteamCMD', d.steamcmdExe],
    ['Аккаунт Steam', d.steamUser || 'анонимный (моды качать не сможет)']
  ];

  return `
    <div class="summary-list">
      ${rows.map(([k, v]) => `<div class="r"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
    </div>
    <div class="notice info" style="margin-top:18px"><span class="ic">${icon('download')}</span>
      <div>После нажатия кнопки SteamCMD скачает файлы сервера DayZ (около 3–5 ГБ).
      Прогресс будет виден здесь и в консоли логов внизу.</div></div>`;
}

/* ------------------------------------------------------------ помощники */

function bindInputs(pane, data) {
  pane.querySelectorAll('[data-k]').forEach((input) => {
    const key = input.dataset.k;
    const handler = () => {
      if (input.type === 'checkbox') data[key] = input.checked;
      else if (input.type === 'number') data[key] = parseInt(input.value, 10) || 0;
      else data[key] = input.value;
      input.classList.remove('invalid');
    };
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
  });
}

function validateStep(step, d) {
  if (step === 0) {
    if (!d.name.trim()) return 'Укажите название сервера';
    if (d.maxPlayers < 1 || d.maxPlayers > 200) return 'Слотов должно быть от 1 до 200';
  }
  if (step === 1) {
    if (d.gamePort < 1 || d.gamePort > 65535) return 'Некорректный игровой порт';
    if (d.steamQueryPort < 1 || d.steamQueryPort > 65535) return 'Некорректный query-порт';
    if (d.gamePort === d.steamQueryPort) return 'Игровой и query порты должны различаться';
  }
  if (step === 2) {
    if (!d.serverPath.trim()) return 'Укажите папку установки сервера';
    if (!d.steamcmdExe.trim()) return 'Укажите путь к steamcmd.exe';
    if (!d.steamUser.trim()) return 'Укажите логин Steam — анонимно файлы сервера не скачать';
  }
  return null;
}
