/**
 * Вкладка «Карта» — интерактивная карта сервера с живыми игроками.
 *
 * Данные приходят от мода-моста (снимок раз в несколько секунд) через SSE, так
 * что метки двигаются сами. Клик по метке или по строке в списке открывает
 * карточку игрока: состояние, инвентарь, его личная история действий и
 * действия администратора — вылечить, накормить, телепортировать, выдать вещь.
 *
 * Подложка карты рисуется сеткой координат: спутниковых снимков DayZ в панели
 * нет и быть не может (это гигабайты чужих текстур). Если положить свою
 * картинку в public/maps/<мир>.jpg, панель подхватит её как фон.
 */

import { api } from '../api.js';
import { on, activeServer } from '../store.js';
import { esc, icon, toast, busy, modal, confirmDialog, fmtUptime, fmtDate } from '../ui.js';

let paneRef = null;
let canvas = null;
let view = {
  worldSize: 15360,
  players: [],
  selectedId: '',
  bg: null,
  bgTried: '',
  /** Трасса выбранного игрока и трассы всех — рисуются поверх карты. */
  trail: null,
  trails: [],
  trailMinutes: 30,
  showAllTrails: false,
  /** Сведения о подложке от /api/map: слой, зумы, источник. */
  tiles: null
};
/** Масштаб и сдвиг карты — колесо мыши и перетаскивание. */
let camera = { zoom: 1, x: 0, y: 0, dragging: false };
/** Загруженные тайлы подложки: ключ «слой/z/x/y» -> Image | 'loading' | 'missing'. */
const tiles = new Map();
let drawPending = false;

export function initMapTab(pane) {
  paneRef = pane;
  pane.__load = load;

  on('bridge-players', (data) => {
    const server = activeServer();
    if (!server || data.serverId !== server.id) return;

    view.players = data.players || [];
    view.worldSize = data.worldSize || view.worldSize;

    const selected = view.players.find((p) => p.id === view.selectedId);
    if (selected) appendTrailPoint(selected);

    if (paneRef && paneRef.classList.contains('active')) {
      draw();
      renderList();
      if (view.selectedId) renderCard(view.selectedId);
    }
  });

  on('bridge-status', (s) => {
    const server = activeServer();
    if (paneRef && server && s.serverId === server.id && paneRef.classList.contains('active')) load();
  });
}

/* ---------------------------------------------------------------- загрузка */

async function load() {
  if (!paneRef) return;

  let status;
  try {
    status = await api.bridge();
  } catch (err) {
    paneRef.innerHTML = notice('err', 'alert', esc(err.message));
    return;
  }

  if (!status.online) return renderOffline(status);

  const data = await api.bridgePlayers().catch(() => ({ players: [], worldSize: status.worldSize }));
  view.players = data.players || [];
  view.worldSize = data.worldSize || status.worldSize || 15360;
  view.world = status.world || '';

  renderShell(status);
  await loadTiles();
  await loadBackground(status.world);
  renderSource();
  draw();
  renderList();
  await refreshTrails();
}

const notice = (kind, ic, html) =>
  `<div class="card"><div class="notice ${kind}"><span class="ic">${icon(ic)}</span><div>${html}</div></div></div>`;

function renderOffline(status) {
  paneRef.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('map')}</span>
        <div><h2>Мод-мост не на связи</h2>
          <div class="card-sub">Карта и логи действий работают через серверный мод @DayZPanelBridge</div></div>
      </div>

      <div class="notice warn mb"><span class="ic">${icon('alert')}</span>
        <div>${esc(status.reason || 'мод не отвечает')}</div></div>

      <div class="notice info mb"><span class="ic">${icon('info')}</span>
        <div>Мод серверный: игрокам скачивать нечего, ключи не нужны. Подключается через
        <span class="inline-code">-serverMod=@DayZPanelBridge</span>. Обмен идёт файлами в папке
        <span class="inline-code">${esc(status.dir || 'профиль\\panel')}</span> — ни портов, ни интернета.
        Задание на мод с описанием протокола лежит в
        <span class="inline-code">docs/bridge-mod-prompt.md</span>.</div></div>

      <div class="row wrap">
        <button class="btn btn-primary" id="map-prepare">${icon('folder')} Подготовить папку обмена</button>
        <button class="btn" id="map-recheck">${icon('restart')} Проверить снова</button>
      </div>
    </div>`;

  paneRef.querySelector('#map-prepare').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const s = await api.bridgePrepare();
      toast(`Папка обмена готова: ${s.dir}`, 'ok', 9000);
      await load();
    })
  );
  paneRef.querySelector('#map-recheck').addEventListener('click', (e) => busy(e.currentTarget, load));
}

function renderShell(status) {
  paneRef.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('map')}</span>
        <div><h2>Карта сервера</h2>
          <div class="card-sub" id="map-sub">${esc(status.world || 'карта')} · ${status.worldSize} м ·
            игроков ${view.players.length}${status.gameTime ? ` · в игре ${esc(status.gameTime)}` : ''}</div></div>
        <span class="spacer"></span>
        <div class="row wrap">
          <label class="switch" style="margin:0">
            <input type="checkbox" id="map-all-trails" ${view.showAllTrails ? 'checked' : ''}>
            <span class="track"></span><span class="switch-text">Трассы всех</span>
          </label>
          <select id="map-trail-minutes" style="width:130px">
            <option value="10" ${view.trailMinutes === 10 ? 'selected' : ''}>за 10 минут</option>
            <option value="30" ${view.trailMinutes === 30 ? 'selected' : ''}>за 30 минут</option>
            <option value="60" ${view.trailMinutes === 60 ? 'selected' : ''}>за час</option>
            <option value="120" ${view.trailMinutes === 120 ? 'selected' : ''}>за 2 часа</option>
          </select>
          <select id="map-layer" style="width:150px" title="Подложка карты">
            <option value="off">без подложки</option>
            <option value="topographic">карта</option>
            <option value="satellite">спутник</option>
          </select>
          <button class="btn btn-sm" id="map-zoom-in">${icon('plus')}</button>
          <button class="btn btn-sm" id="map-zoom-out">−</button>
          <button class="btn btn-sm" id="map-reset">${icon('refresh')} Вписать</button>
        </div>
      </div>

      <div class="map-wrap">
        <canvas id="map-canvas" width="900" height="900"></canvas>
        <div class="map-menu hidden" id="map-menu"></div>
      </div>
      <div class="hint" style="margin-top:8px">Колесо мыши — масштаб, перетаскивание — сдвиг,
        клик по метке — карточка игрока, <b>правый клик по карте</b> — заспавнить объект или
        телепортировать выбранного игрока в это место.</div>
      <div class="hint" id="map-source" style="margin-top:4px"></div>
    </div>

    <div class="map-columns">
      <div class="card">
        <div class="card-head">
          <span class="card-title-icon">${icon('users')}</span>
          <div><h2>Игроки онлайн</h2><div class="card-sub" id="map-count">—</div></div>
        </div>
        <div class="mod-list" id="map-players"></div>
      </div>

      <div class="card" id="map-card">
        <div class="notice info"><span class="ic">${icon('users')}</span>
          <div>Выберите игрока на карте или в списке.</div></div>
      </div>
    </div>`;

  canvas = paneRef.querySelector('#map-canvas');
  bindCanvas();

  paneRef.querySelector('#map-zoom-in').addEventListener('click', () => zoomBy(1.4));
  paneRef.querySelector('#map-zoom-out').addEventListener('click', () => zoomBy(1 / 1.4));
  paneRef.querySelector('#map-reset').addEventListener('click', () => {
    camera = { zoom: 1, x: 0, y: 0, dragging: false };
    draw();
  });

  const layerSelect = paneRef.querySelector('#map-layer');
  layerSelect.value = view.tiles && view.tiles.enabled ? view.tiles.layer : 'off';
  layerSelect.addEventListener('change', (e) =>
    busy(e.currentTarget, async () => {
      const value = e.currentTarget.value;
      await api.saveConfig({
        panel: { map: { tiles: { enabled: value !== 'off', layer: value === 'off' ? undefined : value } } }
      });

      // Слой сменился — прежние тайлы больше не годятся.
      tiles.clear();
      await loadTiles();
      renderSource();
      draw();
    })
  );

  paneRef.querySelector('#map-trail-minutes').addEventListener('change', (e) => {
    view.trailMinutes = Number(e.currentTarget.value) || 30;
    refreshTrails();
  });

  paneRef.querySelector('#map-all-trails').addEventListener('change', (e) => {
    view.showAllTrails = e.currentTarget.checked;
    refreshTrails();
  });
}

/* ------------------------------------------------------------ подложка */

/**
 * Настоящая карта под метками.
 *
 * Тайлы панель отдаёт сама (см. src/services/maptiles.js): раз скачала — дальше
 * с диска. Здесь только выбор зума под текущий масштаб и отрисовка видимых
 * тайлов; невидимые не запрашиваются вовсе.
 */
async function loadTiles() {
  try {
    const info = await api.map();
    view.tiles = {
      enabled: info.tiles.enabled && info.tiles.hasSource,
      layer: info.tiles.layer,
      layers: info.layers || [],
      attribution: info.tiles.attribution,
      maxZoom: info.maxZoom,
      tileSize: info.tileSize,
      reason: info.reason,
      lastError: info.tiles.hasSource ? info.lastError : '',
      cache: info.cache
    };
  } catch (_) {
    // Подложка — украшение: если её не удалось выяснить, остаётся сетка.
    view.tiles = null;
  }
}

/** Подпись под картой: источник тайлов, размер кэша или причина, почему их нет. */
function renderSource() {
  const node = paneRef && paneRef.querySelector('#map-source');
  if (!node) return;

  const info = view.tiles;

  // Список слоёв рисуется до того, как панель ответит про подложку, поэтому
  // выбранное значение выставляем здесь — когда ответ уже есть.
  const select = paneRef.querySelector('#map-layer');
  if (select) select.value = info && info.enabled ? info.layer : 'off';
  if (!info) return void (node.textContent = '');

  if (!info.enabled) {
    node.innerHTML = info.reason
      ? `Подложки нет: ${esc(info.reason)}. Своя картинка: положите её в
         <span class="inline-code">public/maps/${esc(view.world || 'карта')}.jpg</span>`
      : 'Подложка выключена — рисуется только сетка координат.';
    return;
  }

  // Источник отказал — молчать нельзя: пустая карта выглядит как поломка панели.
  if (info.lastError) {
    node.innerHTML =
      `<span style="color:var(--err,#e5484d)">Тайлы не приходят: ${esc(info.lastError)}.</span>` +
      ' Настройки сервера → «Подложка карты» → «Проверить источник» покажет адрес и точную причину.';
    return;
  }

  const cached = info.cache && info.cache.files ? info.cache : null;
  node.innerHTML =
    `${esc(info.attribution || '')} · тайлы кэшируются на этой машине` +
    (cached ? ` (${cached.files} шт., ${Math.round(cached.bytes / 1024)} КБ)` : '');
}

/** Картинка тайла из кэша браузера; отсутствующую запрашиваем один раз. */
function tileImage(layer, z, x, y) {
  const key = `${layer}/${z}/${x}/${y}`;
  const cached = tiles.get(key);
  if (cached) return cached === 'loading' || cached === 'missing' ? null : cached;

  const image = new Image();
  tiles.set(key, 'loading');

  image.onload = () => {
    tiles.set(key, image);
    scheduleDraw();
  };
  image.onerror = () => {
    // Отдельный тайл может отсутствовать законно (край карты, дальний зум).
    // Но если не пришёл ни один, причину надо показать — спрашиваем панель.
    tiles.set(key, 'missing');
    if (![...tiles.values()].some((v) => v !== 'missing' && v !== 'loading')) refreshSource();
  };

  const server = activeServer();
  image.src = `/api/map/tiles/${layer}/${z}/${x}/${y}${server ? `?serverId=${encodeURIComponent(server.id)}` : ''}`;
  return null;
}

let sourceCheckedAt = 0;

/** Переспросить панель о состоянии подложки — не чаще раза в 10 секунд. */
async function refreshSource() {
  if (Date.now() - sourceCheckedAt < 10_000) return;
  sourceCheckedAt = Date.now();

  await loadTiles();
  renderSource();
}

/** Перерисовка не на каждый догруженный тайл, а раз в кадр. */
function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    draw();
  });
}

/**
 * @returns {boolean} нарисовался ли хоть один тайл — иначе рисуем сетку на фоне
 */
function drawTiles(ctx, left, top, side) {
  const info = view.tiles;
  if (!info || !info.enabled || !canvas) return false;

  // Зум подбираем так, чтобы тайл на экране был близок к своему размеру.
  const wanted = Math.round(Math.log2(side / info.tileSize));
  const z = Math.max(0, Math.min(info.maxZoom, wanted));
  const count = 2 ** z;
  const step = side / count;

  const first = (offset) => Math.max(0, Math.floor(-offset / step));
  const last = (offset, limit) => Math.min(count - 1, Math.floor((limit - offset) / step));

  let drawn = 0;
  for (let x = first(left); x <= last(left, canvas.width); x++) {
    for (let y = first(top); y <= last(top, canvas.height); y++) {
      const image = tileImage(info.layer, z, x, y);
      if (!image) continue;

      // +1 пиксель — чтобы между тайлами не просвечивали щели при дробном шаге.
      ctx.drawImage(image, left + x * step, top + y * step, step + 1, step + 1);
      drawn++;
    }
  }

  return drawn > 0;
}

/** Своя картинка-подложка, если пользователь её положил. */
function loadBackground(world) {
  const name = String(world || '').toLowerCase() || 'chernarusplus';
  if (view.bgTried === name) return Promise.resolve();
  view.bgTried = name;
  view.bg = null;

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      view.bg = image;
      draw();
      resolve();
    };
    image.onerror = () => resolve();
    image.src = `maps/${name}.jpg`;
  });
}

/* ------------------------------------------------------------- отрисовка */

/**
 * Камера: карта — это квадрат со стороной side, левый верхний угол которого
 * лежит в (camera.x, camera.y) на холсте. Все преобразования считаются от него,
 * поэтому метки, сетка, трассы и тайлы всегда сходятся между собой.
 */
function mapBox() {
  const side = canvas.width * camera.zoom;
  return { left: camera.x, top: camera.y, side };
}

/** Мировые координаты -> пиксели на холсте. */
function toScreen(pos) {
  const { left, top, side } = mapBox();
  return {
    x: left + (pos[0] / view.worldSize) * side,
    // В DayZ z растёт на север, а на холсте вниз — переворачиваем.
    y: top + (1 - pos[2] / view.worldSize) * side
  };
}

/** Обратное преобразование: клик по холсту -> координаты в мире. */
function toWorld(px, py) {
  const { left, top, side } = mapBox();
  return {
    x: ((px - left) / side) * view.worldSize,
    z: (1 - (py - top) / side) * view.worldSize
  };
}

/** Клик по холсту в координатах холста (он масштабируется по ширине карточки). */
function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height
  };
}

function draw() {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const size = canvas.width;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, size, size);

  const { left, top, side } = mapBox();

  ctx.fillStyle = '#111a22';
  ctx.fillRect(left, top, side, side);

  // Порядок: тайлы карты, иначе своя картинка, иначе просто заливка под сетку.
  const hasTiles = drawTiles(ctx, left, top, side);
  if (!hasTiles && view.bg) ctx.drawImage(view.bg, left, top, side, side);

  // Сетка по километрам: без неё координаты игрока не с чем соотнести.
  const step = view.worldSize >= 12000 ? 1000 : 500;
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui, sans-serif';

  for (let m = 0; m <= view.worldSize; m += step) {
    const a = toScreen([m, 0, 0]);
    const b = toScreen([m, 0, view.worldSize]);
    const major = m % (step * 5) === 0;
    ctx.strokeStyle = major ? 'rgba(120,180,220,0.28)' : 'rgba(120,180,220,0.1)';

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    const h1 = toScreen([0, 0, m]);
    const h2 = toScreen([view.worldSize, 0, m]);
    ctx.beginPath();
    ctx.moveTo(h1.x, h1.y);
    ctx.lineTo(h2.x, h2.y);
    ctx.stroke();

    if (major) {
      ctx.fillStyle = 'rgba(150,200,230,0.55)';
      ctx.fillText(String(m / 1000), a.x + 3, top + 12);
      ctx.fillText(String(m / 1000), left + 3, h1.y - 3);
    }
  }

  // Трассы под метками: сначала чужие бледные, потом выбранного — ярче.
  if (view.showAllTrails) {
    for (const item of view.trails) {
      if (item.playerId === view.selectedId) continue;
      drawTrail(ctx, item.points, 'rgba(88,166,255,ALPHA)', 1.5);
    }
  }
  if (view.trail) drawTrail(ctx, view.trail.points, 'rgba(240,180,41,ALPHA)', 2.5);

  // Метки игроков поверх сетки.
  for (const player of view.players) {
    const p = toScreen(player.pos);
    const selected = player.id === view.selectedId;
    const colour = player.unconscious ? '#f0b429' : player.bleeding ? '#e5484d' : '#3fb950';

    // Направление взгляда — короткий луч, сразу видно, куда смотрит.
    if (player.dir) {
      const rad = ((player.dir - 90) * Math.PI) / 180;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(rad) * 14, p.y + Math.sin(rad) * 14);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, selected ? 8 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();

    if (selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `${selected ? 'bold ' : ''}11px system-ui, sans-serif`;
    ctx.fillText(player.name, p.x + 10, p.y + 4);
  }
}

function bindCanvas() {
  // Холст 900×900 растягивается по ширине карточки, поэтому координаты события
  // нужно пересчитывать: e.offsetX — это пиксели на экране, а не на холсте.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const point = canvasPoint(e);
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, point.x, point.y);
  });

  let last = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    last = canvasPoint(e);
    camera.dragging = false;
    hideMenu();
  });
  canvas.addEventListener('mousemove', (e) => {
    if (!last) return;
    const point = canvasPoint(e);
    camera.x += point.x - last.x;
    camera.y += point.y - last.y;
    last = point;
    camera.dragging = true;
    draw();
  });
  canvas.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    const wasDragging = camera.dragging;
    last = null;
    camera.dragging = false;
    if (!wasDragging) {
      const point = canvasPoint(e);
      pickPlayer(point.x, point.y);
    }
  });
  canvas.addEventListener('mouseleave', () => {
    last = null;
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(e);
  });
}

/* ------------------------------------------------- меню по правому клику */

function hideMenu() {
  const menu = paneRef && paneRef.querySelector('#map-menu');
  if (menu) menu.classList.add('hidden');
}

/**
 * Меню действий в точке карты: заспавнить объект, телепортировать выбранного
 * игрока, скопировать координаты. Всё это команды мода-моста.
 */
function openMenu(event) {
  const menu = paneRef.querySelector('#map-menu');
  if (!menu) return;

  const point = canvasPoint(event);
  const world = toWorld(point.x, point.y);
  const x = Math.round(world.x);
  const z = Math.round(world.z);

  const inside = x >= 0 && z >= 0 && x <= view.worldSize && z <= view.worldSize;
  if (!inside) return hideMenu();

  const selected = view.players.find((p) => p.id === view.selectedId);

  menu.innerHTML = `
    <div class="map-menu-head">${x} / ${z}</div>
    <button data-menu="spawn">${icon('package')} Заспавнить объект здесь…</button>
    ${selected
      ? `<button data-menu="teleport">${icon('map')} Телепортировать «${esc(selected.name)}» сюда</button>`
      : '<div class="map-menu-note">Выберите игрока, чтобы телепортировать его сюда</div>'}
    <button data-menu="copy">${icon('file')} Скопировать координаты</button>`;

  // Меню рисуется в пикселях карточки, а не холста.
  const rect = canvas.getBoundingClientRect();
  menu.style.left = `${event.clientX - rect.left}px`;
  menu.style.top = `${event.clientY - rect.top}px`;
  menu.classList.remove('hidden');

  menu.querySelectorAll('[data-menu]').forEach((button) => {
    button.addEventListener('click', () => {
      hideMenu();
      const action = button.dataset.menu;

      if (action === 'copy') {
        navigator.clipboard
          .writeText(`${x} ${z}`)
          .then(() => toast('Координаты скопированы', 'ok'))
          .catch(() => toast(`Координаты: ${x} ${z}`, 'info', 9000));
        return;
      }

      if (action === 'teleport' && selected) {
        api
          .bridgeCommand('teleport', { id: selected.id, pos: [x, 0, z] })
          .then(() => toast(`${selected.name} телепортирован в ${x} / ${z}`, 'ok'))
          .catch((err) => toast(err.message, 'err', 12000));
        return;
      }

      if (action === 'spawn') openSpawnModal(x, z);
    });
  });
}

/** Что заспавнить в выбранной точке. */
function openSpawnModal(x, z) {
  const m = modal({
    title: 'Заспавнить объект',
    subtitle: `Точка ${x} / ${z}`,
    icon: 'package',
    body: `
      <div class="form-grid one">
        <div class="field">
          <label>Класс объекта</label>
          <input type="text" id="spawn-class" value="" placeholder="например Sedan_02, AKM, SeaChest">
          <div class="hint">Точное имя класса из игры или мода: транспорт, оружие, ящик, палатка.</div>
        </div>
        <div class="field">
          <label>Количество в предмете <span class="badge">необязательно</span></label>
          <input type="number" id="spawn-quantity" value="0" min="0">
          <div class="hint">Для патронов, еды, жидкостей. 0 — как в игре по умолчанию.</div>
        </div>
      </div>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn btn-primary" id="spawn-go">${icon('package')} Заспавнить</button>`
  });

  m.footer.querySelector('#spawn-go').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const itemClass = m.body.querySelector('#spawn-class').value.trim();
      if (!itemClass) return toast('Укажите класс объекта', 'warn');

      const quantity = Number(m.body.querySelector('#spawn-quantity').value) || 0;
      await api.bridgeCommand('spawn_object', { itemClass, pos: [x, 0, z], quantity });

      m.close();
      toast(`${itemClass} создан в ${x} / ${z}`, 'ok', 9000);
    })
  );
}

/* ------------------------------------------------------------- трассы */

/** Подтянуть трассы с сервера: выбранного игрока и, если нужно, всех. */
async function refreshTrails() {
  if (view.showAllTrails) {
    try {
      const data = await api.bridgeTrails(view.trailMinutes);
      view.trails = data.trails || [];
    } catch (_) {
      view.trails = [];
    }
  } else {
    view.trails = [];
  }

  if (view.selectedId) {
    try {
      view.trail = await api.bridgeTrail(view.selectedId, view.trailMinutes);
    } catch (_) {
      view.trail = null;
    }
  } else {
    view.trail = null;
  }

  draw();
  if (view.selectedId) renderCard(view.selectedId);
}

/**
 * Дописать свежую точку в уже загруженную трассу.
 *
 * Снимок приходит каждые несколько секунд, и просить сервер каждый раз о всей
 * трассе незачем: новая точка уже есть в снимке.
 */
function appendTrailPoint(player) {
  if (!view.trail || view.trail.playerId !== player.id) return;

  const points = view.trail.points;
  const last = points[points.length - 1];
  if (last && Math.hypot(player.pos[0] - last.x, player.pos[2] - last.z) < 3) return;

  points.push({ ts: Date.now(), x: player.pos[0], z: player.pos[2] });
  if (last) view.trail.distanceM += Math.round(Math.hypot(player.pos[0] - last.x, player.pos[2] - last.z));
}

/** Линия пути: свежие участки ярче, старые бледнее. */
function drawTrail(ctx, points, colour, width) {
  if (!points || points.length < 2) return;

  for (let i = 1; i < points.length; i++) {
    const from = toScreen([points[i - 1].x, 0, points[i - 1].z]);
    const to = toScreen([points[i].x, 0, points[i].z]);

    ctx.strokeStyle = colour.replace('ALPHA', String(0.15 + 0.75 * (i / points.length)).slice(0, 4));
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  // Точка старта — чтобы было видно, откуда игрок пришёл.
  const start = toScreen([points[0].x, 0, points[0].z]);
  ctx.fillStyle = colour.replace('ALPHA', '0.9');
  ctx.beginPath();
  ctx.arc(start.x, start.y, 3, 0, Math.PI * 2);
  ctx.fill();
}

function zoomBy(factor, cx, cy) {
  const before = camera.zoom;
  camera.zoom = Math.min(12, Math.max(0.5, camera.zoom * factor));

  // Точка под курсором остаётся на месте. Кнопки «+»/«−» курсора не дают —
  // тогда держим центр холста, иначе карта уезжает из вида.
  const ax = cx === undefined ? canvas.width / 2 : cx;
  const ay = cy === undefined ? canvas.height / 2 : cy;
  const k = camera.zoom / before;

  camera.x = ax - (ax - camera.x) * k;
  camera.y = ay - (ay - camera.y) * k;
  draw();
}

/** Ближайшая метка к клику. */
function pickPlayer(x, y) {
  let best = null;
  let bestDistance = 18;

  for (const player of view.players) {
    const p = toScreen(player.pos);
    const distance = Math.hypot(p.x - x, p.y - y);
    if (distance < bestDistance) {
      best = player;
      bestDistance = distance;
    }
  }

  if (best) select(best.id);
}

/* ------------------------------------------------------------ список игроков */

function renderList() {
  const list = paneRef && paneRef.querySelector('#map-players');
  if (!list) return;

  const count = paneRef.querySelector('#map-count');
  if (count) count.textContent = `${view.players.length} чел. · обновляется автоматически`;

  const sub = paneRef.querySelector('#map-sub');
  if (sub) sub.textContent = sub.textContent.replace(/игроков \d+/, `игроков ${view.players.length}`);

  if (!view.players.length) {
    list.innerHTML = `<div class="notice info"><span class="ic">${icon('users')}</span>
      <div>Сейчас на сервере никого нет.</div></div>`;
    return;
  }

  list.innerHTML = view.players
    .map(
      (p) => `
        <div class="mod-row ${p.id === view.selectedId ? 'selected' : ''}" data-player="${esc(p.id)}">
          <div class="mod-thumb ph">${icon('users')}</div>
          <div class="mod-main">
            <div class="mod-name">${esc(p.name)}</div>
            <div class="mod-meta">
              <span>${Math.round(p.pos[0])} · ${Math.round(p.pos[2])}</span>
              ${p.health >= 0 ? `<span>HP ${Math.round(p.health)}</span>` : ''}
              ${p.bleeding ? '<span class="badge warn">кровь</span>' : ''}
              ${p.unconscious ? '<span class="badge warn">без сознания</span>' : ''}
              ${p.vehicle ? `<span class="badge">${esc(p.vehicle)}</span>` : ''}
            </div>
          </div>
          <div class="mod-actions"><button class="btn btn-sm">Открыть</button></div>
        </div>`
    )
    .join('');

  for (const row of list.querySelectorAll('[data-player]')) {
    row.addEventListener('click', () => select(row.dataset.player));
  }
}

function select(id) {
  view.selectedId = id;
  view.trail = null;
  draw();
  renderList();
  renderCard(id);
  refreshTrails();
}

/* ----------------------------------------------------------- карточка игрока */

function renderCard(id) {
  const box = paneRef && paneRef.querySelector('#map-card');
  const player = view.players.find((p) => p.id === id);
  if (!box) return;

  if (!player) {
    box.innerHTML = `<div class="notice warn"><span class="ic">${icon('alert')}</span>
      <div>Игрок вышел с сервера.</div></div>`;
    return;
  }

  const stat = (label, value, extra = '') =>
    value < 0 ? '' : `<div class="stat"><div class="k">${label}</div><div class="v" style="font-size:18px">${value}${extra}</div></div>`;

  box.innerHTML = `
    <div class="card-head">
      <span class="card-title-icon">${icon('users')}</span>
      <div><h2>${esc(player.name)}</h2>
        <div class="card-sub">${esc(player.steam64)} · ${Math.round(player.pos[0])} / ${Math.round(player.pos[2])}
          ${player.playtimeSec ? ` · в игре ${fmtUptime(player.playtimeSec)}` : ''}</div></div>
    </div>

    <div class="stat-grid">
      ${stat('здоровье', Math.round(player.health))}
      ${stat('кровь', Math.round(player.blood))}
      ${stat('голод', Math.round(player.hunger), '%')}
      ${stat('жажда', Math.round(player.thirst), '%')}
      ${stat('выносливость', Math.round(player.stamina), '%')}
      ${player.heatComfort !== undefined && player.heatComfort !== null && player.heatComfort !== 0
        ? stat('тепло', Math.round(player.heatComfort * 100), '%')
        : ''}
    </div>

    ${player.hands || player.vehicle || player.bleeding || player.unconscious
      ? `<div class="row wrap" style="margin-top:12px;gap:8px">
          ${player.hands ? `<span class="badge">в руках: ${esc(player.hands)}</span>` : ''}
          ${player.vehicle ? `<span class="badge">в транспорте: ${esc(player.vehicle)}</span>` : ''}
          ${player.bleeding ? '<span class="badge warn">кровотечение</span>' : ''}
          ${player.unconscious ? '<span class="badge warn">без сознания</span>' : ''}
          ${player.restrained ? '<span class="badge warn">связан</span>' : ''}
        </div>`
      : ''}

    ${view.trail && view.trail.playerId === player.id && view.trail.points.length > 1
      ? `<div class="notice info" style="margin-top:12px"><span class="ic">${icon('map')}</span>
          <div>Трасса за ${view.trail.minutes} мин.: ${view.trail.points.length} точек,
          пройдено примерно ${view.trail.distanceM} м. Начало пути отмечено точкой на карте.</div></div>`
      : ''}

    <div class="row wrap" style="margin-top:16px">
      <button class="btn btn-sm" data-act="message">${icon('file')} Сообщение</button>
      <button class="btn btn-sm" data-act="heal">${icon('thumb')} Вылечить</button>
      <button class="btn btn-sm" data-act="feed">${icon('package')} Накормить</button>
      <button class="btn btn-sm" data-act="stat">${icon('activity')} Показатель…</button>
      <button class="btn btn-sm" data-act="give">${icon('plus')} Выдать предмет</button>
      <button class="btn btn-sm" data-act="teleport">${icon('map')} Телепорт</button>
      <button class="btn btn-sm" data-act="inventory">${icon('db')} Инвентарь</button>
      <button class="btn btn-sm" data-act="logs">${icon('activity')} Его логи</button>
      <button class="btn btn-sm btn-danger" data-act="kick">${icon('x')} Кик</button>
    </div>

    <div id="card-extra" style="margin-top:16px"></div>`;

  for (const btn of box.querySelectorAll('[data-act]')) {
    btn.addEventListener('click', (e) => onAction(e.currentTarget, player));
  }
}

async function onAction(btn, player) {
  const act = btn.dataset.act;
  const extra = paneRef.querySelector('#card-extra');

  const run = (action, args, okText) =>
    busy(btn, async () => {
      await api.bridgeCommand(action, { id: player.id, ...args });
      toast(okText, 'ok');
    });

  if (act === 'heal') return run('heal', {}, `${player.name}: вылечен`);
  if (act === 'feed') {
    return busy(btn, async () => {
      await api.bridgeCommand('set_stat', { id: player.id, stat: 'hunger', value: 100 });
      await api.bridgeCommand('set_stat', { id: player.id, stat: 'thirst', value: 100 });
      toast(`${player.name}: голод и жажда восполнены`, 'ok');
    });
  }

  if (act === 'message') {
    return askText({
      title: `Сообщение для ${player.name}`,
      label: 'Текст',
      confirmText: 'Отправить',
      onSubmit: async (text) => {
        await api.bridgeCommand('message', { id: player.id, text, style: 'popup' });
        toast('Сообщение отправлено', 'ok');
      }
    });
  }

  if (act === 'kick') {
    const yes = await confirmDialog({
      title: `Выкинуть ${player.name}?`,
      message: 'Игрок сможет зайти снова — это не бан.',
      confirmText: 'Выкинуть',
      danger: true
    });
    if (!yes) return;
    return run('kick', { reason: 'Kicked by admin' }, `${player.name} исключён`);
  }

  if (act === 'stat') return openStatModal(player);
  if (act === 'give') {
    return askText({
      title: 'Выдать предмет',
      label: 'Класс предмета',
      value: 'Rice',
      confirmText: 'Выдать',
      hint: 'Например: AKM, Rice, BandageDressing, WaterBottle',
      onSubmit: async (cls) => {
        await api.bridgeCommand('give_item', { id: player.id, itemClass: cls, quantity: 1 });
        toast(`Выдано: ${cls}`, 'ok');
      }
    });
  }

  if (act === 'teleport') {
    return askText({
      title: `Телепортировать ${player.name}`,
      label: 'Координаты X Z (или X Y Z)',
      value: `${Math.round(player.pos[0])} ${Math.round(player.pos[2])}`,
      confirmText: 'Телепортировать',
      hint: 'Числа через пробел. Высоту панель подставит сама, если не указана.',
      onSubmit: async (text) => {
        const parts = text.split(/[\s,;]+/).map(Number).filter((n) => Number.isFinite(n));
        if (parts.length < 2) throw new Error('Нужно минимум два числа: X и Z');
        const pos = parts.length >= 3 ? [parts[0], parts[1], parts[2]] : [parts[0], 0, parts[1]];
        await api.bridgeCommand('teleport', { id: player.id, pos });
        toast('Телепортирован', 'ok');
      }
    });
  }

  if (act === 'inventory') {
    return busy(btn, async () => {
      extra.innerHTML = '<div class="small faint">Запрашиваю инвентарь у сервера…</div>';
      const inv = await api.bridgeInventory(player.id);
      extra.innerHTML = renderInventory(inv);
    });
  }

  if (act === 'logs') {
    return busy(btn, async () => {
      extra.innerHTML = '<div class="small faint">Читаю историю…</div>';
      const { events } = await api.events({ playerId: player.id, limit: 60, days: 7 });
      extra.innerHTML = renderPlayerEvents(events);
    });
  }
}

function openStatModal(player) {
  const stats = [
    { value: 'health', label: 'Здоровье' },
    { value: 'blood', label: 'Кровь' },
    { value: 'shock', label: 'Шок' },
    { value: 'hunger', label: 'Голод' },
    { value: 'thirst', label: 'Жажда' },
    { value: 'stamina', label: 'Выносливость' },
    { value: 'temperature', label: 'Температура' }
  ];

  const m = modal({
    title: `Показатель: ${player.name}`,
    subtitle: 'Задать значение или прибавить/убавить',
    icon: 'activity',
    body: `
      <div class="form-grid one">
        <div class="field">
          <label>Показатель</label>
          <select id="stat-name">${stats.map((s) => `<option value="${s.value}">${s.label}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>Как менять</label>
          <select id="stat-mode">
            <option value="set">Задать значение</option>
            <option value="add">Прибавить (можно минус)</option>
          </select>
        </div>
        <div class="field">
          <label>Значение</label>
          <input type="number" id="stat-value" value="100" step="1">
          <div class="hint">Голод, жажда, выносливость, здоровье — в процентах 0…100</div>
        </div>
      </div>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn btn-primary" id="stat-go">Применить</button>`
  });

  m.footer.querySelector('#stat-go').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const stat = m.body.querySelector('#stat-name').value;
      const mode = m.body.querySelector('#stat-mode').value;
      const value = Number(m.body.querySelector('#stat-value').value);

      if (mode === 'add') await api.bridgeCommand('add_stat', { id: player.id, stat, delta: value });
      else await api.bridgeCommand('set_stat', { id: player.id, stat, value });

      m.close();
      toast(`${player.name}: ${stat} обновлён`, 'ok');
    })
  );
}

/* ------------------------------------------------------------- инвентарь */

function renderInventory(inv) {
  const item = (it, depth = 0) => `
    <div class="inv-row" style="padding-left:${depth * 16}px">
      <span class="inv-name">${esc(it.class || '—')}</span>
      ${it.slot ? `<span class="badge">${esc(it.slot)}</span>` : ''}
      ${it.container ? `<span class="badge">${esc(it.container)}</span>` : ''}
      ${it.quantity !== undefined && it.quantity !== null ? `<span class="small faint">× ${esc(String(it.quantity))}</span>` : ''}
      ${it.health !== undefined ? `<span class="small faint">${Math.round(it.health)}%</span>` : ''}
    </div>
    ${(it.children || []).map((child) => item(child, depth + 1)).join('')}`;

  const section = (title, items) =>
    items && items.length
      ? `<div class="card-sub mb" style="margin-top:10px">${title}</div>${items.map((it) => item(it)).join('')}`
      : '';

  return `
    <div class="inv-box">
      ${inv.hands ? `<div class="card-sub mb">В руках</div>${item(inv.hands)}` : ''}
      ${section('Одежда и снаряжение', inv.clothing)}
      ${section('В сумках и карманах', inv.cargo)}
      ${!inv.hands && !(inv.clothing || []).length && !(inv.cargo || []).length
        ? '<div class="small faint">Инвентарь пуст.</div>'
        : ''}
    </div>`;
}

/* -------------------------------------------------------- события игрока */

function renderPlayerEvents(events) {
  if (!events.length) return '<div class="small faint">Событий по этому игроку пока нет.</div>';

  return `
    <div class="card-sub mb">Последние действия</div>
    <div class="ev-list">
      ${events
        .map(
          (e) => `
            <div class="ev-row">
              <span class="ev-time">${esc(fmtDate(e.ts))}</span>
              <span class="ev-type t-${esc(e.type)}">${esc(eventLabel(e.type))}</span>
              <span class="ev-text">${esc(eventText(e))}</span>
            </div>`
        )
        .join('')}
    </div>`;
}

/** Человеческие названия типов событий — те же, что во вкладке «Логи». */
export const EVENT_LABELS = {
  connect: 'зашёл',
  spawn: 'появился',
  disconnect: 'вышел',
  death: 'смерть',
  kill: 'убийство',
  damage: 'урон',
  shot: 'выстрел',
  chat: 'чат',
  item_take: 'взял',
  item_drop: 'выбросил',
  item_move: 'переложил',
  action: 'действие',
  vehicle_enter: 'сел в транспорт',
  vehicle_exit: 'вышел из транспорта',
  vehicle_engine: 'двигатель',
  vehicle_destroy: 'транспорт уничтожен',
  build: 'постройка',
  dismantle: 'разбор',
  container_open: 'открыл',
  placement: 'установил',
  unconscious: 'без сознания',
  bleeding: 'кровотечение',
  admin: 'админ',
  command_result: 'ответ мода',
  server: 'сервер'
};

export const eventLabel = (type) => EVENT_LABELS[type] || type;

/** Короткое человеческое описание события для строки в логе. */
export function eventText(event) {
  const d = event.data || {};
  const who = event.playerName || event.playerId || '—';
  const target = event.targetName || event.targetId || '';

  switch (event.type) {
    case 'chat':
      return `${who} (${d.channel || 'чат'}): ${d.text || ''}`;
    case 'damage':
      return `${target || who} получил ${round(d.damage)} по ${d.zone || '—'}` +
        `${d.weapon ? ` из ${d.weapon}` : ''}${d.distance ? `, ${round(d.distance)} м` : ''}` +
        `${event.playerName ? ` — от ${who}` : d.sourceType ? ` — ${d.sourceType}` : ''}`;
    case 'kill':
      return `${who} убил ${target || d.victimId || '—'}${d.weapon ? ` из ${d.weapon}` : ''}` +
        `${d.distance ? `, ${round(d.distance)} м` : ''}`;
    case 'death':
      return `${who} погиб${d.killerId ? ` от ${target || d.killerId}` : ''}${d.reason ? ` (${d.reason})` : ''}`;
    case 'shot':
      return `${who} стреляет из ${d.weapon || '—'}${d.ammo ? ` (${d.ammo})` : ''}`;
    case 'item_take':
      return `${who} взял ${d.class || '—'}${d.quantity ? ` × ${round(d.quantity)}` : ''}${d.from ? ` из ${d.from}` : ''}`;
    case 'item_drop':
      return `${who} выбросил ${d.class || '—'}`;
    case 'item_move':
      return `${who} переложил ${d.class || '—'} ${d.from || ''} → ${d.to || ''}`;
    case 'action':
      return `${who}: ${d.action || 'действие'}${d.target ? ` → ${d.target}` : ''}`;
    case 'container_open':
      return `${who} открыл ${d.class || '—'}${d.locked ? ' (был заперт)' : ''}`;
    case 'vehicle_enter':
      return `${who} сел в ${d.class || '—'}${d.seat !== undefined ? ` (место ${d.seat})` : ''}`;
    case 'vehicle_exit':
      return `${who} вышел из ${d.class || '—'}`;
    case 'vehicle_engine':
      return `${who}: двигатель ${d.class || ''} ${d.on ? 'запущен' : 'остановлен'}`;
    case 'build':
      return `${who} построил ${d.part || '—'}${d.target ? ` на ${d.target}` : ''}`;
    case 'dismantle':
      return `${who} разобрал ${d.part || '—'}`;
    case 'placement':
      return `${who} поставил ${d.class || '—'}`;
    case 'connect':
      return `${who} подключился`;
    case 'spawn':
      return `${who} появился в мире${d.fresh ? ' (новый персонаж)' : ''}`;
    case 'disconnect':
      return `${who} вышел${d.playtimeSec ? `, играл ${Math.round(d.playtimeSec / 60)} мин.` : ''}`;
    case 'unconscious':
      return `${who} ${d.state ? 'потерял сознание' : 'пришёл в себя'}`;
    case 'bleeding':
      return `${who}: кровотечение ${d.state ? 'началось' : 'остановлено'}`;
    case 'admin': {
      // Из VPPAdminTools приходит готовая строка, от панели — команда моду.
      if (d.source === 'vpp') return `${who} — ${d.phrase || d.text || d.action || 'действие'}`;

      const label = d.action || d.command || 'команда';
      const result = d.ok === false ? `ошибка — ${d.error || ''}` : 'выполнена';
      const on = target ? ` (${target})` : '';
      return d.text ? `панель: ${d.text}` : `панель, ${label}${on}: ${result}`;
    }
    case 'server':
      return d.message || 'событие сервера';
    default:
      return `${who} ${JSON.stringify(d).slice(0, 160)}`;
  }
}

const round = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : '—');

/* --------------------------------------------------------- мелкий диалог */

function askText(opts) {
  const m = modal({
    title: opts.title,
    subtitle: opts.subtitle,
    icon: 'file',
    body: `
      <div class="field">
        <label>${esc(opts.label)}</label>
        <input type="text" id="ask-value" value="${esc(opts.value || '')}">
        ${opts.hint ? `<div class="hint">${esc(opts.hint)}</div>` : ''}
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
