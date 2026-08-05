/**
 * Вкладка «Настройки сервера».
 *
 * Верхняя часть — настройки конкретного сервера (имя, слоты, пароли, порты,
 * пути, поведение при запуске). Нижняя — общие настройки панели: SteamCMD,
 * аккаунт Steam и адрес самой панели.
 */

import { api } from '../api.js';
import { state, activeServer, refreshConfig, refreshServers, refreshStatus } from '../store.js';
import { esc, icon, toast, busy, modal } from '../ui.js';

let paneRef = null;

export function initSettingsTab(pane) {
  paneRef = pane;
  pane.__load = load;
}

async function load() {
  if (!paneRef) return;

  // Конфиг перечитываем каждый раз: сервер мог быть создан или переименован
  // уже после того, как интерфейс загрузился.
  await refreshConfig();

  const server = activeServer();
  const full = server && state.config.servers.find((s) => s.id === server.id);

  if (!full) {
    paneRef.innerHTML = `
      <div class="card"><div class="notice warn"><span class="ic">${icon('alert')}</span>
        <div>Сервер не выбран или уже удалён — вернитесь к списку серверов.</div></div></div>`;
    return;
  }

  paneRef.innerHTML = render(full, state.config);
  bind(full);
}

/* ------------------------------------------------------------ разметка */

function render(s, cfg) {
  const sv = s.server;
  const f = s.features;
  const r = s.restart;

  return `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('server')}</span>
        <div><h2>Основное</h2><div class="card-sub">Эти значения панель записывает в serverDZ.cfg при запуске</div></div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>Название сервера</label>
          <input type="text" data-p="name" value="${esc(s.name)}" maxlength="60">
          <div class="hint">Видно игрокам в браузере серверов</div>
        </div>
        <div class="field">
          <label>Максимум игроков</label>
          <input type="number" data-p="server.maxPlayers" value="${sv.maxPlayers}" min="1" max="200">
        </div>
        <div class="field">
          <label>Пароль для входа</label>
          <input type="text" data-p="server.password" value="${esc(sv.password)}" placeholder="пусто — открытый сервер">
        </div>
        <div class="field">
          <label>Пароль администратора</label>
          <input type="text" data-p="server.adminPassword" value="${esc(sv.adminPassword)}">
        </div>
        <div class="field">
          <label>Карта (миссия)</label>
          <div class="row">
            <input type="text" id="mission-current" value="${esc(sv.mission)}" readonly
                   title="Имя папки миссии в mpmissions" style="flex:1;min-width:0">
            <button class="btn" id="mission-pick" type="button">${icon('map')} Выбрать карту</button>
          </div>
          <div class="hint" id="mission-hint">Список берётся из папки mpmissions этого сервера</div>
        </div>
        <div class="field">
          <label>Ускорение времени (день / ночь)</label>
          <div class="row">
            <input type="number" data-p="server.timeAcceleration" value="${sv.timeAcceleration}" min="1" max="64">
            <input type="number" data-p="server.nightTimeAcceleration" value="${sv.nightTimeAcceleration}" min="1" max="64">
          </div>
        </div>
      </div>
      <div class="row wrap" style="margin-top:18px;gap:22px">
        <label class="switch">
          <input type="checkbox" data-p="server.disable3rdPerson" ${sv.disable3rdPerson ? 'checked' : ''}>
          <span class="track"></span><span class="switch-text">Только вид от первого лица</span>
        </label>
        <label class="switch">
          <input type="checkbox" data-p="server.disableVoN" ${sv.disableVoN ? 'checked' : ''}>
          <span class="track"></span><span class="switch-text">Отключить голосовой чат</span>
        </label>
        <label class="switch">
          <input type="checkbox" data-p="server.verifySignatures" ${sv.verifySignatures === 2 ? 'checked' : ''}>
          <span class="track"></span><span class="switch-text">Проверять подписи модов
            <small>verifySignatures = 2, рекомендуется держать включённым</small></span>
        </label>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('restart')}</span>
        <div><h2>Автоматический перезапуск</h2>
          <div class="card-sub">Перезапуск по расписанию: чистит память, применяет обновления модов
            и лечит подтормаживания на долгих сессиях</div></div>
      </div>

      <label class="switch">
        <input type="checkbox" data-p="restart.enabled" ${r.enabled ? 'checked' : ''}>
        <span class="track"></span><span class="switch-text">Включить автоперезапуск
          <small>Отсчёт идёт только пока сервер работает</small></span>
      </label>

      <div class="form-grid" style="margin-top:16px">
        <div class="field">
          <label>Режим</label>
          <select data-p="restart.mode" id="restart-mode">
            <option value="interval" ${r.mode === 'interval' ? 'selected' : ''}>Каждые N часов после запуска</option>
            <option value="schedule" ${r.mode === 'schedule' ? 'selected' : ''}>В заданные часы суток</option>
          </select>
        </div>
        <div class="field" data-restart="interval">
          <label>Интервал, часов</label>
          <input type="number" data-p="restart.intervalHours" value="${r.intervalHours}" min="0.25" max="168" step="0.25">
          <div class="hint">3 — самый частый вариант. Дробные значения допустимы: 0.5 = 30 минут.</div>
        </div>
        <div class="field" data-restart="schedule">
          <label>Часы перезапуска</label>
          <input type="text" data-special="times" value="${esc((r.times || []).join(', '))}"
                 placeholder="06:00, 12:00, 18:00, 00:00">
          <div class="hint">Через запятую, время местное — то же, что на этой машине.</div>
        </div>
        <div class="field">
          <label>Предупреждать за, минут</label>
          <input type="text" data-special="warn" value="${esc((r.warnMinutes || []).join(', '))}"
                 placeholder="15, 5, 1">
          <div class="hint">Панель напишет в лог и покажет уведомление. Оповещения игрокам в игре
            требуют RCON и пока не поддерживаются.</div>
        </div>
      </div>

      <label class="switch" style="margin-top:18px">
        <input type="checkbox" data-p="server.timePersistent" ${sv.timePersistent ? 'checked' : ''}>
        <span class="track"></span><span class="switch-text">Продолжать игровое время после перезапуска
          <small>serverTimePersistent = 1 — сервер сохраняет время суток и продолжает с него,
            иначе после каждого рестарта время сбросится на системное</small></span>
      </label>

      ${r.enabled && !sv.timePersistent
        ? `<div class="notice warn" style="margin-top:14px"><span class="ic">${icon('alert')}</span>
             <div>Автоперезапуск включён, а сохранение времени — нет. После каждого рестарта
             время в игре начнётся заново.</div></div>`
        : ''}
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('hash')}</span>
        <div><h2>Сеть и порты</h2>
          <div class="card-sub">Эти же порты панель открывает в брандмауэре Windows</div></div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>Игровой порт (UDP)</label>
          <input type="number" data-p="server.gamePort" value="${sv.gamePort}" min="1" max="65535">
        </div>
        <div class="field">
          <label>Steam query порт</label>
          <input type="number" data-p="server.steamQueryPort" value="${sv.steamQueryPort}" min="1" max="65535">
        </div>
        <div class="field">
          <label>-cpuCount <span class="badge">0 = не задавать</span></label>
          <input type="number" data-p="server.cpuCount" value="${sv.cpuCount}" min="0" max="64">
        </div>
        <div class="field">
          <label>-limitFPS <span class="badge">0 = не задавать</span></label>
          <input type="number" data-p="server.limitFPS" value="${sv.limitFPS}" min="0" max="1000">
        </div>
      </div>
      <div class="field" style="margin-top:16px">
        <label>Дополнительные порты для брандмауэра</label>
        <textarea rows="5" data-special="ports">${esc(portsToText(sv.extraPorts))}</textarea>
        <div class="hint">Одна строка — одно правило: <span class="inline-code">UDP 2303-2305 голосовой чат</span>
          или <span class="inline-code">TCP 27016 Steam query</span></div>
      </div>
      <div class="field" style="margin-top:16px">
        <label>Дополнительные аргументы запуска</label>
        <textarea rows="4" data-special="args">${esc((sv.extraArgs || []).join('\n'))}</textarea>
        <div class="hint">По одному в строке. По умолчанию: -dologs -adminlog -netlog -freezecheck</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('folder')}</span>
        <div><h2>Пути сервера</h2><div class="card-sub">Меняйте, только если переносили сервер вручную</div></div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>Папка сервера</label>
          <input type="text" data-p="paths.serverPath" value="${esc(s.paths.serverPath)}">
        </div>
        <div class="field">
          <label>Имя exe-файла</label>
          <input type="text" data-p="paths.serverExe" value="${esc(s.paths.serverExe)}">
        </div>
        <div class="field">
          <label>Папка профилей</label>
          <input type="text" data-p="paths.profilesFolder" value="${esc(s.paths.profilesFolder)}">
        </div>
        <div class="field">
          <label>Файл конфигурации</label>
          <input type="text" data-p="paths.configFile" value="${esc(s.paths.configFile)}">
        </div>
        <div class="field">
          <label>Имя генерируемого .bat</label>
          <input type="text" data-p="paths.batFile" value="${esc(s.paths.batFile)}">
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('zap')}</span>
        <div><h2>Что делать при запуске</h2>
          <div class="card-sub">Каждый шаг можно отключить, если делаете его вручную</div></div>
      </div>
      <div class="col" style="gap:14px">
        <label class="switch">
          <input type="checkbox" data-p="features.autoFirewall" ${f.autoFirewall ? 'checked' : ''}>
          <span class="track"></span><span class="switch-text">Открывать порты в брандмауэре
            <small>netsh advfirewall — требует запуска панели от администратора</small></span>
        </label>
        <label class="switch">
          <input type="checkbox" data-p="features.autoUpdateMods" ${f.autoUpdateMods ? 'checked' : ''}>
          <span class="track"></span><span class="switch-text">Проверять обновления модов
            <small>SteamCMD скачает изменившиеся моды и панель разложит их заново</small></span>
        </label>
        <label class="switch">
          <input type="checkbox" data-p="features.patchServerCfg" ${f.patchServerCfg ? 'checked' : ''}>
          <span class="track"></span><span class="switch-text">Синхронизировать serverDZ.cfg
            <small>Имя, слоты, пароли, карта и query-порт берутся из настроек панели</small></span>
        </label>
        <label class="switch">
          <input type="checkbox" data-p="features.regenerateBatOnStart" ${f.regenerateBatOnStart ? 'checked' : ''}>
          <span class="track"></span><span class="switch-text">Перегенерировать .bat запуска</span>
        </label>
      </div>
      <div class="form-grid" style="margin-top:18px">
        <div class="field">
          <label>Как раскладывать моды</label>
          <select data-p="features.deployMode">
            <option value="copy" ${f.deployMode === 'copy' ? 'selected' : ''}>Копировать (надёжнее)</option>
            <option value="symlink" ${f.deployMode === 'symlink' ? 'selected' : ''}>Симлинк / junction (экономит место)</option>
          </select>
        </div>
        <div class="field">
          <label>Как запускать сервер</label>
          <select data-p="features.launchMode">
            <option value="exe" ${f.launchMode === 'exe' ? 'selected' : ''}>Напрямую DayZServer_x64.exe</option>
            <option value="bat" ${f.launchMode === 'bat' ? 'selected' : ''}>Через сгенерированный .bat</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('terminal')}</span>
        <div><h2>SteamCMD и аккаунт Steam</h2>
          <div class="card-sub">Общие настройки для всех серверов панели</div></div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>Путь к steamcmd.exe</label>
          <input type="text" data-g="paths.steamcmdExe" value="${esc(cfg.paths.steamcmdExe)}">
        </div>
        <div class="field">
          <label>Папка workshop-контента <span class="badge">пусто = авто</span></label>
          <input type="text" data-g="paths.workshopContentDir" value="${esc(cfg.paths.workshopContentDir)}">
        </div>
        <div class="field">
          <label>Логин Steam</label>
          <input type="text" data-g="steam.username" value="${esc(cfg.steam.username)}" autocomplete="off">
        </div>
        <div class="field">
          <label>Пароль Steam ${cfg.steam.hasPassword ? '<span class="badge ok">сохранён</span>' : ''}</label>
          <input type="password" data-g="steam.password" value="" autocomplete="new-password"
                 placeholder="пусто — не менять">
        </div>
        <div class="field">
          <label>Ключ Steam Web API ${cfg.steam.hasWebApiKey ? '<span class="badge ok">задан</span>' : ''}</label>
          <input type="password" data-g="steam.webApiKey" value="" autocomplete="new-password"
                 placeholder="необязательно, улучшает поиск модов">
          <div class="hint">Бесплатно получить: steamcommunity.com/dev/apikey. Без ключа поиск по названию
            работает через страницу Workshop.</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('link')}</span>
        <div><h2>CFTools Cloud</h2>
          <div class="card-sub">Необязательно. Пока выключено — панель никуда не обращается и работает как обычно</div></div>
      </div>

      <label class="switch">
        <input type="checkbox" data-g="cftools.enabled" ${cfg.cftools.enabled ? 'checked' : ''}>
        <span class="track"></span><span class="switch-text">Использовать CFTools Cloud
          <small>Появится вкладка «CFTools»: игроки онлайн, кик, баны, сообщения в игру и RCon</small></span>
      </label>

      <div class="notice info mb" style="margin-top:16px"><span class="ic">${icon('info')}</span>
        <div>Ключи приложения создаются один раз на developer.cftools.cloud (Applications → создать приложение),
        там же приложению выдаются гранты на конкретный сервер и банлист. Application ID и Secret общие для всей
        панели, а Server API ID — свой у каждого сервера.</div></div>

      <div class="form-grid">
        <div class="field">
          <label>Application ID</label>
          <input type="text" data-g="cftools.applicationId" value="${esc(cfg.cftools.applicationId)}" autocomplete="off">
        </div>
        <div class="field">
          <label>Secret ${cfg.cftools.hasSecret ? '<span class="badge ok">сохранён</span>' : ''}</label>
          <input type="password" data-g="cftools.secret" value="" autocomplete="new-password"
                 placeholder="пусто — не менять">
        </div>
        <div class="field">
          <label>Server API ID <span class="badge">этого сервера</span></label>
          <input type="text" data-p="cftools.serverApiId" value="${esc((s.cftools || {}).serverApiId || '')}"
                 autocomplete="off">
          <div class="hint">CFTools Cloud → нужный сервер → Settings → API</div>
        </div>
        <div class="field">
          <label>Banlist ID <span class="badge">для банов</span></label>
          <input type="text" data-p="cftools.banlistId" value="${esc((s.cftools || {}).banlistId || '')}"
                 autocomplete="off">
          <div class="hint">Без него вкладка CFTools покажет всё, кроме списка банов</div>
        </div>
      </div>

      <div class="row wrap" style="margin-top:16px">
        <button class="btn" id="cf-test" type="button">${icon('zap')} Проверить связь</button>
        <button class="btn" id="cf-grants" type="button">${icon('search')} Мои ресурсы в CFTools</button>
        <span class="small faint" id="cf-status"></span>
      </div>
      <div class="hint" style="margin-top:8px">Ключи проверяются теми, что уже сохранены — сначала «Сохранить настройки».</div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('settings')}</span>
        <div><h2>Панель</h2><div class="card-sub">Изменения адреса и порта применяются после перезапуска панели</div></div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>Адрес прослушивания</label>
          <input type="text" data-g="panel.host" value="${esc(cfg.panel.host)}">
          <div class="hint">127.0.0.1 — только эта машина. 0.0.0.0 — вся локальная сеть (пароля у панели нет!)</div>
        </div>
        <div class="field">
          <label>Порт панели</label>
          <input type="number" data-g="panel.port" value="${cfg.panel.port}" min="1" max="65535">
        </div>
        <div class="field">
          <label>Строк лога в памяти</label>
          <input type="number" data-g="panel.logBufferLines" value="${cfg.panel.logBufferLines}" min="200" max="50000">
        </div>
      </div>
    </div>

    <div class="row" style="position:sticky;bottom:52px;padding:14px 0;
         background:linear-gradient(to top,var(--bg-0) 60%,transparent)">
      <button class="btn btn-success btn-lg" id="set-save">${icon('save')} Сохранить настройки</button>
      <button class="btn" id="set-reset">${icon('restart')} Отменить изменения</button>
      <span class="spacer"></span>
      <span class="small faint" id="set-status"></span>
    </div>`;
}

/* -------------------------------------------------------------- логика */

function bind(server) {
  paneRef.querySelector('#set-reset').addEventListener('click', (e) => busy(e.currentTarget, load));

  // Поля интервала и расписания взаимоисключающие — показываем только нужное.
  const modeSelect = paneRef.querySelector('#restart-mode');
  const syncMode = () => {
    for (const node of paneRef.querySelectorAll('[data-restart]')) {
      node.classList.toggle('hidden', node.dataset.restart !== modeSelect.value);
    }
  };
  modeSelect.addEventListener('change', syncMode);
  syncMode();

  paneRef.querySelector('#mission-pick').addEventListener('click', () => openMissionPicker());

  paneRef.querySelector('#cf-test').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const result = await api.cfTest();
      const label = result.server
        ? `«${result.server.nickname || result.serverApiId}»` +
          (result.playersOnline === null ? '' : `, игроков онлайн: ${result.playersOnline}`)
        : `доступно серверов: ${result.servers.length}`;

      paneRef.querySelector('#cf-status').textContent = `связь есть — ${label}`;
      toast(`CFTools отвечает: ${label}`, 'ok', 9000);
      for (const warning of result.warnings || []) toast(warning, 'warn', 12000);
    })
  );

  paneRef.querySelector('#cf-grants').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const { servers, banlists } = await api.cfGrants();
      openGrantsModal(servers, banlists);
    })
  );

  paneRef.querySelector('#set-save').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const serverPatch = {};
      const globalPatch = {};

      for (const input of paneRef.querySelectorAll('[data-p]')) {
        assign(serverPatch, input.dataset.p, readValue(input));
      }
      for (const input of paneRef.querySelectorAll('[data-g]')) {
        const value = readValue(input);
        if (input.type === 'password' && !value) continue; // пусто = не менять
        assign(globalPatch, input.dataset.g, value);
      }

      // verifySignatures в интерфейсе — переключатель, в конфиге — 0 или 2.
      if (serverPatch.server && typeof serverPatch.server.verifySignatures === 'boolean') {
        serverPatch.server.verifySignatures = serverPatch.server.verifySignatures ? 2 : 0;
      }
      if (serverPatch.server) {
        serverPatch.server.disable3rdPerson = serverPatch.server.disable3rdPerson ? 1 : 0;
        serverPatch.server.disableVoN = serverPatch.server.disableVoN ? 1 : 0;
        serverPatch.server.timePersistent = serverPatch.server.timePersistent ? 1 : 0;
        serverPatch.server.name = serverPatch.name;
      }

      // Расписание перезапуска: «06:00, 12:00» и «15, 5, 1» -> массивы
      serverPatch.restart = serverPatch.restart || {};
      try {
        serverPatch.restart.times = parseTimes(paneRef.querySelector('[data-special="times"]').value);
      } catch (err) {
        toast(err.message, 'err');
        throw err;
      }
      serverPatch.restart.warnMinutes = parseMinutes(paneRef.querySelector('[data-special="warn"]').value);

      if (serverPatch.restart.enabled && !serverPatch.server.timePersistent) {
        toast('Автоперезапуск включён без сохранения игрового времени — оно будет сбрасываться', 'warn', 9000);
      }

      const portsText = paneRef.querySelector('[data-special="ports"]').value;
      const argsText = paneRef.querySelector('[data-special="args"]').value;

      try {
        serverPatch.server.extraPorts = parsePorts(portsText);
      } catch (err) {
        toast(err.message, 'err');
        throw err;
      }
      serverPatch.server.extraArgs = argsText.split('\n').map((v) => v.trim()).filter(Boolean);

      await api.saveConfig(globalPatch);
      await api.patchServer(server.id, serverPatch);

      await refreshConfig();
      await refreshServers();
      await refreshStatus();

      paneRef.querySelector('#set-status').textContent = `сохранено в ${new Date().toLocaleTimeString('ru-RU')}`;
      toast('Настройки сохранены', 'ok');
      await load();
    })
  );
}

/* ------------------------------------------------- ресурсы CFTools */

/**
 * Список серверов и банлистов, к которым у приложения есть доступ.
 * Клик по строке подставляет ID в соответствующее поле — руками ID
 * длиной в 24 символа переписывать неудобно и легко ошибиться.
 */
function openGrantsModal(servers, banlists) {
  const rows = (items, target, empty) =>
    items.length
      ? items
          .map(
            (g) => `
              <div class="mod-row">
                <div class="mod-thumb ph">${icon(target === 'serverApiId' ? 'server' : 'shield')}</div>
                <div class="mod-main">
                  <div class="mod-name">${esc(g.identifier || g.id)}</div>
                  <div class="mod-meta"><span>${esc(g.id)}</span></div>
                </div>
                <div class="mod-actions">
                  <button class="btn btn-sm btn-primary" data-fill="${esc(target)}" data-value="${esc(g.id)}">
                    Подставить</button>
                </div>
              </div>`
          )
          .join('')
      : `<div class="notice warn"><span class="ic">${icon('alert')}</span><div>${empty}</div></div>`;

  const m = modal({
    title: 'Ресурсы приложения в CFTools',
    subtitle: 'То, к чему приложению выданы гранты',
    icon: 'link',
    wide: true,
    body: `
      <div class="col" style="gap:16px">
        <div>
          <div class="card-sub mb">Серверы</div>
          <div class="mod-list">${rows(servers, 'serverApiId', 'Приложению не выдан доступ ни к одному серверу. Сделайте это на developer.cftools.cloud.')}</div>
        </div>
        <div>
          <div class="card-sub mb">Банлисты</div>
          <div class="mod-list">${rows(banlists, 'banlistId', 'Доступных банлистов нет — баны будут недоступны.')}</div>
        </div>
      </div>`,
    footer: `<span class="spacer"></span><button class="btn" data-close>Закрыть</button>`
  });

  m.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fill]');
    if (!btn) return;

    const input = paneRef.querySelector(`[data-p="cftools.${btn.dataset.fill}"]`);
    if (input) input.value = btn.dataset.value;
    m.close();
    toast('ID подставлен — не забудьте «Сохранить настройки»', 'info', 9000);
  });
}

/* ------------------------------------------------------- выбор карты */

/**
 * Окно выбора карты.
 *
 * Карта в DayZ — это миссия из папки mpmissions сервера, поэтому список
 * читается с диска: у каждого сервера он свой. Выбор применяется сразу
 * (настройки сервера + serverDZ.cfg) и не ждёт кнопки «Сохранить настройки».
 */
export function openMissionPicker() {
  const m = modal({
    title: 'Выбрать карту',
    subtitle: 'Миссии из папки mpmissions этого сервера',
    icon: 'map',
    wide: true,
    body: `<div id="mission-list" class="col" style="gap:10px">
             <div class="small faint">Читаю mpmissions…</div>
           </div>`,
    footer: `
      <button class="btn btn-sm" id="mission-refresh">${icon('restart')} Перечитать папку</button>
      <span class="spacer"></span>
      <button class="btn" data-close>Закрыть</button>`
  });

  const listEl = m.body.querySelector('#mission-list');

  async function apply(mission, force) {
    const result = await api.selectMission(mission, force);
    m.close();

    const field = paneRef && paneRef.querySelector('#mission-current');
    if (field) field.value = result.mission;

    toast(`Карта: ${result.label}`, 'ok');
    for (const warning of result.warnings || []) toast(warning, 'warn', 12000);
    if (result.restartRequired) toast('Новая карта применится после перезапуска сервера', 'warn', 12000);

    await refreshConfig();
    await refreshServers();
    await refreshStatus();
    await load();
  }

  async function render() {
    let data;
    try {
      data = await api.missions();
    } catch (err) {
      listEl.innerHTML = `<div class="notice err"><span class="ic">${icon('alert')}</span><div>${esc(err.message)}</div></div>`;
      return;
    }

    const rows = data.missions
      .map((mi) => {
        const badges = [
          mi.current ? '<span class="badge ok">выбрана</span>' : '',
          mi.vanilla ? '<span class="badge">из игры</span>' : '<span class="badge">мод / своя сборка</span>',
          mi.exists ? '' : '<span class="badge warn">нет на диске</span>',
          mi.exists && !mi.hasInit ? '<span class="badge warn">нет init.c</span>' : '',
          mi.hasStorage ? '<span class="badge">есть сохранённый мир</span>' : ''
        ]
          .filter(Boolean)
          .join(' ');

        return `
          <div class="mod-row">
            <div class="mod-thumb ph">${icon('map')}</div>
            <div class="mod-main">
              <div class="mod-name">${esc(mi.label)}</div>
              <div class="mod-meta"><span>${esc(mi.folder)}</span>${badges}</div>
            </div>
            <div class="mod-actions">
              <button class="btn btn-sm ${mi.current ? '' : 'btn-primary'}" data-mission="${esc(mi.folder)}"
                      ${mi.current ? 'disabled' : ''}>
                ${mi.current ? 'уже выбрана' : 'Выбрать'}</button>
            </div>
          </div>`;
      })
      .join('');

    listEl.innerHTML = `
      ${data.dirExists
        ? ''
        : `<div class="notice warn"><span class="ic">${icon('alert')}</span>
            <div>Папка <span class="inline-code">${esc(data.dir || 'mpmissions')}</span> не найдена — файлы сервера
            ещё не установлены. Пока показан набор карт из самой игры.</div></div>`}
      ${data.dirExists && data.fallback
        ? `<div class="notice warn"><span class="ic">${icon('alert')}</span>
            <div>В mpmissions нет ни одной миссии. Установите файлы сервера заново или скопируйте
            миссию в <span class="inline-code">${esc(data.dir)}</span>.</div></div>`
        : ''}
      ${data.current && !data.currentExists && data.dirExists
        ? `<div class="notice err"><span class="ic">${icon('alert')}</span>
            <div>Выбранная миссия <span class="inline-code">${esc(data.current)}</span> на диске отсутствует —
            сервер с ней не запустится.</div></div>`
        : ''}
      <div class="mod-list">${rows}</div>
      <div class="field" style="margin-top:6px">
        <label>Своя миссия <span class="badge">имя папки</span></label>
        <div class="row">
          <input type="text" id="mission-manual" placeholder="например, hardcore.chernarusplus" style="flex:1;min-width:0">
          <button class="btn" id="mission-manual-apply">Применить</button>
        </div>
        <div class="hint">Пригодится, когда карта приедет вместе с модом позже: проверка наличия папки
          будет пропущена.</div>
      </div>`;

    for (const btn of listEl.querySelectorAll('[data-mission]')) {
      btn.addEventListener('click', (e) =>
        busy(e.currentTarget, () => apply(e.currentTarget.dataset.mission, false))
      );
    }

    listEl.querySelector('#mission-manual-apply').addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const value = listEl.querySelector('#mission-manual').value.trim();
        if (!value) return toast('Введите имя папки миссии', 'warn');
        return apply(value, true);
      })
    );
  }

  m.footer.querySelector('#mission-refresh').addEventListener('click', (e) => busy(e.currentTarget, render));
  render();
}

function readValue(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number') {
    // Дробный шаг (например интервал 0.5 часа) нельзя округлять до целого.
    const fractional = input.step && input.step.includes('.');
    const value = fractional ? parseFloat(input.value) : parseInt(input.value, 10);
    return Number.isFinite(value) ? value : 0;
  }
  return input.value.trim();
}

/** «06:00, 12:00, 18:00» -> ['06:00','12:00','18:00'] */
function parseTimes(text) {
  const out = [];
  for (const raw of String(text).split(/[,;\n]/)) {
    const value = raw.trim();
    if (!value) continue;
    const m = value.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      throw new Error(`Не разобрано время: «${value}». Формат: 06:00`);
    }
    out.push(`${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}`);
  }
  return out;
}

/** «15, 5, 1» -> [15, 5, 1] */
function parseMinutes(text) {
  return String(text)
    .split(/[,;\s]+/)
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 720);
}

function assign(target, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = target;
  for (const part of parts) {
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[last] = value;
}

function portsToText(ports) {
  return (ports || [])
    .map((p) => `${p.protocol} ${p.from === p.to ? p.from : `${p.from}-${p.to}`}${p.comment ? ` ${p.comment}` : ''}`)
    .join('\n');
}

function parsePorts(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const m = line.match(/^(UDP|TCP)\s+(\d+)(?:\s*-\s*(\d+))?\s*(.*)$/i);
    if (!m) throw new Error(`Не разобрана строка портов: «${line}». Формат: UDP 2303-2305 комментарий`);

    const from = parseInt(m[2], 10);
    const to = m[3] ? parseInt(m[3], 10) : from;
    if (to < from) throw new Error(`Некорректный диапазон портов: «${line}»`);

    out.push({ protocol: m[1].toUpperCase(), from, to, comment: (m[4] || '').trim() });
  }
  return out;
}
