/**
 * Вкладка «Настройки сервера».
 *
 * Верхняя часть — настройки конкретного сервера (имя, слоты, пароли, порты,
 * пути, поведение при запуске). Нижняя — общие настройки панели: SteamCMD,
 * аккаунт Steam и адрес самой панели.
 */

import { api } from '../api.js';
import { state, activeServer, refreshConfig, refreshServers, refreshStatus } from '../store.js';
import { esc, icon, toast, busy } from '../ui.js';

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
          <label>Карта (mission)</label>
          <select data-p="server.mission">
            <option value="dayzOffline.chernarusplus" ${sv.mission === 'dayzOffline.chernarusplus' ? 'selected' : ''}>Chernarus+ (Черноруссия)</option>
            <option value="dayzOffline.enoch" ${sv.mission === 'dayzOffline.enoch' ? 'selected' : ''}>Livonia (Ливония)</option>
            <option value="dayzOffline.sakhal" ${sv.mission === 'dayzOffline.sakhal' ? 'selected' : ''}>Sakhal (Сахал)</option>
          </select>
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
        serverPatch.server.name = serverPatch.name;
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

function readValue(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number') return parseInt(input.value, 10) || 0;
  return input.value.trim();
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
