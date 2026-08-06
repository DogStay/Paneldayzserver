/**
 * Вкладка «Настройки сервера».
 *
 * Верхняя часть — настройки конкретного сервера (имя, слоты, пароли, порты,
 * пути, поведение при запуске). Нижняя — общие настройки панели: SteamCMD,
 * аккаунт Steam и адрес самой панели.
 */

import { api } from '../api.js';
import { state, activeServer, announcementsOf, refreshConfig, refreshServers, refreshStatus } from '../store.js';
import { esc, icon, toast, busy, modal, confirmDialog, fmtDate } from '../ui.js';

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
  const an = s.announcements || { enabled: false, intervalMinutes: 15, order: 'rotate', messages: [] };
  const ig = s.ingame || { channel: 'auto', battleye: {} };
  const be = ig.battleye || {};

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
          <div class="hint">Панель напишет в лог, покажет уведомление и — если включено ниже —
            предупредит игроков в игре.</div>
        </div>
      </div>

      <label class="switch" style="margin-top:18px">
        <input type="checkbox" data-p="restart.announceInGame" ${r.announceInGame ? 'checked' : ''}>
        <span class="track"></span><span class="switch-text">Предупреждать игроков в игре
          <small>Сообщения уходят в чат сервера выбранным каналом — BattlEye RCon (бесплатно)
            или CFTools; настраивается ниже, в разделе «Сообщения в игру»</small></span>
      </label>

      <div class="form-grid" style="margin-top:16px">
        <div class="field">
          <label>Текст предупреждения</label>
          <input type="text" data-p="restart.warnTemplate" value="${esc(r.warnTemplate || '')}" maxlength="256">
          <div class="hint">Подстановки: <span class="inline-code">{minutes}</span> — сколько минут осталось,
            <span class="inline-code">{server}</span>, <span class="inline-code">{map}</span></div>
        </div>
        <div class="field">
          <label>Текст в момент перезапуска</label>
          <input type="text" data-p="restart.restartTemplate" value="${esc(r.restartTemplate || '')}" maxlength="256">
          <div class="hint">Уходит игрокам за пару секунд до остановки сервера</div>
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
        <span class="card-title-icon">${icon('terminal')}</span>
        <div><h2>Сообщения в игру</h2>
          <div class="card-sub">Чем панель пишет игрокам: предупреждения о перезапуске и объявления в чат</div></div>
        <span class="spacer"></span>
        <span class="small faint" id="ingame-state">—</span>
      </div>

      <div class="notice info mb"><span class="ic">${icon('info')}</span>
        <div><b>BattlEye RCon</b> — бесплатный способ: RCon есть у любого сервера DayZ, именно так пишут в чат
        BEC и похожие программы. Нужен лишь пароль в <span class="inline-code">battleye\\beserver_x64.cfg</span> —
        панель умеет создать этот файл сама.<br>
        <b>CFTools</b> — удобно, если он уже подключён, но отправка сообщений в игру у CFTools доступна
        только на платной подписке.</div></div>

      <div class="form-grid">
        <div class="field">
          <label>Канал</label>
          <select data-p="ingame.channel">
            <option value="auto" ${ig.channel === 'auto' ? 'selected' : ''}>Автоматически: BattlEye, иначе CFTools</option>
            <option value="battleye" ${ig.channel === 'battleye' ? 'selected' : ''}>Только BattlEye RCon (бесплатно)</option>
            <option value="cftools" ${ig.channel === 'cftools' ? 'selected' : ''}>Только CFTools (нужна подписка)</option>
            <option value="off" ${ig.channel === 'off' ? 'selected' : ''}>Не писать в игру</option>
          </select>
        </div>
        <div class="field">
          <label>RCon-порт BattlEye <span class="badge">0 = из конфига</span></label>
          <input type="number" data-p="ingame.battleye.port" value="${be.port || 0}" min="0" max="65535">
          <div class="hint">Пусто/0 — панель возьмёт <span class="inline-code">RConPort</span> из настроек
            BattlEye сервера, иначе 2306</div>
        </div>
        <div class="field">
          <label>Пароль RCon ${be.hasPassword ? '<span class="badge ok">задан</span>' : '<span class="badge">из конфига</span>'}</label>
          <input type="password" data-p="ingame.battleye.password" value="" autocomplete="new-password"
                 placeholder="пусто — взять из beserver_x64.cfg">
        </div>
        <div class="field">
          <label>Адрес BattlEye</label>
          <input type="text" data-p="ingame.battleye.host" value="${esc(be.host || '127.0.0.1')}">
          <div class="hint">Панель и сервер на одной машине — оставьте 127.0.0.1</div>
        </div>
        <div class="field">
          <label>Кодировка сообщений</label>
          <select data-p="ingame.battleye.encoding">
            <option value="utf8" ${be.encoding !== 'cp1251' ? 'selected' : ''}>UTF-8 (обычно верно)</option>
            <option value="cp1251" ${be.encoding === 'cp1251' ? 'selected' : ''}>CP1251 (если русский в чате «кракозябрами»)</option>
          </select>
        </div>
      </div>

      <div class="row wrap" style="margin-top:16px">
        <button class="btn" id="be-test" type="button">${icon('zap')} Проверить BattlEye RCon</button>
        <button class="btn" id="be-setup" type="button">${icon('key')} Настроить BattlEye</button>
        <button class="btn" id="ingame-say" type="button">${icon('users')} Отправить тестовое сообщение</button>
      </div>
      <div class="hint" style="margin-top:8px">Проверка использует сохранённые настройки — сначала
        «Сохранить настройки». RCon работает только когда сервер запущен.</div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('users')}</span>
        <div><h2>Объявления в чат</h2>
          <div class="card-sub">Сообщения игрокам по кругу: правила, Discord, время до перезапуска —
            сколько угодно строк</div></div>
      </div>

      <label class="switch">
        <input type="checkbox" data-p="announcements.enabled" ${an.enabled ? 'checked' : ''}>
        <span class="track"></span><span class="switch-text">Отправлять объявления в игру
          <small>Идут тем же каналом, что и предупреждения о перезапуске (см. «Сообщения в игру»).
            Отсчёт только пока сервер работает</small></span>
      </label>

      <div class="form-grid" style="margin-top:16px">
        <div class="field">
          <label>Интервал, минут</label>
          <input type="number" data-p="announcements.intervalMinutes" value="${an.intervalMinutes}"
                 min="1" max="1440">
          <div class="hint">Первое объявление — через интервал после запуска сервера</div>
        </div>
        <div class="field">
          <label>Порядок</label>
          <select data-p="announcements.order">
            <option value="rotate" ${an.order === 'rotate' ? 'selected' : ''}>По кругу, по порядку</option>
            <option value="random" ${an.order === 'random' ? 'selected' : ''}>В случайном порядке</option>
          </select>
        </div>
      </div>

      <div class="field" style="margin-top:16px">
        <label>Сообщения <span class="badge">одно на строку</span>
          <span class="badge" id="ann-count">${(an.messages || []).length}</span></label>
        <textarea data-special="announcements" rows="7" spellcheck="false"
                  placeholder="Вы играете на сервере {server} — карта {map}.
До планового перезапуска: {restart}.
Discord сервера: discord.gg/…">${esc((an.messages || []).join('\n'))}</textarea>
        <div class="hint">Подстановки: <span class="inline-code">{server}</span> — название сервера,
          <span class="inline-code">{map}</span> — карта, <span class="inline-code">{restart}</span> — время
          до планового перезапуска. Длинные сообщения обрезаются: у BattlEye — примерно 200 символов,
          у CFTools — 256. Точный предел показывает «Предпросмотр».</div>
      </div>

      <div class="row wrap" style="margin-top:14px">
        <button class="btn" id="ann-preview" type="button">${icon('search')} Предпросмотр</button>
        <button class="btn btn-primary" id="ann-send" type="button">${icon('users')} Отправить первое сейчас</button>
        <span class="small faint" id="ann-state">${announcementHint(s.id)}</span>
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

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('map')}</span>
        <div><h2>Подложка карты</h2>
          <div class="card-sub">Настоящая карта под метками игроков на вкладке «Карта»</div></div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="tiles-test" type="button">${icon('zap')} Проверить источник</button>
        <button class="btn btn-sm" id="tiles-clear" type="button">${icon('trash')} Очистить кэш</button>
      </div>
      <div id="tiles-box"><div class="small faint">Читаю настройки подложки…</div></div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('external')}</span>
        <div><h2>Доступ снаружи</h2>
          <div class="card-sub">Проверка по шагам: где обрыв между «панель работает» и «панель открылась
            с другого компьютера»</div></div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="access-check" type="button">${icon('zap')} Проверить</button>
      </div>
      <div id="access-box"><div class="small faint">Нажмите «Проверить» — займёт несколько секунд.</div></div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('key')}</span>
        <div><h2>Доступ к панели</h2>
          <div class="card-sub">Мастер-ключи и активные сессии</div></div>
        <span class="spacer"></span>
        <span class="small faint" id="auth-state">—</span>
      </div>
      <div id="auth-box"><div class="small faint">Читаю состояние входа…</div></div>
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
  bindAnnouncements();
  bindIngame();
  bindAccess();
  bindAuth();
  bindTiles();

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

      // Объявления: каждая строка textarea — отдельное сообщение.
      serverPatch.announcements = serverPatch.announcements || {};
      serverPatch.announcements.messages = parseAnnouncements(
        paneRef.querySelector('[data-special="announcements"]').value
      );

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

/* ------------------------------------------------------- доступ снаружи */

/**
 * Проверка доступа: панель сама говорит, на каком шаге обрыв — адрес
 * прослушивания, брандмауэр, NAT роутера или вход по ключам.
 */
function bindAccess() {
  const box = paneRef.querySelector('#access-box');

  const ICONS = { ok: 'check', bad: 'alert', warn: 'alert', skip: 'info' };
  const KINDS = { ok: 'ok', bad: 'err', warn: 'warn', skip: 'info' };

  const render = async () => {
    box.innerHTML = '<div class="small faint">Проверяю адреса, порт и брандмауэр…</div>';

    let data;
    try {
      data = await api.access();
    } catch (err) {
      box.innerHTML = `<div class="notice err"><span class="ic">${icon('alert')}</span><div>${esc(err.message)}</div></div>`;
      return;
    }

    const bad = data.steps.filter((s) => s.state === 'bad').length;

    box.innerHTML = `
      <div class="notice ${bad ? 'warn' : 'ok'} mb"><span class="ic">${icon(bad ? 'alert' : 'check')}</span>
        <div>${bad
          ? `Найдено препятствий: ${bad}. Ниже — что именно и что нажать.`
          : 'Препятствий не найдено: панель доступна по адресам ниже.'}</div></div>

      <div class="col" style="gap:8px">
        ${data.steps
          .map(
            (step) => `
              <div class="notice ${KINDS[step.state] || 'info'}">
                <span class="ic">${icon(ICONS[step.state] || 'info')}</span>
                <div><b>${esc(step.title)}</b><br>${esc(step.detail)}
                ${step.action ? `<br><span style="opacity:.85">→ ${esc(step.action)}</span>` : ''}</div>
              </div>`
          )
          .join('')}
      </div>

      ${data.urls.length
        ? `<div class="field" style="margin-top:16px">
            <label>Адреса, по которым панель открывается</label>
            <div class="row wrap" style="gap:8px">
              ${data.urls.map((url) => `<span class="badge" style="font-family:var(--mono)">${esc(url)}</span>`).join('')}
            </div>
            <div class="hint">Из локальной сети — по адресу машины. Из интернета — по внешнему адресу
              или домену, и только если порт проброшен (см. шаги выше).</div>
          </div>`
        : ''}

      <div class="row wrap" style="margin-top:16px">
        ${data.loopbackOnly || data.hostUnknown
          ? `<button class="btn btn-success btn-lg" id="access-expose" type="button">
              ${icon('external')} Открыть панель наружу</button>`
          : ''}
        ${data.firewall.supported && !data.firewall.exists
          ? `<button class="btn btn-primary" id="access-open-port" type="button">
              ${icon('shield')} Открыть порт панели (${data.port})</button>`
          : ''}
        <button class="btn" id="access-again" type="button">${icon('restart')} Проверить снова</button>
      </div>
      ${data.loopbackOnly || data.hostUnknown
        ? `<div class="hint" style="margin-top:8px">Одной кнопкой: панель начнёт слушать все адреса машины
            (0.0.0.0), порт откроется в брандмауэре, включится вход по мастер-ключам, и панель покажет
            адрес и ключ. Перезапуск не нужен.</div>`
        : ''}`;

    const expose = box.querySelector('#access-expose');
    if (expose) {
      expose.addEventListener('click', (e) =>
        busy(e.currentTarget, async () => {
          const result = await api.accessExpose('0.0.0.0');

          // Панель переезжает на новый адрес сразу после ответа, поэтому итог
          // сверяем повторной проверкой, а не тем, что вернулось.
          await new Promise((resolve) => setTimeout(resolve, 1500));

          let fresh = null;
          try {
            fresh = await api.access(true);
          } catch (_) {
            /* панель могла на мгновение переоткрыть сокет */
          }

          if (fresh && fresh.loopbackOnly) {
            toast('Адрес не сменился — смотрите окно панели, там причина', 'err', 14000);
          } else {
            openExposedModal({ ...result, diagnose: fresh || result.diagnose });
          }

          await render();
        })
      );
    }

    const openPort = box.querySelector('#access-open-port');
    if (openPort) {
      openPort.addEventListener('click', (e) =>
        busy(e.currentTarget, async () => {
          const result = await api.accessOpenPort();

          if (result.created) toast(`Порт ${data.port} открыт в брандмауэре`, 'ok', 9000);
          else if (result.existed) toast('Правило уже было', 'info');
          else if (result.bat) {
            toast(
              `Не хватило прав администратора. Панель сохранила ${result.bat} — запустите его ` +
                'правым щелчком «от имени администратора».',
              'warn',
              16000
            );
          } else {
            toast(result.error || 'Не удалось создать правило', 'err', 12000);
          }

          await render();
        })
      );
    }

    box.querySelector('#access-again').addEventListener('click', (e) => busy(e.currentTarget, render));
  };

  paneRef.querySelector('#access-check').addEventListener('click', (e) => busy(e.currentTarget, render));
}

/**
 * Итог «панель открыта наружу»: адреса, ключи и что делать с роутером.
 * Показывается один раз сразу после нажатия — чтобы всё нужное было под рукой.
 */
function openExposedModal(result) {
  const d = result.diagnose || {};
  const urls = d.urls || [];
  const nat = (d.steps || []).find((s) => s.title.indexOf('NAT') >= 0 && s.state === 'warn');

  modal({
    title: 'Панель открыта наружу',
    subtitle: `слушает ${result.host}:${d.port || ''}`,
    icon: 'external',
    wide: true,
    body: `
      <div class="col" style="gap:14px">
        <div class="notice ok"><span class="ic">${icon('check')}</span>
          <div>Адрес прослушивания сменён без перезапуска панели, порт в брандмауэре
          ${result.firewall && (result.firewall.created || result.firewall.existed) ? 'открыт' : 'НЕ открыт — см. ниже'},
          вход по мастер-ключам включён.</div></div>

        <div class="field">
          <label>Адрес для входа с другого компьютера</label>
          <div class="col" style="gap:6px">
            ${urls.length
              ? urls.map((url) => `<span class="badge" style="font-family:var(--mono);font-size:13px">${esc(url)}</span>`).join('')
              : '<span class="small faint">адреса не определились — нажмите «Проверить»</span>'}
          </div>
          <div class="hint">В локальной сети — адрес машины. Из интернета — внешний адрес или домен.</div>
        </div>

        <div class="field">
          <label>Мастер-ключи (действуют до перезапуска панели)</label>
          <div class="col" style="gap:6px">
            ${(result.keys || [])
              .map((k) => `<span class="badge" style="font-family:var(--mono);font-size:14px;letter-spacing:.08em">${esc(k.key)}</span>`)
              .join('')}
          </div>
          <div class="hint">Введите любой из них на странице входа. Ключи новые при каждом запуске панели.</div>
        </div>

        ${nat
          ? `<div class="notice warn"><span class="ic">${icon('alert')}</span>
              <div><b>Из интернета пока не откроется.</b> ${esc(nat.detail)}<br>→ ${esc(nat.action)}</div></div>`
          : ''}

        ${result.firewall && !result.firewall.created && !result.firewall.existed
          ? `<div class="notice warn"><span class="ic">${icon('alert')}</span>
              <div>Правило брандмауэра не создано${result.firewall.error ? `: ${esc(result.firewall.error)}` : ''}.
              Запустите панель от имени администратора и нажмите «Открыть порт панели».</div></div>`
          : ''}

        <div class="notice info"><span class="ic">${icon('info')}</span>
          <div>Панель работает по http: для доступа через интернет поставьте её за reverse-proxy
          с сертификатом (Caddy, nginx) или укажите <span class="inline-code">panel.tls</span> —
          иначе ключ идёт по сети открытым текстом.</div></div>
      </div>`,
    footer: `<span class="spacer"></span><button class="btn btn-primary" data-close>Понятно</button>`
  });
}

/* --------------------------------------------------------- доступ к панели */

/**
 * Мастер-ключи и сессии.
 *
 * Ключи живут только в памяти панели и печатаются в её окне при запуске. Здесь
 * их можно посмотреть (чтобы передать второй ключ коллеге), выпустить заново и
 * закрыть чужие сессии.
 */
/**
 * Подложка карты: слой, свой тайл-сервер и кэш.
 *
 * Тайлы панель скачивает сама и держит на диске, поэтому карта работает и без
 * интернета на машине сервера — но первый показ каждого участка требует сети.
 */
function bindTiles() {
  const box = paneRef.querySelector('#tiles-box');

  const render = async () => {
    let info;
    try {
      info = await api.map();
    } catch (err) {
      box.innerHTML = `<div class="notice warn"><span class="ic">${icon('alert')}</span>
        <div>${esc(err.message)}</div></div>`;
      return;
    }

    const t = info.tiles;
    const kb = Math.round((info.cache.bytes || 0) / 1024);
    const known = info.known
      ? `Карта <b>${esc(info.world)}</b> — ${info.size} м, слои: ${info.layers.join(', ') || '—'}`
      : `Карта <b>${esc(info.world || '—')}</b> панели не известна`;

    box.innerHTML = `
      <div class="small mb">${known}. В кэше ${info.cache.files} тайлов${kb ? ` (${kb} КБ)` : ''}.</div>

      ${info.reason ? `<div class="notice warn mb"><span class="ic">${icon('alert')}</span>
        <div>${esc(info.reason)}</div></div>` : ''}

      <div class="form-grid">
        <div class="field">
          <label>Слой</label>
          <select id="tiles-layer">
            <option value="off" ${!t.enabled ? 'selected' : ''}>без подложки — только сетка</option>
            <option value="topographic" ${t.enabled && t.layer === 'topographic' ? 'selected' : ''}>карта</option>
            <option value="satellite" ${t.enabled && t.layer === 'satellite' ? 'selected' : ''}>спутник</option>
          </select>
        </div>
        <div class="field">
          <label>Свой тайл-сервер <span class="badge">не обязательно</span></label>
          <input type="text" id="tiles-url" value="${esc(t.urlTemplate)}"
                 placeholder="https://сервер/{z}/{x}/{y}.png">
        </div>
      </div>

      ${t.template ? `<div class="field" style="margin-top:12px">
        <label>Адрес тайлов, который используется сейчас</label>
        <div class="inline-code" style="word-break:break-all">${esc(t.template)}</div>
      </div>` : ''}

      <div class="hint" style="margin-top:10px">${esc(t.attribution)}. Панель скачивает каждый тайл
        один раз и дальше отдаёт с диска — чужой сервер не нагружается, а карта работает без интернета.
        Свой адрес нужен для самодельных карт: поддерживается обычная схема
        <span class="inline-code">{z}/{x}/{y}</span>, размер тайла 256 пикселей.</div>`;

    box.querySelector('#tiles-layer').addEventListener('change', (e) =>
      busy(e.currentTarget, async () => {
        const value = e.currentTarget.value;
        await api.saveConfig({
          panel: { map: { tiles: { enabled: value !== 'off', ...(value === 'off' ? {} : { layer: value }) } } }
        });
        toast('Подложка обновлена — откройте вкладку «Карта»', 'ok');
        await render();
      })
    );

    box.querySelector('#tiles-url').addEventListener('change', (e) =>
      busy(e.currentTarget, async () => {
        await api.saveConfig({ panel: { map: { tiles: { urlTemplate: e.currentTarget.value.trim() } } } });
        toast('Адрес тайлов сохранён', 'ok');
        await render();
      })
    );
  };

  paneRef.querySelector('#tiles-test').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const r = await api.testMapTiles();
      if (r.ok) {
        toast(`Источник отвечает: тайл ${Math.round(r.bytes / 1024)} КБ, ${r.type || 'изображение'}`, 'ok', 9000);
      } else {
        // Показываем и адрес: по нему сразу видно, та ли это карта и версия.
        toast(`Тайлы не приходят: ${r.error}${r.url ? `\nАдрес: ${r.url}` : ''}`, 'err', 15000);
      }
      await render();
    })
  );

  paneRef.querySelector('#tiles-clear').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const result = await api.clearMapTiles(true);
      toast(`Кэш тайлов очищен: ${result.cleared.files} файлов`, 'ok');
      await render();
    })
  );

  render();
}

function bindAuth() {
  const box = paneRef.querySelector('#auth-box');
  const stateEl = paneRef.querySelector('#auth-state');

  const render = async () => {
    let status;
    try {
      status = await api.authStatus();
    } catch (err) {
      box.innerHTML = `<div class="notice err"><span class="ic">${icon('alert')}</span><div>${esc(err.message)}</div></div>`;
      return;
    }

    stateEl.textContent = status.required
      ? `вход по ключу${status.https ? ', HTTPS' : ', без HTTPS'}`
      : 'вход не требуется (только 127.0.0.1)';

    if (!status.required) {
      box.innerHTML = `
        <div class="notice info"><span class="ic">${icon('info')}</span>
          <div>Панель слушает <span class="inline-code">${esc(status.host)}</span> — она доступна только с этой
          машины, поэтому вход не спрашивается.<br><br>
          Чтобы открыть панель наружу: поставьте <span class="inline-code">panel.host</span> = 0.0.0.0,
          перезапустите панель — вход по мастер-ключам включится сам, и ключи появятся в её окне.</div></div>`;
      return;
    }

    const [keysData, sessionsData] = await Promise.all([
      api.authKeys().catch(() => ({ keys: [] })),
      api.authSessions().catch(() => ({ sessions: [] }))
    ]);

    box.innerHTML = `
      ${status.https
        ? ''
        : `<div class="notice warn mb"><span class="ic">${icon('alert')}</span>
            <div>Панель работает по HTTP: ключ и данные идут по сети открытым текстом. Для доступа из
            интернета поставьте её за reverse-proxy с сертификатом (Caddy, nginx) либо укажите пути к
            сертификату в <span class="inline-code">panel.tls</span> файла config.json.</div></div>`}

      <div class="notice info mb"><span class="ic">${icon('key')}</span>
        <div>Ключей ${status.keyCount}, сессия живёт ${status.sessionHours} ч.
        Ключи <b>новые при каждом запуске панели</b> и нигде не сохраняются на диск.</div></div>

      <div class="card-sub mb">Мастер-ключи</div>
      <div class="mod-list mb">
        ${keysData.keys
          .map(
            (k) => `
              <div class="mod-row">
                <div class="mod-thumb ph">${icon('key')}</div>
                <div class="mod-main">
                  <div class="mod-name" style="font-family:var(--mono);letter-spacing:.08em">${esc(k.key)}</div>
                  <div class="mod-meta"><span>ключ №${k.index}</span></div>
                </div>
                <div class="mod-actions">
                  <button class="btn btn-sm" data-copy="${esc(k.key)}">Скопировать</button>
                </div>
              </div>`
          )
          .join('')}
      </div>

      <div class="card-sub mb">Активные сессии</div>
      <div class="mod-list mb">
        ${sessionsData.sessions.length
          ? sessionsData.sessions
              .map(
                (s) => `
                  <div class="mod-row">
                    <div class="mod-thumb ph">${icon('users')}</div>
                    <div class="mod-main">
                      <div class="mod-name">${esc(s.ip)}${s.current ? ' — это вы' : ''}</div>
                      <div class="mod-meta">
                        <span>ключ №${s.keyIndex}</span>
                        <span>вход ${esc(fmtDate(s.createdAt))}</span>
                        <span>до ${esc(fmtDate(s.expiresAt))}</span>
                        ${s.agent ? `<span title="${esc(s.agent)}">${esc(s.agent.slice(0, 28))}…</span>` : ''}
                      </div>
                    </div>
                    <div class="mod-actions">
                      <button class="btn btn-sm btn-danger" data-close-session="${esc(s.id)}">
                        ${s.current ? 'Выйти' : 'Закрыть'}</button>
                    </div>
                  </div>`
              )
              .join('')
          : `<div class="small faint">Активных сессий нет.</div>`}
      </div>

      <div class="row wrap mb">
        <button class="btn" id="auth-rotate" type="button">${icon('refresh')} Выпустить новые ключи</button>
        <button class="btn btn-danger" id="auth-close-all" type="button">${icon('x')} Закрыть все сессии</button>
      </div>

      <div class="card-sub mb" style="margin-top:18px">Токены для интеграций</div>
      <div class="notice info mb"><span class="ic">${icon('link')}</span>
        <div>Сайту и Discord-боту мастер-ключи не подходят: они меняются при каждом запуске панели.
        Для них — постоянные токены: живут в конфиге, отзываются по одному.
        <span class="inline-code">read</span> — только чтение, <span class="inline-code">admin</span> — всё.</div></div>

      <div class="mod-list mb" id="token-list"></div>

      <div class="row wrap">
        <input type="text" id="token-name" placeholder="название: сайт, Discord-бот" style="width:220px">
        <select id="token-scope" style="width:180px">
          <option value="read">read — только чтение</option>
          <option value="admin">admin — полный доступ</option>
        </select>
        <button class="btn btn-primary" id="token-create" type="button">${icon('plus')} Создать токен</button>
      </div>`;

    const tokenBox = box.querySelector('#token-list');
    const renderTokens = async () => {
      let data = { tokens: [] };
      try {
        data = await api.authTokens();
      } catch (err) {
        tokenBox.innerHTML = `<div class="small faint">${esc(err.message)}</div>`;
        return;
      }

      tokenBox.innerHTML = data.tokens.length
        ? data.tokens
            .map(
              (t) => `
                <div class="mod-row">
                  <div class="mod-thumb ph">${icon('link')}</div>
                  <div class="mod-main">
                    <div class="mod-name">${esc(t.name)} <span class="badge ${t.scope === 'admin' ? 'warn' : ''}">${esc(t.scope)}</span></div>
                    <div class="mod-meta">
                      <span style="font-family:var(--mono)">${esc(t.preview)}</span>
                      ${t.createdAt ? `<span>создан ${esc(fmtDate(t.createdAt))}</span>` : ''}
                      <span>${t.lastUsedAt ? `использован ${esc(fmtDate(t.lastUsedAt))}` : 'ещё не использовался'}</span>
                    </div>
                  </div>
                  <div class="mod-actions">
                    <button class="btn btn-sm btn-danger" data-revoke="${esc(t.id)}">Отозвать</button>
                  </div>
                </div>`
            )
            .join('')
        : '<div class="small faint">Токенов пока нет.</div>';

      for (const btn of tokenBox.querySelectorAll('[data-revoke]')) {
        btn.addEventListener('click', (e) =>
          busy(e.currentTarget, async () => {
            const yes = await confirmDialog({
              title: 'Отозвать токен?',
              message: 'Интеграция, которая им пользуется, сразу потеряет доступ к панели.',
              confirmText: 'Отозвать',
              danger: true
            });
            if (!yes) return;

            await api.authRevokeToken(e.currentTarget.dataset.revoke);
            toast('Токен отозван', 'ok');
            await renderTokens();
          })
        );
      }
    };
    renderTokens();

    box.querySelector('#token-create').addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const name = box.querySelector('#token-name').value.trim();
        const scope = box.querySelector('#token-scope').value;
        const created = await api.authCreateToken(name, scope);

        box.querySelector('#token-name').value = '';
        showTokenModal(created);
        await renderTokens();
      })
    );

    for (const btn of box.querySelectorAll('[data-copy]')) {
      btn.addEventListener('click', async (e) => {
        const key = e.currentTarget.dataset.copy;
        try {
          await navigator.clipboard.writeText(key);
          toast('Ключ скопирован', 'ok');
        } catch (_) {
          toast(`Ключ: ${key}`, 'info', 12000);
        }
      });
    }

    for (const btn of box.querySelectorAll('[data-close-session]')) {
      btn.addEventListener('click', (e) =>
        busy(e.currentTarget, async () => {
          const id = e.currentTarget.dataset.closeSession;
          const mine = sessionsData.sessions.find((s) => s.id === id && s.current);

          await api.authCloseSession(id);
          if (mine) return (location.href = '/login.html');

          toast('Сессия закрыта', 'ok');
          await render();
        })
      );
    }

    box.querySelector('#auth-rotate').addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const yes = await confirmDialog({
          title: 'Выпустить новые ключи?',
          message: `Старые ключи перестанут работать сразу. Уже открытые сессии останутся —
            те, кто вошёл, продолжат работать.<br><br>Новые ключи появятся здесь и в окне панели.`,
          confirmText: 'Выпустить'
        });
        if (!yes) return;

        await api.authRotate();
        toast('Ключи выпущены заново', 'ok');
        await render();
      })
    );

    box.querySelector('#auth-close-all').addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const yes = await confirmDialog({
          title: 'Закрыть все сессии?',
          message: 'Все, кто сейчас в панели (включая вас), выйдут и будут вводить ключ заново.',
          confirmText: 'Закрыть все',
          danger: true
        });
        if (!yes) return;

        await api.authCloseSession('all');
        location.href = '/login.html';
      })
    );
  };

  render();
}

/**
 * Созданный токен показывается один раз: дальше в панели видно только начало
 * строки, как это принято с ключами доступа.
 */
function showTokenModal(created) {
  modal({
    title: 'Токен создан',
    subtitle: `${created.name} · ${created.scope}`,
    icon: 'link',
    wide: true,
    body: `
      <div class="col" style="gap:14px">
        <div class="notice warn"><span class="ic">${icon('alert')}</span>
          <div>Скопируйте его сейчас — панель больше не покажет значение целиком.</div></div>

        <div class="field">
          <label>Токен</label>
          <input type="text" id="token-value" value="${esc(created.token)}" readonly
                 style="font-family:var(--mono);font-size:13px">
        </div>

        <div class="field">
          <label>Как им пользоваться</label>
          <div class="inv-box" style="font-family:var(--mono);font-size:12px">
            curl -H "Authorization: Bearer ${esc(created.token)}" http://адрес:порт/api/status<br><br>
            для потока событий (EventSource заголовки не умеет):<br>
            /api/stream?token=${esc(created.token)}
          </div>
          <div class="hint">Полное описание для сайта и бота — docs/integration-prompt.md в репозитории.</div>
        </div>
      </div>`,
    footer: `<span class="spacer"></span><button class="btn btn-primary" data-close>Готово</button>`,
    onMount: (m) => {
      const input = m.body.querySelector('#token-value');
      input.select();
      navigator.clipboard.writeText(created.token).then(
        () => toast('Токен скопирован в буфер', 'ok'),
        () => {}
      );
    }
  });
}

/* ------------------------------------------------------ сообщения в игру */

/**
 * Канал сообщений: показ текущего состояния и три кнопки — проверить RCon,
 * создать конфиг BattlEye и отправить тестовое сообщение в чат.
 */
function bindIngame() {
  const stateEl = paneRef.querySelector('#ingame-state');

  const showState = async () => {
    try {
      const data = await api.ingame();
      const d = data.delivery;
      stateEl.textContent = d.ok
        ? `канал готов: ${d.channel === 'battleye' ? 'BattlEye RCon' : 'CFTools'}, до ${d.maxLength} символов`
        : `канал не готов — ${d.reason}`;
      stateEl.classList.toggle('faint', d.ok);
    } catch (err) {
      stateEl.textContent = err.message;
    }
  };
  showState();

  paneRef.querySelector('#be-test').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const r = await api.battleyeTest();
      toast(
        `BattlEye RCon отвечает (${r.host}:${r.port}, порт ${r.portFrom}). Игроков онлайн: ${r.playersOnline}`,
        'ok',
        10000
      );
      await showState();
    })
  );

  paneRef.querySelector('#be-setup').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const status = await api.battleye();
      if (status.configFile) {
        const yes = await confirmDialog({
          title: 'Файл настроек BattlEye уже есть',
          message: `Найден <span class="inline-code">${esc(status.configFile)}</span>,
            пароль RCon ${status.hasPassword ? 'в нём есть' : '<b>отсутствует</b>'}.<br><br>
            Перезаписать его новым паролем? Старый пароль перестанет работать,
            а изменения применятся после перезапуска сервера.`,
          confirmText: 'Перезаписать',
          danger: true
        });
        if (!yes) return;
      }

      const result = await api.battleyeSetup({ force: Boolean(status.configFile) });
      modal({
        title: result.created ? 'BattlEye настроен' : 'Файл уже был настроен',
        subtitle: result.path,
        icon: 'key',
        body: `
          <div class="col" style="gap:12px">
            <div class="notice ${result.created ? 'ok' : 'info'}"><span class="ic">${icon('check')}</span>
              <div>${esc(result.message)}</div></div>
            ${result.created
              ? `<div class="field">
                   <label>Пароль RCon</label>
                   <input type="text" value="${esc(result.password)}" readonly>
                   <div class="hint">Панель возьмёт его из файла сама. Тот же пароль можно вписать
                     в BEC или DaRT, если пользуетесь ими.</div>
                 </div>
                 <div class="field">
                   <label>RCon-порт</label>
                   <input type="text" value="${esc(String(result.port))}" readonly>
                 </div>`
              : ''}
          </div>`,
        footer: `<span class="spacer"></span><button class="btn btn-primary" data-close>Понятно</button>`
      });
      await showState();
    })
  );

  paneRef.querySelector('#ingame-say').addEventListener('click', () => {
    askText({
      title: 'Тестовое сообщение в чат',
      subtitle: 'Уйдёт всем игрокам на сервере прямо сейчас',
      label: 'Текст',
      value: 'Проверка связи из панели',
      confirmText: 'Отправить',
      onSubmit: async (value) => {
        const r = await api.ingameSay(value);
        toast(`Отправлено через ${r.channel === 'battleye' ? 'BattlEye RCon' : 'CFTools'}: ${r.text}`, 'ok', 9000);
        await showState();
      }
    });
  });
}

/** Окно с одним текстовым полем. */
function askText(opts) {
  const m = modal({
    title: opts.title,
    subtitle: opts.subtitle,
    icon: 'file',
    body: `
      <div class="field">
        <label>${esc(opts.label)}</label>
        <input type="text" id="ask-value" value="${esc(opts.value || '')}">
      </div>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn btn-primary" id="ask-go">${esc(opts.confirmText)}</button>`
  });

  m.footer.querySelector('#ask-go').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const value = m.body.querySelector('#ask-value').value.trim();
      if (!value) return toast('Заполните поле', 'warn');
      await opts.onSubmit(value);
      m.close();
    })
  );
}

/* ----------------------------------------------------- объявления в чат */

/** Подпись под кнопками: когда уйдёт следующее объявление. */
function announcementHint(serverId) {
  const st = announcementsOf(serverId);
  if (!st.enabled) return 'объявления выключены';
  if (!st.count) return 'список сообщений пуст';
  if (st.secondsLeft === null) return 'отсчёт начнётся, когда сервер запустится';

  const minutes = Math.ceil(st.secondsLeft / 60);
  return `следующее объявление примерно через ${minutes} мин. (сообщений: ${st.count})`;
}

/** Строки из textarea -> список сообщений. */
function parseAnnouncements(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function bindAnnouncements() {
  const area = paneRef.querySelector('[data-special="announcements"]');
  const counter = paneRef.querySelector('#ann-count');

  const sync = () => {
    counter.textContent = String(parseAnnouncements(area.value).length);
  };
  area.addEventListener('input', sync);
  sync();

  paneRef.querySelector('#ann-preview').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const texts = parseAnnouncements(area.value);
      if (!texts.length) return toast('Сначала впишите хотя бы одно сообщение', 'warn');

      const { preview } = await api.previewAnnouncements(texts);
      modal({
        title: 'Как это увидят игроки',
        subtitle: 'Подстановки уже раскрыты',
        icon: 'users',
        wide: true,
        body: `<div class="col" style="gap:10px">
          ${preview
            .map(
              (p, i) => `
                <div class="notice ${p.tooLong ? 'err' : 'info'}">
                  <span class="ic">${icon(p.tooLong ? 'alert' : 'users')}</span>
                  <div><b>№${i + 1}</b> · ${p.length} символов${p.tooLong ? ' — слишком длинно, не отправится' : ''}<br>
                  ${esc(p.text)}</div>
                </div>`
            )
            .join('')}
        </div>`,
        footer: `<span class="spacer"></span><button class="btn" data-close>Закрыть</button>`
      });
    })
  );

  paneRef.querySelector('#ann-send').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const texts = parseAnnouncements(area.value);
      if (!texts.length) return toast('Сначала впишите хотя бы одно сообщение', 'warn');

      // Отправляем текстом, а не номером: так кнопка работает и до сохранения.
      const result = await api.sendAnnouncement({ text: texts[0] });
      toast(`Отправлено игрокам: ${result.text}`, 'ok', 9000);
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
