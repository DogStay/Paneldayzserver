/**
 * Вкладка «Модификации».
 *
 * Здесь же живёт окно подписки: вводите название мода или его Workshop ID,
 * панель ищет в Steam Workshop, вы добавляете нужное в список и жмёте
 * «Загрузить» — SteamCMD качает моды, а панель раскладывает их в папку
 * сервера вместе с ключами .bikey.
 */

import { api } from '../api.js';
import { state, on, refreshMods, refreshServers, awaitJob } from '../store.js';
import { el, esc, icon, modal, toast, busy, confirmDialog, fmtBytes, fmtDate, fmtUnix, fmtNumber } from '../ui.js';

let paneRef = null;

export function initModsTab(pane) {
  paneRef = pane;

  pane.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('package')}</span>
        <div>
          <h2>Модификации сервера</h2>
          <div class="card-sub">Порядок в списке = порядок в параметре <span class="inline-code">-mod=</span>.
            Зависимости (@CF, @Dabs Framework) держите вверху.</div>
        </div>
        <span class="spacer"></span>
        <div class="row wrap">
          <button class="btn btn-success" id="mods-subscribe">${icon('search')} Подписаться на модификации</button>
          <button class="btn btn-sm" id="mods-update">${icon('refresh')} Проверить обновления</button>
          <button class="btn btn-sm" id="mods-deploy">${icon('package')} Разложить</button>
          <button class="btn btn-sm btn-ghost btn-icon" id="mods-refresh" title="Обновить список">${icon('restart')}</button>
        </div>
      </div>
      <div class="mod-list" id="mod-list"></div>
    </div>
    <div class="card hidden" id="orphans-card">
      <div class="card-head">
        <span class="card-title-icon">${icon('folder')}</span>
        <div><h2>Скачаны, но не подключены</h2>
          <div class="card-sub">Эти моды уже лежат в workshop-папке SteamCMD, но не входят в список сервера</div></div>
      </div>
      <div class="mod-list" id="orphan-list"></div>
    </div>`;

  pane.querySelector('#mods-subscribe').addEventListener('click', () => openSearchModal());
  pane.querySelector('#mods-refresh').addEventListener('click', (e) => busy(e.currentTarget, refreshMods));

  pane.querySelector('#mods-update').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const { job } = await api.updateMods();
      toast('Проверяю обновления через SteamCMD…', 'info');
      const done = await awaitJob(job.id).catch((err) => {
        toast(err.message, 'err');
        return null;
      });
      if (done && done.result) {
        const { updated, failed } = done.result;
        if (failed.length) toast(`Ошибок: ${failed.length}. Подробности в консоли.`, 'err');
        toast(updated.length ? `Обновлено модов: ${updated.length}` : 'Все моды актуальны', 'ok');
      }
      await refreshMods();
      await refreshServers();
    })
  );

  pane.querySelector('#mods-deploy').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const data = await api.deployMods();
      const bad = data.report.filter((r) => !r.ok);
      toast(bad.length ? `Не разложено: ${bad.length}` : 'Моды разложены в папку сервера', bad.length ? 'err' : 'ok');
      render(data);
    })
  );

  pane.__load = () => refreshMods();
  pane.__openSearch = () => openSearchModal();

  on('mods', render);
}

/* ------------------------------------------------------------ отрисовка */

function render(data = state.mods) {
  if (!paneRef) return;

  const list = paneRef.querySelector('#mod-list');
  list.innerHTML = '';

  if (!data.mods.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="ic">${icon('package')}</div>
        <h3>Модификаций пока нет</h3>
        <p>Нажмите «Подписаться на модификации», найдите нужный мод по названию или вставьте
           его Workshop ID — панель скачает его через SteamCMD и подготовит к запуску.</p>
        <button class="btn btn-success" id="mods-empty-add">${icon('search')} Подписаться на модификации</button>
      </div>`;
    list.querySelector('#mods-empty-add').addEventListener('click', () => openSearchModal());
  } else {
    for (const mod of data.mods) list.appendChild(modRow(mod));
    enableDrag(list);
  }

  const orphanCard = paneRef.querySelector('#orphans-card');
  const orphanList = paneRef.querySelector('#orphan-list');
  orphanList.innerHTML = '';

  if (!data.orphans || !data.orphans.length) {
    orphanCard.classList.add('hidden');
  } else {
    orphanCard.classList.remove('hidden');
    for (const item of data.orphans) {
      const row = el(`
        <div class="mod-row">
          <div class="mod-thumb ph">${icon('package')}</div>
          <div class="mod-main">
            <div class="mod-name">${esc(item.name)}</div>
            <div class="mod-meta"><span>ID ${item.id}</span><span>${esc(item.folder)}</span><span>${item.sizeMb} МБ</span></div>
          </div>
          <div class="mod-actions"><button class="btn btn-sm btn-primary">${icon('plus')} Подключить</button></div>
        </div>`);

      row.querySelector('button').addEventListener('click', (e) =>
        busy(e.currentTarget, async () => {
          await api.adoptMod(item.id);
          toast(`Мод «${item.name}» подключён`, 'ok');
          await refreshMods();
          await refreshServers();
        })
      );
      orphanList.appendChild(row);
    }
  }
}

function modRow(mod) {
  const badges = [];
  if (mod.type === 'server') badges.push('<span class="badge violet">serverMod</span>');
  if (!mod.downloaded) badges.push('<span class="badge err">не скачан</span>');
  else if (!mod.deployed) badges.push('<span class="badge warn">не разложен</span>');
  else badges.push(`<span class="badge ok">${icon('check')} готов</span>`);
  if (mod.updateAvailable) badges.push('<span class="badge warn">есть обновление</span>');
  if (mod.hasKeys) badges.push('<span class="badge">keys</span>');

  const thumb = mod.preview
    ? `<img class="mod-thumb" src="${esc(mod.preview)}" alt="" loading="lazy">`
    : `<div class="mod-thumb ph">${icon('package')}</div>`;

  const row = el(`
    <div class="mod-row ${mod.enabled ? '' : 'off'}" draggable="true" data-id="${mod.id}">
      <span class="mod-grip" title="Перетащите, чтобы изменить порядок">${icon('grip')}</span>
      <label class="check"><input type="checkbox" ${mod.enabled ? 'checked' : ''}><span class="box"></span></label>
      ${thumb}
      <div class="mod-main">
        <div class="mod-name">${esc(mod.name)} ${badges.join(' ')}</div>
        <div class="mod-meta">
          <span>${icon('hash')} ${mod.id}</span>
          <span>${icon('folder')} ${esc(mod.folder)}</span>
          <span>${icon('db')} ${mod.sizeMb ? `${mod.sizeMb} МБ` : '—'}</span>
          <span>${icon('clock')} версия ${fmtUnix(mod.installedTimeupdated)}</span>
          <span>${icon('refresh')} проверен ${fmtDate(mod.lastUpdateCheck)}</span>
        </div>
      </div>
      <div class="mod-actions">
        <a class="btn btn-sm btn-ghost btn-icon" href="https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.id}"
           target="_blank" rel="noreferrer" title="Открыть в Workshop">${icon('external')}</a>
        <button class="btn btn-sm" data-act="type" title="Переключить между -mod и -serverMod">
          ${mod.type === 'server' ? '→ клиентский' : '→ серверный'}</button>
        <button class="btn btn-sm btn-ghost btn-icon" data-act="remove" title="Удалить мод">${icon('trash')}</button>
      </div>
    </div>`);

  fallbackThumb(row.querySelector('img.mod-thumb'), 'mod-thumb ph', 'package');

  row.querySelector('input[type="checkbox"]').addEventListener('change', async (e) => {
    await api.patchMod(mod.id, { enabled: e.target.checked });
    await refreshMods();
    await refreshServers();
  });

  row.querySelector('[data-act="type"]').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await api.patchMod(mod.id, { type: mod.type === 'server' ? 'client' : 'server' });
      await refreshMods();
    })
  );

  row.querySelector('[data-act="remove"]').addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: 'Удалить модификацию?',
      message: `<b>${esc(mod.name)}</b> будет убран из списка сервера, а папка
        <span class="inline-code">${esc(mod.folder)}</span> удалена из каталога сервера.<br><br>
        Скачанные файлы в workshop-папке SteamCMD останутся — мод можно будет подключить снова без повторной загрузки.`,
      confirmText: 'Удалить',
      danger: true
    });
    if (!yes) return;

    await api.deleteMod(mod.id, true);
    toast('Мод удалён', 'ok');
    await refreshMods();
    await refreshServers();
  });

  return row;
}

/** Не загрузилось превью из Steam (нет интернета или картинку удалили) — рисуем заглушку. */
function fallbackThumb(img, className, iconName) {
  if (!img) return;
  img.addEventListener('error', () => {
    img.replaceWith(el(`<div class="${className}">${icon(iconName)}</div>`));
  });
}

/** Перетаскивание строк меняет порядок в -mod=. */
function enableDrag(list) {
  let dragged = null;

  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.mod-row');
    if (!row) return;
    dragged = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragged) return;
    const target = e.target.closest('.mod-row');
    if (!target || target === dragged) return;
    const rect = target.getBoundingClientRect();
    list.insertBefore(dragged, e.clientY > rect.top + rect.height / 2 ? target.nextSibling : target);
  });

  list.addEventListener('dragend', async () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    const ids = [...list.querySelectorAll('.mod-row')].map((n) => n.dataset.id).filter(Boolean);
    try {
      await api.reorderMods(ids);
      toast('Порядок модов сохранён', 'ok', 2000);
    } catch (err) {
      toast(err.message, 'err');
    }
    await refreshMods();
  });
}

/* ------------------------------------------------- окно подписки на моды */

export function openSearchModal() {
  const cart = new Map();
  let lastResults = [];

  const m = modal({
    title: 'Подписаться на модификации',
    subtitle: 'Найдите мод по названию или вставьте его Workshop ID / ссылку',
    icon: 'search',
    wide: true,
    body: `
      <div class="row" style="gap:8px">
        <input type="search" id="ws-q" placeholder="Например: Trader, BuilderItems, 1559212036 или ссылка на Workshop"
               autocomplete="off" style="flex:1">
        <button class="btn btn-primary" id="ws-go">${icon('search')} Найти</button>
      </div>
      <div class="hint" style="margin-top:8px">Поиск обращается к Steam — нужен интернет.
        По Workshop ID мод находится всегда, поиск по названию иногда зависит от выдачи Steam.</div>

      <div id="ws-results-box" style="margin-top:18px"></div>
      <div class="cart" id="ws-cart" style="display:none">
        <div class="cart-head">
          ${icon('download')}
          <b style="font-size:13px">К загрузке</b>
          <span class="badge info" id="ws-count">0</span>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="ws-clear">Очистить</button>
        </div>
        <div class="cart-items" id="ws-cart-items"></div>
      </div>`,
    footer: `
      <span class="small faint" id="ws-hint">Найдите мод и добавьте его в список загрузки</span>
      <span class="spacer"></span>
      <button class="btn" data-close>Закрыть</button>
      <button class="btn btn-success" id="ws-download" disabled>${icon('download')} Загрузить</button>`
  });

  const q = m.root.querySelector('#ws-q');
  const resultsBox = m.root.querySelector('#ws-results-box');
  const cartBox = m.root.querySelector('#ws-cart');
  const cartItems = m.root.querySelector('#ws-cart-items');
  const countBadge = m.root.querySelector('#ws-count');
  const downloadBtn = m.root.querySelector('#ws-download');
  const hint = m.root.querySelector('#ws-hint');

  function syncCart() {
    // Контейнер показываем до вставки чипов: анимация появления внутри
    // display:none в некоторых браузерах не стартует и элемент остаётся скрытым.
    cartBox.style.display = cart.size ? '' : 'none';
    cartItems.innerHTML = '';
    for (const item of cart.values()) {
      const chip = el(`
        <span class="cart-chip">
          <span class="nm">${esc(item.title)}</span>
          <button title="Убрать">${icon('x')}</button>
        </span>`);
      chip.querySelector('button').addEventListener('click', () => {
        cart.delete(item.id);
        syncCart();
        markResults();
      });
      cartItems.appendChild(chip);
    }

    countBadge.textContent = String(cart.size);
    downloadBtn.disabled = cart.size === 0;
    downloadBtn.innerHTML = `${icon('download')} Загрузить${cart.size ? ` (${cart.size})` : ''}`;
    hint.textContent = cart.size
      ? `Выбрано модов: ${cart.size}. Нажмите «Загрузить» — SteamCMD скачает их и разложит в папку сервера.`
      : 'Найдите мод и добавьте его в список загрузки';
  }

  function markResults() {
    resultsBox.querySelectorAll('.ws-item').forEach((node) => {
      const added = cart.has(node.dataset.id);
      node.classList.toggle('added', added);
      const btn = node.querySelector('[data-add]');
      if (btn) {
        btn.innerHTML = added ? `${icon('check')} Добавлен` : `${icon('plus')} Добавить`;
        btn.className = `btn btn-sm ${added ? '' : 'btn-primary'}`;
      }
    });
  }

  async function search() {
    const query = q.value.trim();
    if (!query) return toast('Введите название мода или Workshop ID', 'warn');

    resultsBox.innerHTML = `
      <div class="ws-results">
        ${'<div class="skeleton" style="height:82px"></div>'.repeat(3)}
      </div>`;

    try {
      const data = await api.searchWorkshop(query, 1);
      lastResults = data.items;
      renderResults(data);
    } catch (err) {
      resultsBox.innerHTML = `
        <div class="notice err"><span class="ic">${icon('alert')}</span>
          <div><b>Поиск не удался</b><br>${esc(err.message)}<br><br>
          Если поиск по названию не работает, вставьте Workshop ID мода — по нему панель находит мод напрямую.
          ID есть в адресе страницы мода после <span class="inline-code">?id=</span>.</div></div>`;
    }
  }

  function renderResults(data) {
    const modeLabel = { id: 'найдено по ID', api: 'поиск Steam Web API', community: 'поиск по странице Workshop' }[data.mode] || '';

    resultsBox.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <span class="small dim">Результатов: ${data.items.length}</span>
        <span class="small faint">${esc(modeLabel)}</span>
      </div>
      <div class="ws-results" id="ws-results"></div>`;

    const box = resultsBox.querySelector('#ws-results');

    for (const item of data.items) {
      const node = el(`
        <div class="ws-item" data-id="${item.id}">
          ${item.preview
            ? `<img src="${esc(item.preview)}" alt="" loading="lazy">`
            : `<div class="ph">${icon('image')}</div>`}
          <div class="info">
            <h4>${esc(item.title)}</h4>
            ${item.description ? `<div class="desc">${esc(item.description)}</div>` : ''}
            <div class="meta">
              <span>${icon('hash')} ${item.id}</span>
              ${item.sizeBytes ? `<span>${icon('db')} ${fmtBytes(item.sizeBytes)}</span>` : ''}
              ${item.timeUpdated ? `<span>${icon('clock')} ${fmtUnix(item.timeUpdated)}</span>` : ''}
              ${item.subscriptions ? `<span>${icon('thumb')} ${fmtNumber(item.subscriptions)}</span>` : ''}
            </div>
          </div>
          <div class="col" style="justify-content:center;gap:6px">
            <button class="btn btn-sm btn-primary" data-add>${icon('plus')} Добавить</button>
            <a class="btn btn-sm btn-ghost" href="${esc(item.url)}" target="_blank" rel="noreferrer">
              ${icon('external')} Steam</a>
          </div>
        </div>`);

      fallbackThumb(node.querySelector('img'), 'ph', 'image');

      node.querySelector('[data-add]').addEventListener('click', () => {
        if (cart.has(item.id)) cart.delete(item.id);
        else cart.set(item.id, item);
        syncCart();
        markResults();
      });

      box.appendChild(node);
    }

    markResults();
  }

  m.root.querySelector('#ws-go').addEventListener('click', search);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') search();
  });

  m.root.querySelector('#ws-clear').addEventListener('click', () => {
    cart.clear();
    syncCart();
    markResults();
  });

  downloadBtn.addEventListener('click', async () => {
    const items = [...cart.values()].map((i) => ({
      id: i.id,
      name: i.title,
      preview: i.preview,
      sizeBytes: i.sizeBytes,
      type: 'client'
    }));

    downloadBtn.classList.add('loading');
    try {
      const { job } = await api.downloadMods(items);
      showDownloadProgress(m, items.length, job.id);
    } catch (err) {
      downloadBtn.classList.remove('loading');
      toast(err.message, 'err');
    }
  });

  void lastResults;
  syncCart();
}

/** Экран прогресса загрузки прямо в окне подписки. */
function showDownloadProgress(m, total, jobId) {
  m.body.innerHTML = `
    <div class="row" style="gap:14px;margin-bottom:18px">
      <span class="card-title-icon">${icon('download')}</span>
      <div>
        <h3 style="font-size:15px">Загружаю модификации (${total} шт.)</h3>
        <div class="small dim">SteamCMD скачивает файлы, затем панель раскладывает их в папку сервера</div>
      </div>
    </div>
    <div class="progress"><div class="bar" id="dl-bar"></div></div>
    <div class="row" style="justify-content:space-between;margin-top:9px">
      <span class="small dim" id="dl-step">Подготовка…</span>
      <span class="small mono faint" id="dl-pct">0%</span>
    </div>
    <div class="notice info" style="margin-top:18px"><span class="ic">${icon('info')}</span>
      <div>Крупные моды весят несколько гигабайт — это может занять время.
      Окно можно закрыть, загрузка продолжится в фоне.</div></div>`;

  m.footer.innerHTML = `<span class="spacer"></span><button class="btn" data-close>Свернуть окно</button>`;

  const off = on('job', (job) => {
    if (job.id !== jobId) return;
    const bar = document.getElementById('dl-bar');
    if (bar) {
      bar.style.width = `${job.progress}%`;
      document.getElementById('dl-step').textContent = job.step;
      document.getElementById('dl-pct').textContent = `${job.progress}%`;
    }
    if (job.status === 'running') return;
    off();

    if (job.status === 'done') {
      const report = job.result || { downloaded: [], failed: [] };
      showDownloadResult(m, report);
    } else {
      m.body.innerHTML = `
        <div class="notice err"><span class="ic">${icon('alert')}</span>
          <div><b>Загрузка прервана</b><br>${esc(job.error || 'неизвестная ошибка')}<br><br>
          Проверьте логин Steam и наличие DayZ на аккаунте. Полный вывод SteamCMD — в консоли внизу.</div></div>`;
      m.footer.innerHTML = `<span class="spacer"></span><button class="btn" data-close>Закрыть</button>`;
    }

    refreshMods();
    refreshServers();
  });
}

function showDownloadResult(m, report) {
  const ok = report.downloaded || [];
  const bad = report.failed || [];

  m.body.innerHTML = `
    <div class="empty-state" style="padding:22px 10px">
      <div class="ic" style="color:var(--acc);border-color:rgba(127,210,95,.4);background:rgba(127,210,95,.1)">
        ${icon('check')}</div>
      <h3>Загружено модов: ${ok.length}</h3>
      <p>Моды разложены в папку сервера, ключи .bikey скопированы в <span class="inline-code">keys</span>.
         Они уже включены и попадут в параметр <span class="inline-code">-mod=</span> при следующем запуске.</p>
    </div>
    ${ok.length ? `<div class="summary-list">${ok
      .map((i) => `<div class="r"><div class="k">${esc(i.name)}</div><div class="v">${i.status === 'installed' ? 'установлен' : 'обновлён'}</div></div>`)
      .join('')}</div>` : ''}
    ${bad.length ? `
      <div class="notice err" style="margin-top:16px"><span class="ic">${icon('alert')}</span>
        <div><b>Не удалось загрузить: ${bad.length}</b><br>
        ${bad.map((f) => `${esc(f.name)}: ${esc(f.error)}`).join('<br>')}</div></div>` : ''}`;

  m.footer.innerHTML = `
    <span class="spacer"></span>
    <button class="btn btn-primary" data-close>${icon('check')} Готово</button>`;

  toast(ok.length ? `Загружено модов: ${ok.length}` : 'Загрузка завершена', bad.length ? 'warn' : 'ok');
}
