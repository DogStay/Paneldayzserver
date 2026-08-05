'use strict';

/* DayZ Panel — фронтенд без сборки и внешних зависимостей. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let currentConfig = null;
let currentStatus = { status: 'stopped' };

/* ------------------------------------------------------------------ helpers */

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { error: text };
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 5000);
}

/** Кнопка на время запроса становится неактивной. */
async function withBusy(btn, fn) {
  const label = btn ? btn.textContent : null;
  if (btn) {
    btn.disabled = true;
    btn.dataset.label = label;
    btn.textContent = '…';
  }
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'err');
    throw err;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.label;
    }
  }
}

function get(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function set(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const part of parts) {
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[last] = value;
}

function fmtUptime(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}ч ${m}м` : m ? `${m}м ${s}с` : `${s}с`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU');
}

function fmtUnix(sec) {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleString('ru-RU');
}

/* --------------------------------------------------------------------- табы */

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'bat') loadBat();
    if (tab.dataset.tab === 'firewall') loadFirewall();
    if (tab.dataset.tab === 'cfg') loadServerCfg();
  });
});

/* ------------------------------------------------------------------- статус */

const STATUS_LABEL = {
  stopped: 'Остановлен',
  preparing: 'Подготовка…',
  running: 'Запущен',
  stopping: 'Останавливается…'
};

function renderStatus(status) {
  currentStatus = status;
  $('#status-dot').className = `dot ${status.status}`;
  $('#status-text').textContent = STATUS_LABEL[status.status] || status.status;

  const meta = [];
  if (status.pid) meta.push(`PID ${status.pid}`);
  if (status.uptimeSec) meta.push(`аптайм ${fmtUptime(status.uptimeSec)}`);
  if (status.status === 'stopped' && status.exitCode !== null && status.exitCode !== undefined) {
    meta.push(`код выхода ${status.exitCode}`);
  }
  if (status.lastError) meta.push(status.lastError);
  $('#status-meta').textContent = meta.join(' · ');

  const busy = status.status === 'preparing' || status.status === 'stopping';
  $('#btn-start').disabled = busy || status.status === 'running';
  $('#btn-stop').disabled = busy || status.status !== 'running';
  $('#btn-restart').disabled = busy;
}

async function refreshStatus() {
  try {
    const data = await api('GET', '/status');
    renderStatus(data.server);
    const banner = $('#problems');
    if (data.problems && data.problems.length) {
      banner.innerHTML = `<b>Требуется настройка:</b> ${data.problems.map(escapeHtml).join(' · ')}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch (err) {
    $('#status-text').textContent = 'нет связи с панелью';
  }
}

/* ---------------------------------------------------------------------- SSE */

function connectStream() {
  const source = new EventSource('/api/logs/stream');

  source.addEventListener('open', () => {
    $('#sse-state').textContent = 'поток подключён';
  });
  source.addEventListener('backlog', (e) => {
    const entries = JSON.parse(e.data);
    $('#log').innerHTML = '';
    entries.forEach(appendLog);
    scrollLog();
  });
  source.addEventListener('log', (e) => {
    appendLog(JSON.parse(e.data));
    scrollLog();
  });
  source.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));
  source.addEventListener('error', () => {
    $('#sse-state').textContent = 'поток разорван, переподключение…';
  });
}

const MAX_LOG_NODES = 1500;

function appendLog(entry) {
  const filter = $('#log-filter').value;
  const box = $('#log');

  const line = document.createElement('div');
  line.className = `log-line ${entry.level}`;
  line.dataset.source = entry.source;
  if (filter && filter !== entry.source) line.style.display = 'none';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(entry.ts).toLocaleTimeString('ru-RU');

  const src = document.createElement('span');
  src.className = `log-src ${entry.source}`;
  src.textContent = entry.source;

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = entry.message;

  line.append(time, src, msg);
  box.appendChild(line);

  while (box.childElementCount > MAX_LOG_NODES) box.removeChild(box.firstChild);
}

function scrollLog() {
  if ($('#log-autoscroll').checked) {
    const box = $('#log');
    box.scrollTop = box.scrollHeight;
  }
}

$('#log-filter').addEventListener('change', () => {
  const filter = $('#log-filter').value;
  $$('.log-line').forEach((line) => {
    line.style.display = !filter || line.dataset.source === filter ? '' : 'none';
  });
  scrollLog();
});

$('#btn-log-clear').addEventListener('click', async () => {
  await api('DELETE', '/logs');
  $('#log').innerHTML = '';
});

/* --------------------------------------------------------------- управление */

$('#btn-start').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const result = await api('POST', '/server/start', {});
    const updated = result.summary && result.summary.mods && result.summary.mods.updated;
    toast(updated && updated.length ? `Сервер запущен. Обновлено модов: ${updated.length}` : 'Сервер запущен', 'ok');
    loadMods();
  })
);

$('#btn-stop').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    await api('POST', '/server/stop', {});
    toast('Сервер остановлен', 'ok');
  })
);

$('#btn-restart').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    await api('POST', '/server/restart', {});
    toast('Сервер перезапущен', 'ok');
  })
);

/* --------------------------------------------------------------------- моды */

async function loadMods() {
  const data = await api('GET', '/mods');
  renderMods(data.mods);
  renderOrphans(data.orphans);
}

function renderMods(mods) {
  const box = $('#mods-list');
  box.innerHTML = '';

  if (!mods.length) {
    box.innerHTML = '<div class="empty">Модов пока нет. Добавьте мод по Workshop ID выше.</div>';
    return;
  }

  for (const mod of mods) {
    const el = document.createElement('div');
    el.className = `mod ${mod.enabled ? '' : 'disabled'}`;
    el.draggable = true;
    el.dataset.id = mod.id;

    const badges = [];
    if (mod.type === 'server') badges.push('<span class="badge srv">serverMod</span>');
    if (!mod.downloaded) badges.push('<span class="badge err">не скачан</span>');
    else if (!mod.deployed) badges.push('<span class="badge warn">не разложен</span>');
    else badges.push('<span class="badge ok">готов</span>');
    if (mod.updateAvailable) badges.push('<span class="badge warn">есть обновление</span>');
    if (mod.hasKeys) badges.push('<span class="badge">keys</span>');

    el.innerHTML = `
      <span class="mod-grip" title="Перетащите, чтобы изменить порядок">⠿</span>
      <input type="checkbox" ${mod.enabled ? 'checked' : ''} title="Включить/выключить мод">
      <div class="mod-main">
        <div class="mod-name">${escapeHtml(mod.name)} ${badges.join(' ')}</div>
        <div class="mod-meta">
          <span>ID ${mod.id}</span>
          <span>${escapeHtml(mod.folder)}</span>
          <span>${mod.sizeMb ? mod.sizeMb + ' МБ' : '—'}</span>
          <span>версия: ${fmtUnix(mod.installedTimeupdated)}</span>
          <span>проверен: ${fmtDate(mod.lastUpdateCheck)}</span>
        </div>
      </div>
      <div class="mod-actions">
        <a class="btn btn-small" href="https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.id}"
           target="_blank" rel="noreferrer">Workshop</a>
        <button class="btn btn-small" data-act="type">${mod.type === 'server' ? '→ клиентский' : '→ серверный'}</button>
        <button class="btn btn-small btn-danger" data-act="remove">Удалить</button>
      </div>`;

    el.querySelector('input[type="checkbox"]').addEventListener('change', async (e) => {
      await api('PATCH', `/mods/${mod.id}`, { enabled: e.target.checked });
      loadMods();
    });

    el.querySelector('[data-act="type"]').addEventListener('click', async (e) =>
      withBusy(e.target, async () => {
        await api('PATCH', `/mods/${mod.id}`, { type: mod.type === 'server' ? 'client' : 'server' });
        loadMods();
      })
    );

    el.querySelector('[data-act="remove"]').addEventListener('click', async (e) => {
      if (!confirm(`Удалить «${mod.name}» из списка панели?\n\nOK — удалить и папку @-мода из каталога сервера,\nОтмена — прервать.`)) return;
      await withBusy(e.target, async () => {
        await api('DELETE', `/mods/${mod.id}?deleteFiles=1`);
        toast('Мод удалён', 'ok');
        loadMods();
      });
    });

    box.appendChild(el);
  }

  enableDragReorder(box);
}

function renderOrphans(orphans) {
  const card = $('#orphans-card');
  const box = $('#orphans-list');
  box.innerHTML = '';

  if (!orphans || !orphans.length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  for (const item of orphans) {
    const el = document.createElement('div');
    el.className = 'mod';
    el.innerHTML = `
      <div class="mod-main">
        <div class="mod-name">${escapeHtml(item.name)}</div>
        <div class="mod-meta"><span>ID ${item.id}</span><span>${escapeHtml(item.folder)}</span><span>${item.sizeMb} МБ</span></div>
      </div>
      <div class="mod-actions"><button class="btn btn-small btn-primary">Подключить</button></div>`;

    el.querySelector('button').addEventListener('click', (e) =>
      withBusy(e.target, async () => {
        await api('POST', '/mods/adopt', { id: item.id });
        toast(`Мод «${item.name}» подключён`, 'ok');
        loadMods();
      })
    );
    box.appendChild(el);
  }
}

/** Перетаскивание строк для изменения порядка в -mod=. */
function enableDragReorder(box) {
  let dragged = null;

  box.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.mod');
    if (!row) return;
    dragged = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  box.addEventListener('dragend', async () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    const ids = $$('.mod', box).map((el) => el.dataset.id).filter(Boolean);
    try {
      await api('POST', '/mods/reorder', { ids });
    } catch (err) {
      toast(err.message, 'err');
    }
    loadMods();
  });

  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragged) return;
    const target = e.target.closest('.mod');
    if (!target || target === dragged) return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    box.insertBefore(dragged, after ? target.nextSibling : target);
  });
}

$('#btn-add-mod').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const id = $('#mod-id').value.trim();
    if (!id) return toast('Укажите Workshop ID', 'warn');
    toast('SteamCMD скачивает мод, следите за логом…');
    const data = await api('POST', '/mods', { id, type: $('#mod-type').value });
    $('#mod-id').value = '';
    toast(`Мод «${data.mod.name}» добавлен`, 'ok');
    renderMods(data.mods);
    renderOrphans(data.orphans);
  })
);

$('#mod-id').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-add-mod').click();
});

$('#btn-check-updates').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    toast('Проверяю обновления через SteamCMD…');
    const data = await api('POST', '/mods/update', {});
    const { updated, failed } = data.report;
    if (failed.length) toast(`Ошибок: ${failed.length}. Подробности в логе.`, 'err');
    toast(updated.length ? `Обновлено модов: ${updated.length}` : 'Все моды актуальны', 'ok');
    renderMods(data.mods);
    renderOrphans(data.orphans);
  })
);

$('#btn-deploy').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const data = await api('POST', '/mods/deploy', {});
    const bad = data.report.filter((r) => !r.ok);
    toast(bad.length ? `Не разложено: ${bad.length}` : 'Моды разложены в папку сервера', bad.length ? 'err' : 'ok');
    renderMods(data.mods);
    renderOrphans(data.orphans);
  })
);

$('#btn-refresh-mods').addEventListener('click', (e) => withBusy(e.target, loadMods));

/* ---------------------------------------------------------------- настройки */

const SIMPLE_FIELDS = [
  'paths.serverPath', 'paths.serverExe', 'paths.steamcmdExe', 'paths.workshopContentDir',
  'paths.profilesFolder', 'paths.configFile', 'paths.batFile',
  'server.name', 'server.maxPlayers', 'server.gamePort', 'server.steamQueryPort',
  'server.cpuCount', 'server.limitFPS',
  'steam.username',
  'features.deployMode', 'features.launchMode',
  'panel.host', 'panel.port'
];

const CHECKBOXES = [
  'steam.anonymous',
  'features.autoFirewall', 'features.autoUpdateMods',
  'features.patchServerCfg', 'features.regenerateBatOnStart'
];

async function loadConfig() {
  currentConfig = await api('GET', '/config');
  fillSettings(currentConfig);
  $('#server-name').textContent = currentConfig.server.name || '—';
}

function fillSettings(cfg) {
  for (const path of SIMPLE_FIELDS) {
    const input = $(`[name="${path}"]`);
    if (input) input.value = get(cfg, path) ?? '';
  }
  for (const path of CHECKBOXES) {
    const input = $(`[name="${path}"]`);
    if (input) input.checked = Boolean(get(cfg, path));
  }
  $('[name="server.extraArgs"]').value = (cfg.server.extraArgs || []).join('\n');
  $('[name="server.extraPorts"]').value = (cfg.server.extraPorts || [])
    .map((p) => `${p.protocol} ${p.from === p.to ? p.from : `${p.from}-${p.to}`}${p.comment ? ' ' + p.comment : ''}`)
    .join('\n');
  $('#pass-hint').textContent = cfg.steam.hasPassword ? '(сохранён)' : '(не задан)';
}

/** «UDP 2303-2305 комментарий» -> объект правила. */
function parsePortLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(UDP|TCP)\s+(\d+)(?:\s*-\s*(\d+))?\s*(.*)$/i);
    if (!m) throw new Error(`Не разобрана строка портов: «${line}»`);
    const from = parseInt(m[2], 10);
    const to = m[3] ? parseInt(m[3], 10) : from;
    if (to < from) throw new Error(`Некорректный диапазон: «${line}»`);
    out.push({ protocol: m[1].toUpperCase(), from, to, comment: (m[4] || '').trim() });
  }
  return out;
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = e.submitter;

  await withBusy(submit, async () => {
    const patch = {};

    for (const path of SIMPLE_FIELDS) {
      const input = $(`[name="${path}"]`);
      if (!input) continue;
      const value = input.type === 'number' ? parseInt(input.value, 10) || 0 : input.value.trim();
      set(patch, path, value);
    }
    for (const path of CHECKBOXES) {
      const input = $(`[name="${path}"]`);
      if (input) set(patch, path, input.checked);
    }

    const password = $('[name="steam.password"]').value;
    if (password) set(patch, 'steam.password', password);

    set(
      patch,
      'server.extraArgs',
      $('[name="server.extraArgs"]').value.split('\n').map((s) => s.trim()).filter(Boolean)
    );
    set(patch, 'server.extraPorts', parsePortLines($('[name="server.extraPorts"]').value));

    currentConfig = await api('PUT', '/config', patch);
    fillSettings(currentConfig);
    $('[name="steam.password"]').value = '';
    $('#server-name').textContent = currentConfig.server.name || '—';
    $('#settings-saved').textContent = `сохранено в ${new Date().toLocaleTimeString('ru-RU')}`;
    toast('Настройки сохранены', 'ok');
    refreshStatus();
  });
});

$('#btn-reload-settings').addEventListener('click', (e) => withBusy(e.target, loadConfig));

/* -------------------------------------------------------------------- .bat */

async function loadBat() {
  try {
    const data = await api('GET', '/bat');
    $('#bat-path').textContent = data.path;
    $('#bat-cmd').textContent = data.commandLine;
    $('#bat-content').textContent = data.content;
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#btn-bat-refresh').addEventListener('click', (e) => withBusy(e.target, loadBat));

$('#btn-bat-save').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const data = await api('POST', '/bat', {});
    toast(data.written ? `Записан ${data.path}` : '.bat уже актуален', 'ok');
    loadBat();
  })
);

/* --------------------------------------------------------------- брандмауэр */

async function loadFirewall() {
  try {
    const data = await api('GET', '/firewall');
    const rows = data.rules
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${r.protocol || '—'}</td>
          <td>${escapeHtml(r.localport || '—')}</td>
          <td>${escapeHtml(r.comment || '')}</td>
          <td>${r.exists === null ? '<span class="badge">н/д</span>'
            : r.exists ? '<span class="badge ok">создано</span>' : '<span class="badge warn">нет</span>'}</td>
        </tr>`
      )
      .join('');

    $('#fw-list').innerHTML = `
      ${data.supported ? '' : '<div class="banner">Текущая ОС — не Windows, правила не проверяются.</div>'}
      <table class="fw">
        <thead><tr><th>Правило</th><th>Протокол</th><th>Порт</th><th>Назначение</th><th>Статус</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#btn-fw-refresh').addEventListener('click', (e) => withBusy(e.target, loadFirewall));

$('#btn-fw-apply').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const report = await api('POST', '/firewall/apply', {});
    if (report.failed.length) toast(`Не создано правил: ${report.failed.length} — нужны права администратора`, 'err');
    else toast(`Готово. Создано: ${report.created.length}, уже было: ${report.skipped.length}`, 'ok');
    loadFirewall();
  })
);

$('#btn-fw-bat').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const data = await api('POST', '/firewall/bat', {});
    toast(`Сохранён ${data.path}`, 'ok');
  })
);

$('#btn-fw-remove').addEventListener('click', (e) => {
  if (!confirm('Удалить все правила брандмауэра, созданные панелью?')) return;
  withBusy(e.target, async () => {
    const data = await api('DELETE', '/firewall');
    toast(`Удалено правил: ${data.removed}`, 'ok');
    loadFirewall();
  });
});

/* ------------------------------------------------------------- serverDZ.cfg */

async function loadServerCfg() {
  try {
    const data = await api('GET', '/servercfg');
    $('#cfg-path').textContent = data.path;
    $('#cfg-content').value = data.exists ? data.content : '';
    if (!data.exists) toast('serverDZ.cfg пока не существует — он будет создан при первом старте', 'warn');
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#btn-cfg-reload').addEventListener('click', (e) => withBusy(e.target, loadServerCfg));

$('#btn-cfg-save').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    await api('PUT', '/servercfg', { content: $('#cfg-content').value });
    toast('serverDZ.cfg сохранён', 'ok');
  })
);

$('#btn-cfg-sync').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const data = await api('POST', '/servercfg/sync', {});
    toast(data.changed ? 'Значения из панели подставлены' : 'Файл уже соответствует настройкам', 'ok');
    loadServerCfg();
  })
);

/* ------------------------------------------------------------------- прочее */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

(async function init() {
  connectStream();
  await refreshStatus();
  try {
    await loadConfig();
    await loadMods();
  } catch (err) {
    toast(err.message, 'err');
  }
  setInterval(refreshStatus, 5000);
})();
