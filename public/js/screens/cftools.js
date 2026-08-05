/**
 * Вкладка «CFTools» — то, что панель не может узнать у сервера сама:
 * кто сейчас играет, кого забанили, что происходит в игре.
 *
 * Вкладка появляется только когда интеграция включена в настройках сервера.
 * Пока она выключена, здесь короткая подсказка, как её включить, и ни одного
 * запроса в интернет.
 */

import { api } from '../api.js';
import { state, on } from '../store.js';
import { esc, icon, toast, busy, modal, confirmDialog, fmtUptime, fmtDate } from '../ui.js';

let paneRef = null;
let timer = null;
/** Последний ответ сервиса — чтобы кнопки действий знали, с кем работают. */
let cache = { players: [], bans: [], info: null, status: null };

export function initCFToolsTab(pane) {
  paneRef = pane;
  pane.__load = load;

  // Список игроков живёт своей жизнью, поэтому обновляем его сами — но только
  // пока вкладка открыта, чтобы не тратить лимит запросов CFTools впустую.
  timer = setInterval(() => {
    if (paneRef && paneRef.classList.contains('active') && cache.status && cache.status.ready) {
      refreshPlayers().catch(() => {});
    }
  }, 30_000);

  on('servers', () => {
    // Переключили сервер — прежние данные к нему не относятся.
    cache = { players: [], bans: [], info: null, status: null };
  });
}

export function stopCFToolsTab() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ---------------------------------------------------------------- загрузка */

async function load() {
  if (!paneRef) return;

  paneRef.innerHTML = `<div class="card"><div class="small faint">Проверяю настройки CFTools…</div></div>`;

  let status;
  try {
    status = await api.cfStatus();
  } catch (err) {
    paneRef.innerHTML = notice('err', 'alert', esc(err.message));
    return;
  }
  cache.status = status;

  if (!status.enabled) return renderDisabled();
  if (!status.hasApplicationId || !status.hasSecret || !status.serverApiId) return renderIncomplete(status);

  renderShell(status);
  await Promise.all([refreshInfo(), refreshPlayers(), status.banlistId ? refreshBans() : Promise.resolve()]);
}

const notice = (kind, ic, html) =>
  `<div class="card"><div class="notice ${kind}"><span class="ic">${icon(ic)}</span><div>${html}</div></div></div>`;

function openSettings() {
  const tab = document.querySelector('#dash-tabs [data-tab="settings"]');
  if (tab) tab.click();
}

function renderDisabled() {
  paneRef.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('link')}</span>
        <div><h2>CFTools Cloud не подключён</h2>
          <div class="card-sub">Интеграция необязательная и по умолчанию выключена</div></div>
      </div>
      <div class="notice info mb"><span class="ic">${icon('info')}</span>
        <div>Панель управляет сервером «снизу» — файлами, процессом, модами. CFTools Cloud смотрит на тот же
        сервер «сверху»: список игроков, кик, баны, сообщения в игру, RCon-команды. Включите интеграцию, если
        сервер уже подключён к CFTools — тогда всё это будет доступно прямо здесь.</div></div>
      <div class="row wrap">
        <button class="btn btn-primary" id="cf-open-settings">${icon('settings')} Открыть настройки сервера</button>
      </div>
    </div>`;

  paneRef.querySelector('#cf-open-settings').addEventListener('click', openSettings);
}

function renderIncomplete(status) {
  const missing = [
    !status.hasApplicationId && 'Application ID',
    !status.hasSecret && 'Secret',
    !status.serverApiId && 'Server API ID этого сервера'
  ].filter(Boolean);

  paneRef.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('alert')}</span>
        <div><h2>Интеграция включена, но не настроена</h2>
          <div class="card-sub">Не заполнено: ${esc(missing.join(', '))}</div></div>
      </div>
      <div class="notice warn mb"><span class="ic">${icon('alert')}</span>
        <div>Ключи создаются на developer.cftools.cloud, там же приложению выдаются гранты на сервер и банлист.
        В настройках сервера есть кнопка «Мои ресурсы в CFTools» — она подставит нужные ID.</div></div>
      <button class="btn btn-primary" id="cf-open-settings">${icon('settings')} Открыть настройки сервера</button>
    </div>`;

  paneRef.querySelector('#cf-open-settings').addEventListener('click', openSettings);
}

/* ----------------------------------------------------------------- разметка */

function renderShell(status) {
  paneRef.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('link')}</span>
        <div><h2>Сервер в CFTools</h2><div class="card-sub" id="cf-sub">—</div></div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="cf-reload">${icon('restart')} Обновить</button>
      </div>
      <div id="cf-info"><div class="small faint">Запрашиваю данные…</div></div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('zap')}</span>
        <div><h2>Сообщения и команды</h2>
          <div class="card-sub">Уходят на сервер через CFTools — сервер должен быть онлайн</div></div>
      </div>
      <div class="form-grid one">
        <div class="field">
          <label>Сообщение всем игрокам <span class="badge">до 256 символов</span></label>
          <div class="row">
            <input type="text" id="cf-broadcast" placeholder="Перезапуск через 10 минут" style="flex:1;min-width:0">
            <button class="btn btn-primary" id="cf-broadcast-go">${icon('users')} Отправить</button>
          </div>
        </div>
        <div class="field">
          <label>RCon-команда <span class="badge">осторожно</span></label>
          <div class="row">
            <input type="text" id="cf-rcon" placeholder="#shutdown" style="flex:1;min-width:0">
            <button class="btn btn-danger" id="cf-rcon-go">${icon('terminal')} Выполнить</button>
          </div>
          <div class="hint">Команда уходит серверу как есть, без подтверждения со стороны игры.</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('users')}</span>
        <div><h2>Игроки онлайн</h2><div class="card-sub" id="cf-players-sub">—</div></div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="cf-players-reload">${icon('refresh')} Обновить список</button>
      </div>
      <div class="mod-list" id="cf-players"></div>
    </div>

    ${status.banlistId
      ? `<div class="card">
          <div class="card-head">
            <span class="card-title-icon">${icon('shield')}</span>
            <div><h2>Баны</h2><div class="card-sub" id="cf-bans-sub">банлист ${esc(status.banlistId)}</div></div>
            <span class="spacer"></span>
            <div class="row wrap">
              <input type="text" id="cf-ban-filter" placeholder="CFTools ID, IP или комментарий" style="width:230px">
              <button class="btn btn-sm" id="cf-bans-reload">${icon('search')} Найти</button>
              <button class="btn btn-sm btn-danger" id="cf-ban-add">${icon('plus')} Забанить</button>
            </div>
          </div>
          <div class="mod-list" id="cf-bans"></div>
        </div>`
      : `<div class="card">
          <div class="notice info"><span class="ic">${icon('info')}</span>
            <div>Banlist ID не указан — список банов и кнопка «Забанить» появятся, когда он будет заполнен
            в настройках сервера.</div></div>
        </div>`}`;

  paneRef.querySelector('#cf-reload').addEventListener('click', (e) => busy(e.currentTarget, load));
  paneRef.querySelector('#cf-players-reload').addEventListener('click', (e) => busy(e.currentTarget, refreshPlayers));

  paneRef.querySelector('#cf-broadcast-go').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const input = paneRef.querySelector('#cf-broadcast');
      await api.cfBroadcast(input.value);
      input.value = '';
      toast('Сообщение отправлено всем игрокам', 'ok');
    })
  );

  paneRef.querySelector('#cf-rcon-go').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const input = paneRef.querySelector('#cf-rcon');
      const command = input.value.trim();
      if (!command) return toast('Введите команду', 'warn');

      const yes = await confirmDialog({
        title: 'Выполнить RCon-команду?',
        message: `Серверу будет отправлено: <span class="inline-code">${esc(command)}</span><br><br>
          Команды вроде <span class="inline-code">#shutdown</span> останавливают сервер немедленно,
          без предупреждения игроков.`,
        confirmText: 'Выполнить',
        danger: true
      });
      if (!yes) return;

      await api.cfRcon(command);
      input.value = '';
      toast('Команда отправлена', 'ok');
    })
  );

  const bansReload = paneRef.querySelector('#cf-bans-reload');
  if (bansReload) {
    bansReload.addEventListener('click', (e) => busy(e.currentTarget, refreshBans));
    paneRef.querySelector('#cf-ban-add').addEventListener('click', () => openBanModal());
    paneRef.querySelector('#cf-ban-filter').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') refreshBans().catch((err) => toast(err.message, 'err'));
    });
  }
}

/* -------------------------------------------------------------- информация */

async function refreshInfo() {
  const box = paneRef && paneRef.querySelector('#cf-info');
  if (!box) return;

  let info;
  try {
    info = await api.cfServer();
  } catch (err) {
    box.innerHTML = `<div class="notice err"><span class="ic">${icon('alert')}</span><div>${esc(err.message)}</div></div>`;
    return;
  }
  cache.info = info;

  const sub = paneRef.querySelector('#cf-sub');
  if (sub) sub.textContent = info.nickname || cache.status.serverApiId;

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat ${info.online ? 'accent' : 'warn'}">
        <div class="k">${icon('activity')} связь CFTools</div>
        <div class="v" style="font-size:19px">${info.online ? 'подключён' : 'нет связи'}</div>
        <div class="s">${esc(info.workerState.replace('WorkerState.', '').toLowerCase() || '—')}</div>
      </div>
      <div class="stat">
        <div class="k">${icon('clock')} аптайм по CFTools</div>
        <div class="v" style="font-size:19px">${info.uptimeSec ? fmtUptime(info.uptimeSec) : '—'}</div>
        <div class="s">игровое время ${esc(info.gametime || '—')}</div>
      </div>
      <div class="stat">
        <div class="k">${icon('restart')} следующий перезапуск</div>
        <div class="v" style="font-size:17px">${info.nextRestart ? esc(String(info.nextRestart)) : '—'}</div>
        <div class="s">по расписанию CFTools</div>
      </div>
      <div class="stat ${info.integration.status ? '' : 'warn'}">
        <div class="k">${icon('package')} игровая интеграция</div>
        <div class="v" style="font-size:19px">${info.integration.status ? 'активна' : 'нет'}</div>
        <div class="s">${info.integration.version ? `версия ${esc(info.integration.version)}` : 'мод CFTools не отвечает'}</div>
      </div>
    </div>
    ${info.integration.status
      ? ''
      : `<div class="notice warn" style="margin-top:14px"><span class="ic">${icon('alert')}</span>
          <div>Игровая интеграция CFTools не отвечает. Список игроков, кик и сообщения в игру работают
          только когда на сервере установлен и запущен мод CFTools (или GameLabs).</div></div>`}`;
}

/* ------------------------------------------------------------------ игроки */

async function refreshPlayers() {
  const list = paneRef && paneRef.querySelector('#cf-players');
  if (!list) return;

  let players;
  try {
    players = (await api.cfPlayers()).players;
  } catch (err) {
    list.innerHTML = `<div class="notice err"><span class="ic">${icon('alert')}</span><div>${esc(err.message)}</div></div>`;
    return;
  }
  cache.players = players;

  const sub = paneRef.querySelector('#cf-players-sub');
  if (sub) {
    const max = (state.servers.find((s) => s.id === state.activeServerId) || {}).maxPlayers;
    sub.textContent = `${players.length}${max ? ` из ${max}` : ''} · обновляется каждые 30 секунд`;
  }

  if (!players.length) {
    list.innerHTML = `<div class="notice info"><span class="ic">${icon('users')}</span>
      <div>Сейчас на сервере никого нет.</div></div>`;
    return;
  }

  list.innerHTML = players
    .map((p) => {
      const badges = [
        p.ping ? `<span>${p.ping} мс</span>` : '',
        p.countryName ? `<span>${esc(p.countryName)}</span>` : p.country ? `<span>${esc(p.country)}</span>` : '',
        p.banCount ? `<span class="badge warn">банов: ${p.banCount}</span>` : '',
        p.malicious ? '<span class="badge warn">подозрительный IP</span>' : '',
        p.loaded ? '' : '<span class="badge">загружается</span>',
        p.createdAt ? `<span>в игре с ${esc(fmtDate(p.createdAt))}</span>` : ''
      ]
        .filter(Boolean)
        .join('');

      return `
        <div class="mod-row">
          <div class="mod-thumb ph">${icon('users')}</div>
          <div class="mod-main">
            <div class="mod-name">${esc(p.name)}</div>
            <div class="mod-meta">${badges}<span title="Steam64">${esc(p.steam64 || p.cftoolsId)}</span></div>
          </div>
          <div class="mod-actions">
            <button class="btn btn-sm" data-act="msg" data-id="${esc(p.sessionId)}">${icon('file')} ЛС</button>
            <button class="btn btn-sm" data-act="kick" data-id="${esc(p.sessionId)}">${icon('x')} Кик</button>
            ${cache.status.banlistId
              ? `<button class="btn btn-sm btn-danger" data-act="ban" data-id="${esc(p.cftoolsId)}">
                  ${icon('shield')} Бан</button>`
              : ''}
          </div>
        </div>`;
    })
    .join('');

  for (const btn of list.querySelectorAll('[data-act]')) {
    btn.addEventListener('click', () => {
      const { act, id } = btn.dataset;
      const player =
        cache.players.find((p) => p.sessionId === id) || cache.players.find((p) => p.cftoolsId === id) || {};

      if (act === 'msg') openMessageModal(player);
      if (act === 'kick') openKickModal(player);
      if (act === 'ban') openBanModal(player);
    });
  }
}

function openMessageModal(player) {
  askText({
    title: `Сообщение для ${player.name || 'игрока'}`,
    subtitle: 'Игрок увидит его прямо в игре',
    label: 'Текст сообщения',
    placeholder: 'Не строй на дороге, пожалуйста',
    confirmText: 'Отправить',
    onSubmit: async (value) => {
      await api.cfMessage(player.sessionId, value);
      toast('Сообщение отправлено', 'ok');
    }
  });
}

function openKickModal(player) {
  askText({
    title: `Выкинуть ${player.name || 'игрока'}?`,
    subtitle: 'Игрок сможет зайти снова — это не бан',
    label: 'Причина (увидит игрок)',
    value: 'Kicked by admin',
    confirmText: 'Выкинуть',
    danger: true,
    onSubmit: async (value) => {
      await api.cfKick(player.sessionId, value);
      toast(`${player.name || 'Игрок'} исключён`, 'ok');
      await refreshPlayers();
    }
  });
}

/* -------------------------------------------------------------------- баны */

const DURATIONS = [
  { value: '', label: 'Навсегда' },
  { value: '3600', label: '1 час' },
  { value: '86400', label: '1 день' },
  { value: '604800', label: '7 дней' },
  { value: '2592000', label: '30 дней' }
];

function openBanModal(player = {}) {
  const m = modal({
    title: player.name ? `Забанить ${player.name}` : 'Забанить игрока',
    subtitle: 'Бан добавляется в банлист CFTools',
    icon: 'shield',
    body: `
      <div class="form-grid one">
        <div class="field">
          <label>Кого банить</label>
          <input type="text" id="ban-identifier" value="${esc(player.cftoolsId || '')}"
                 placeholder="CFTools ID, Steam64 или IPv4">
          <div class="hint">Steam64 панель сама превратит в CFTools ID.</div>
        </div>
        <div class="field">
          <label>Тип</label>
          <select id="ban-format">
            <option value="cftools_id">Игрок (CFTools ID / Steam64)</option>
            <option value="ipv4">IP-адрес</option>
          </select>
        </div>
        <div class="field">
          <label>Срок</label>
          <select id="ban-duration">
            ${DURATIONS.map((d) => `<option value="${d.value}">${d.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Причина <span class="badge">до 128 символов</span></label>
          <input type="text" id="ban-reason" value="Banned by admin">
        </div>
      </div>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn btn-danger" id="ban-go">${icon('shield')} Забанить</button>`
  });

  m.footer.querySelector('#ban-go').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const seconds = Number(m.body.querySelector('#ban-duration').value) || 0;
      await api.cfBan({
        identifier: m.body.querySelector('#ban-identifier').value.trim(),
        format: m.body.querySelector('#ban-format').value,
        reason: m.body.querySelector('#ban-reason').value,
        expiresAt: seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null
      });

      m.close();
      toast('Бан добавлен', 'ok');
      await refreshBans();
      await refreshPlayers();
    })
  );
}

async function refreshBans() {
  const list = paneRef && paneRef.querySelector('#cf-bans');
  if (!list) return;

  const filterInput = paneRef.querySelector('#cf-ban-filter');
  let bans;
  try {
    bans = (await api.cfBans(filterInput ? filterInput.value.trim() : '')).bans;
  } catch (err) {
    list.innerHTML = `<div class="notice err"><span class="ic">${icon('alert')}</span><div>${esc(err.message)}</div></div>`;
    return;
  }
  cache.bans = bans;

  if (!bans.length) {
    list.innerHTML = `<div class="notice info"><span class="ic">${icon('shield')}</span>
      <div>Банов не найдено.</div></div>`;
    return;
  }

  list.innerHTML = bans
    .map(
      (b) => `
        <div class="mod-row">
          <div class="mod-thumb ph">${icon('shield')}</div>
          <div class="mod-main">
            <div class="mod-name">${esc(b.identifier)}</div>
            <div class="mod-meta">
              <span class="badge ${b.status === 'ACTIVE' ? 'warn' : ''}">${esc(b.status.toLowerCase())}</span>
              <span>${esc(b.reason || 'без причины')}</span>
              <span>${b.expiresAt ? `до ${esc(fmtDate(b.expiresAt))}` : 'навсегда'}</span>
              ${b.createdAt ? `<span>выдан ${esc(fmtDate(b.createdAt))}</span>` : ''}
            </div>
          </div>
          <div class="mod-actions">
            <button class="btn btn-sm" data-unban="${esc(b.id)}">${icon('check')} Снять</button>
          </div>
        </div>`
    )
    .join('');

  for (const btn of list.querySelectorAll('[data-unban]')) {
    btn.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const ban = cache.bans.find((b) => b.id === btn.dataset.unban) || {};
        const yes = await confirmDialog({
          title: 'Снять бан?',
          message: `Бан <b>${esc(ban.identifier || btn.dataset.unban)}</b> будет удалён из банлиста CFTools.`,
          confirmText: 'Снять бан'
        });
        if (!yes) return;

        await api.cfUnban(btn.dataset.unban);
        toast('Бан снят', 'ok');
        await refreshBans();
      })
    );
  }
}

/* ------------------------------------------------------------- мелкий диалог */

/** Окно с одним текстовым полем: используется для ЛС и кика. */
function askText(opts) {
  const m = modal({
    title: opts.title,
    subtitle: opts.subtitle,
    icon: opts.danger ? 'alert' : 'file',
    body: `
      <div class="field">
        <label>${esc(opts.label)}</label>
        <input type="text" id="ask-value" value="${esc(opts.value || '')}"
               placeholder="${esc(opts.placeholder || '')}">
      </div>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" id="ask-go">${esc(opts.confirmText)}</button>`
  });

  const submit = (e) =>
    busy(e.currentTarget, async () => {
      const value = m.body.querySelector('#ask-value').value.trim();
      if (!value) return toast('Заполните поле', 'warn');
      await opts.onSubmit(value);
      m.close();
    });

  m.footer.querySelector('#ask-go').addEventListener('click', submit);
  m.body.querySelector('#ask-value').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') m.footer.querySelector('#ask-go').click();
  });
}
