/**
 * Три служебные вкладки:
 *   «Конфигурация» — редактор serverDZ.cfg,
 *   «Файл запуска» — предпросмотр и запись .bat,
 *   «Порты»        — правила брандмауэра Windows.
 */

import { api } from '../api.js';
import { state } from '../store.js';
import { esc, icon, toast, busy, confirmDialog } from '../ui.js';

export function initToolsTabs(panes) {
  initCfg(panes.cfg);
  initBat(panes.bat);
  initFirewall(panes.firewall);
}

/* ------------------------------------------------------- serverDZ.cfg */

function initCfg(pane) {
  pane.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('file')}</span>
        <div><h2>serverDZ.cfg</h2>
          <div class="card-sub" id="cfg-path">—</div></div>
        <span class="spacer"></span>
        <div class="row wrap">
          <button class="btn btn-sm" id="cfg-reload">${icon('restart')} Перечитать</button>
          <button class="btn btn-sm" id="cfg-sync">${icon('zap')} Подставить из панели</button>
          <button class="btn btn-sm btn-primary" id="cfg-save">${icon('save')} Сохранить</button>
        </div>
      </div>
      <div class="notice info mb"><span class="ic">${icon('info')}</span>
        <div>Панель синхронизирует сюда только имя, пароли, слоты, карту, ускорение времени и query-порт.
        Остальное можно править вручную — оно не будет перезаписано.</div></div>
      <textarea id="cfg-text" rows="26" spellcheck="false"></textarea>
    </div>`;

  const text = pane.querySelector('#cfg-text');

  async function load() {
    try {
      const data = await api.serverCfg();
      pane.querySelector('#cfg-path').textContent = data.path;
      text.value = data.exists ? data.content : '';
      if (!data.exists) {
        toast('serverDZ.cfg ещё не создан — он появится при первом запуске', 'warn');
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  pane.querySelector('#cfg-reload').addEventListener('click', (e) => busy(e.currentTarget, load));

  pane.querySelector('#cfg-save').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await api.saveServerCfg(text.value);
      toast('serverDZ.cfg сохранён', 'ok');
    })
  );

  pane.querySelector('#cfg-sync').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const data = await api.syncServerCfg();
      toast(data.changed ? 'Значения из панели подставлены' : 'Файл уже соответствует настройкам', 'ok');
      await load();
    })
  );

  pane.__load = load;
}

/* ---------------------------------------------------------------- .bat */

function initBat(pane) {
  pane.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('terminal')}</span>
        <div><h2>Файл запуска сервера</h2>
          <div class="card-sub">Собирается автоматически из настроек и списка включённых модов</div></div>
        <span class="spacer"></span>
        <div class="row wrap">
          <button class="btn btn-sm" id="bat-reload">${icon('restart')} Обновить</button>
          <button class="btn btn-sm btn-primary" id="bat-save">${icon('save')} Записать .bat на диск</button>
        </div>
      </div>
      <div class="summary-list mb">
        <div class="r"><div class="k">Путь к файлу</div><div class="v mono" id="bat-path">—</div></div>
        <div class="r"><div class="k">Командная строка</div><div class="v mono" id="bat-cmd">—</div></div>
      </div>
      <pre class="code" id="bat-content">—</pre>
    </div>`;

  async function load() {
    try {
      const data = await api.bat();
      pane.querySelector('#bat-path').textContent = data.path;
      pane.querySelector('#bat-cmd').textContent = data.commandLine;
      pane.querySelector('#bat-content').textContent = data.content;
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  pane.querySelector('#bat-reload').addEventListener('click', (e) => busy(e.currentTarget, load));

  pane.querySelector('#bat-save').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const data = await api.writeBat();
      toast(data.written ? `Записан ${data.path}` : '.bat уже актуален', 'ok');
      await load();
    })
  );

  pane.__load = load;
}

/* ----------------------------------------------------------- брандмауэр */

function initFirewall(pane) {
  pane.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('shield')}</span>
        <div><h2>Правила Windows Firewall</h2>
          <div class="card-sub">Порты берутся из настроек сервера — в коде панели ничего не зашито</div></div>
        <span class="spacer"></span>
        <div class="row wrap">
          <button class="btn btn-sm" id="fw-reload">${icon('restart')} Проверить</button>
          <button class="btn btn-sm btn-primary" id="fw-apply">${icon('shield')} Открыть порты</button>
          <button class="btn btn-sm" id="fw-bat">${icon('save')} .bat для админа</button>
          <button class="btn btn-sm btn-danger" id="fw-remove">${icon('trash')} Удалить правила</button>
        </div>
      </div>
      <div id="fw-box"></div>
    </div>`;

  async function load() {
    const box = pane.querySelector('#fw-box');
    box.innerHTML = `<div class="skeleton" style="height:180px"></div>`;

    try {
      const data = await api.firewall();
      const rows = data.rules
        .map(
          (r) => `
          <tr>
            <td class="mono small">${esc(r.name)}</td>
            <td>${esc(r.protocol || '—')}</td>
            <td class="mono">${esc(r.localport || '—')}</td>
            <td class="dim small">${esc(r.comment || '')}</td>
            <td>${
              r.exists === null
                ? '<span class="badge">н/д</span>'
                : r.exists
                  ? `<span class="badge ok">${icon('check')} создано</span>`
                  : '<span class="badge warn">нет правила</span>'
            }</td>
          </tr>`
        )
        .join('');

      box.innerHTML = `
        ${data.supported
          ? ''
          : `<div class="notice warn mb"><span class="ic">${icon('alert')}</span>
              <div>Текущая ОС — не Windows, поэтому правила не проверяются и не создаются.</div></div>`}
        ${state.panel && state.panel.isWindows
          ? `<div class="notice info mb"><span class="ic">${icon('info')}</span>
              <div>Создание правил требует прав администратора. Если панель запущена обычным пользователем,
              нажмите «.bat для админа» и выполните полученный файл от имени администратора.</div></div>`
          : ''}
        <table class="data">
          <thead><tr><th>Правило</th><th>Протокол</th><th>Порт</th><th>Назначение</th><th>Статус</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch (err) {
      box.innerHTML = `<div class="notice err"><span class="ic">${icon('alert')}</span><div>${esc(err.message)}</div></div>`;
    }
  }

  pane.querySelector('#fw-reload').addEventListener('click', (e) => busy(e.currentTarget, load));

  pane.querySelector('#fw-apply').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const report = await api.applyFirewall(false);
      if (report.platform !== 'win32') toast('Открытие портов доступно только в Windows', 'warn');
      else if (report.failed.length) toast('Часть правил не создана — нужны права администратора', 'err');
      else toast(`Готово. Создано: ${report.created.length}, уже было: ${report.skipped.length}`, 'ok');
      await load();
    })
  );

  pane.querySelector('#fw-bat').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const data = await api.firewallBat();
      toast(`Сохранён ${data.path}`, 'ok', 8000);
    })
  );

  pane.querySelector('#fw-remove').addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: 'Удалить правила брандмауэра?',
      message: 'Будут удалены все правила, созданные панелью (их имена начинаются с «DayZ Panel — »). Чужие правила не пострадают.',
      confirmText: 'Удалить',
      danger: true
    });
    if (!yes) return;

    const data = await api.removeFirewall();
    toast(`Удалено правил: ${data.removed}`, 'ok');
    await load();
  });

  pane.__load = load;
}
