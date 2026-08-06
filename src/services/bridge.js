'use strict';

/**
 * Мост между панелью и серверным модом @DayZPanelBridge.
 *
 * Обмен идёт файлами в папке профиля сервера — никаких сетевых портов, ничего
 * не нужно открывать в брандмауэре, и обе стороны переживают перезапуск друг
 * друга. Протокол целиком описан в docs/bridge-mod-prompt.md; здесь его
 * панельная половина:
 *
 *   panel/hello.json     мод пишет при старте: версия, мир, размер карты
 *   panel/snapshot.json   мод перезаписывает каждые несколько секунд: игроки
 *   panel/out/ev_*.json   события: панель читает, обрабатывает и удаляет
 *   panel/in/cmd_*.json   команды: панель пишет, мод выполняет и удаляет
 *
 * События уходят в eventlog.js (история), состояние игроков живёт в памяти и
 * транслируется в браузер через шину событий.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const logger = require('../logger');
const bus = require('../events');
const eventlog = require('./eventlog');

const SOURCE = 'bridge';

/** Как часто заглядываем в папку обмена. */
const POLL_MS = 1000;

/** Сколько ждём ответа мода на команду. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Мод считается живым, если снимок обновлялся не дольше этого времени назад. */
const ONLINE_TIMEOUT_MS = 20_000;

/** Сколько точек трассы держим на игрока (при снимке раз в 3 с это ~1 час). */
const TRAIL_LIMIT = 1200;

/** Точки старше этого времени выбрасываются. */
const TRAIL_KEEP_MS = 2 * 3600_000;

/** Насколько игрок должен сместиться, чтобы точка попала в трассу. */
const TRAIL_MIN_STEP_M = 3;

/** Размеры известных карт (метры на сторону) — если мод не сообщил свой. */
const WORLD_SIZES = {
  chernarusplus: 15360,
  chernarus: 15360,
  enoch: 12800,
  sakhal: 8192,
  namalsk: 12800,
  deerisle: 16384,
  banov: 12800
};

/**
 * serverId -> {
 *   hello, snapshot, players: Map, snapshotAt, helloAt,
 *   pending: Map<commandId, {resolve, reject, timer}>, dropped, lastEventAt, warned
 * }
 */
const states = new Map();
let timer = null;

function stateOf(serverId) {
  if (!states.has(serverId)) {
    states.set(serverId, {
      hello: null,
      helloAt: 0,
      snapshot: null,
      snapshotAt: 0,
      players: [],
      pending: new Map(),
      dropped: 0,
      lastEventAt: 0,
      warned: '',
      // playerId -> [{ ts, x, z }]: откуда пришёл игрок. Живёт в памяти панели,
      // потому что мод шлёт позиции только в снимках и историю не хранит.
      trails: new Map()
    });
  }
  return states.get(serverId);
}

/* -------------------------------------------------------------------- пути */

/** Корень обмена: <профиль сервера>/panel. */
function bridgeDir(serverId) {
  const v = config.active(serverId);
  return path.join(config.profilesPath(v), 'panel');
}

const outDir = (serverId) => path.join(bridgeDir(serverId), 'out');
const inDir = (serverId) => path.join(bridgeDir(serverId), 'in');

/* ---------------------------------------------------------------- состояние */

/** Состояние моста для интерфейса — без чтения диска. */
function status(serverId) {
  let dir = '';
  try {
    dir = bridgeDir(serverId);
  } catch (err) {
    return { installed: false, online: false, reason: err.message };
  }

  const st = stateOf(serverId);
  const online = Date.now() - st.snapshotAt < ONLINE_TIMEOUT_MS;
  const hello = st.hello || {};

  return {
    dir,
    installed: fs.existsSync(dir),
    online,
    protocol: hello.protocol || null,
    modVersion: hello.modVersion || '',
    world: hello.world || '',
    worldSize: worldSize(serverId),
    startedAt: hello.startedAt || null,
    features: hello.features || [],
    playersOnline: st.players.length,
    snapshotAt: st.snapshotAt || null,
    lastEventAt: st.lastEventAt || null,
    gameTime: st.snapshot ? st.snapshot.gameTime || '' : '',
    dropped: st.dropped,
    pendingCommands: st.pending.size,
    reason: reasonFor(serverId, dir, online)
  };
}

/** Понятное объяснение, почему моста нет. */
function reasonFor(serverId, dir, online) {
  if (online) return '';
  if (!fs.existsSync(dir)) {
    return (
      'мод-мост не установлен или ещё не запускался: панель не видит папку ' +
      `${dir}. Подключите @DayZPanelBridge через -serverMod= и запустите сервер`
    );
  }
  const st = stateOf(serverId);
  if (!st.snapshotAt) return 'папка обмена есть, но мод не присылал состояние — сервер запущен?';
  return 'мод молчит: сервер остановлен или мод выключен в panel/config.json';
}

/** Размер карты в метрах: из hello, иначе по имени миссии. */
function worldSize(serverId) {
  const st = stateOf(serverId);
  const fromHello = st.hello && Number(st.hello.worldSize);
  if (fromHello > 0) return fromHello;

  let mission = '';
  try {
    mission = config.active(serverId).server.mission || '';
  } catch (_) {
    /* сервера может не быть */
  }
  const world = (st.hello && st.hello.world) || mission.split('.').pop() || '';
  return WORLD_SIZES[String(world).toLowerCase()] || 15360;
}

/** Игроки онлайн по последнему снимку. */
function players(serverId) {
  const st = stateOf(serverId);
  return { players: st.players, snapshotAt: st.snapshotAt, worldSize: worldSize(serverId) };
}

const playerOf = (serverId, id) => stateOf(serverId).players.find((p) => p.id === String(id)) || null;

/* ------------------------------------------------------------- чтение файлов */

function tick() {
  for (const server of config.servers()) {
    try {
      readSnapshot(server.id);
      readHello(server.id);
      readEvents(server.id);
    } catch (err) {
      warnOnce(server.id, `Ошибка чтения моста: ${err.message}`);
    }
  }
}

/** Одинаковая жалоба не повторяется в логе. */
function warnOnce(serverId, message) {
  const st = stateOf(serverId);
  if (st.warned === message) return;
  st.warned = message;
  logger.warn(SOURCE, message, { serverId });
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch (_) {
    // Мод пишет через .tmp + копирование, но на всякий случай: битый или
    // недописанный файл просто пропускаем — на следующем тике будет целый.
    return null;
  }
}

function readHello(serverId) {
  const file = path.join(bridgeDir(serverId), 'hello.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return;
  }

  const st = stateOf(serverId);
  if (stat.mtimeMs === st.helloAt) return;

  const hello = readJson(file);
  if (!hello) return;

  st.helloAt = stat.mtimeMs;
  const known = st.hello && st.hello.startedAt === hello.startedAt;
  st.hello = hello;

  if (!known) {
    logger.info(
      SOURCE,
      `Мод-мост на связи: ${hello.mod || 'DayZPanelBridge'} ${hello.modVersion || ''}, ` +
        `протокол ${hello.protocol}, карта ${hello.world || '—'} (${worldSize(serverId)} м)`,
      { serverId }
    );
    bus.emit('bridge-status', { serverId, ...status(serverId) });
  }
}

function readSnapshot(serverId) {
  const file = path.join(bridgeDir(serverId), 'snapshot.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return;
  }

  const st = stateOf(serverId);
  if (stat.mtimeMs === st.snapshotAt) return;

  const snapshot = readJson(file);
  if (!snapshot) return;

  st.snapshotAt = stat.mtimeMs;
  st.snapshot = snapshot;
  st.players = (Array.isArray(snapshot.players) ? snapshot.players : []).map(normalizePlayer);
  if (Number(snapshot.dropped) > 0) st.dropped = Number(snapshot.dropped);

  recordTrails(serverId, st);
  bus.emit('bridge-players', { serverId, ...players(serverId) });
}

/**
 * Данные игрока приводим к предсказуемому виду: интерфейс не должен проверять
 * каждое поле на существование, а мод — внешний код.
 */
function normalizePlayer(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  return {
    id: String(p.id || p.steam64 || ''),
    steam64: String(p.steam64 || p.id || ''),
    name: String(p.name || 'без имени').slice(0, 64),
    pos: Array.isArray(p.pos) ? p.pos.slice(0, 3).map((n) => num(n)) : [0, 0, 0],
    dir: num(p.dir),
    health: num(p.health),
    blood: num(p.blood),
    shock: num(p.shock),
    hunger: num(p.hunger, -1),
    thirst: num(p.thirst, -1),
    energy: num(p.energy, -1),
    water: num(p.water, -1),
    temperature: num(p.temperature, -1),
    // Движок отдаёт не «температуру тела», а комфорт по теплу: -1 замерзает,
    // +1 перегрев. Панель показывает именно его.
    heatComfort: num(p.heatComfort, 0),
    wet: num(p.wet),
    stamina: num(p.stamina, -1),
    bleeding: Boolean(p.bleeding),
    unconscious: Boolean(p.unconscious),
    restrained: Boolean(p.restrained),
    hands: String(p.hands || ''),
    vehicle: p.vehicle ? String(p.vehicle) : null,
    playtimeSec: num(p.playtimeSec),
    ping: num(p.ping, -1)
  };
}

/* ---------------------------------------------------------------- трассы */

/**
 * Запомнить, где игроки были.
 *
 * Точка добавляется, только если игрок реально сместился: стоящий на месте
 * человек иначе за час накопил бы тысячу одинаковых координат.
 */
function recordTrails(serverId, st) {
  const now = Date.now();

  for (const player of st.players) {
    if (!player.id) continue;

    if (!st.trails.has(player.id)) st.trails.set(player.id, []);
    const trail = st.trails.get(player.id);
    const last = trail[trail.length - 1];

    if (last && Math.hypot(player.pos[0] - last.x, player.pos[2] - last.z) < TRAIL_MIN_STEP_M) continue;

    trail.push({ ts: now, x: player.pos[0], z: player.pos[2] });
    if (trail.length > TRAIL_LIMIT) trail.splice(0, trail.length - TRAIL_LIMIT);
  }

  // Старые точки и трассы давно ушедших игроков не держим.
  const cutoff = now - TRAIL_KEEP_MS;
  for (const [id, trail] of st.trails) {
    while (trail.length && trail[0].ts < cutoff) trail.shift();
    if (!trail.length) st.trails.delete(id);
  }
}

/**
 * Трасса одного игрока.
 * @param {string} serverId
 * @param {string} playerId
 * @param {number} [minutes] за сколько последних минут
 */
function trail(serverId, playerId, minutes = 30) {
  const st = stateOf(serverId);
  const points = st.trails.get(String(playerId)) || [];
  const since = Date.now() - Math.min(Math.max(minutes, 1), 120) * 60_000;

  const selected = points.filter((point) => point.ts >= since);
  const player = st.players.find((p) => p.id === String(playerId));

  return {
    playerId: String(playerId),
    name: player ? player.name : '',
    online: Boolean(player),
    minutes,
    worldSize: worldSize(serverId),
    points: selected,
    // Пройденный путь по прямым между точками: грубо, но сразу видно, кто
    // бегал по карте, а кто сидел в базе.
    distanceM: Math.round(
      selected.reduce((sum, point, index) => {
        if (!index) return 0;
        const previous = selected[index - 1];
        return sum + Math.hypot(point.x - previous.x, point.z - previous.z);
      }, 0)
    )
  };
}

/** Трассы всех, кто сейчас онлайн. */
function allTrails(serverId, minutes = 15) {
  const st = stateOf(serverId);
  return {
    worldSize: worldSize(serverId),
    minutes,
    trails: st.players.map((player) => trail(serverId, player.id, minutes))
  };
}

/** Забрать и удалить пачки событий. */
function readEvents(serverId) {
  const dir = outDir(serverId);
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => /^ev_.*\.json$/i.test(name));
  } catch (_) {
    return;
  }
  if (!names.length) return;

  // Имена содержат время и счётчик — сортировка по имени сохраняет порядок.
  names.sort();

  const st = stateOf(serverId);
  const collected = [];

  for (const name of names) {
    const file = path.join(dir, name);
    const chunk = readJson(file);

    if (!chunk) {
      // Недописанный файл оставляем до следующего тика; битый (лежит давно) —
      // убираем, иначе он будет мешать вечно.
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > 30_000) {
          fs.rmSync(file, { force: true });
          logger.warn(SOURCE, `Битый файл событий удалён: ${name}`, { serverId });
        }
      } catch (_) {
        /* уже исчез */
      }
      continue;
    }

    if (Number(chunk.dropped) > 0) st.dropped += Number(chunk.dropped);
    if (Array.isArray(chunk.events)) collected.push(...chunk.events);

    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      warnOnce(serverId, `Не удалось удалить ${name}: ${err.message}`);
    }
  }

  if (!collected.length) return;

  /*
   * Ответы на команды — служебные: они закрывают ожидание в command() и в
   * историю попадают не как есть, а короткой записью «админ сделал то-то».
   * Иначе журнал действий игроков быстро зарастает техническими строками.
   */
  const forLog = [];
  for (const raw of collected) {
    if (raw && raw.type === 'command_result') {
      const data = (raw.data && typeof raw.data === 'object' ? raw.data : {});
      resolveCommand(serverId, { data });
      forLog.push({
        ts: raw.ts,
        type: 'admin',
        data: { command: data.action || '', ok: data.ok !== false, error: data.error || '' }
      });
      continue;
    }
    forLog.push(raw);
  }

  const stored = eventlog.append(serverId, forLog);
  st.lastEventAt = Date.now();

  bus.emit('bridge-events', { serverId, events: stored });
}

/* -------------------------------------------------------------------- команды */

/**
 * Отправить команду моду и дождаться ответа.
 *
 * @param {string} serverId
 * @param {string} action имя команды из протокола (message, kick, teleport, …)
 * @param {object} [args]
 * @returns {Promise<object>} поле result из ответа мода
 */
function command(serverId, action, args = {}) {
  const name = String(action || '').trim();
  if (!name) return Promise.reject(new Error('Не указана команда'));

  const st = stateOf(serverId);
  const online = Date.now() - st.snapshotAt < ONLINE_TIMEOUT_MS;
  if (!online) {
    return Promise.reject(new Error(`Мод-мост не на связи: ${status(serverId).reason}`));
  }

  const id = `c_${crypto.randomBytes(4).toString('hex')}`;
  const dir = inDir(serverId);
  const payload = JSON.stringify({ v: 1, id, action: name, args }, null, 2);

  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Пишем через .tmp, чтобы мод не прочитал половину файла.
      const tmp = path.join(dir, `cmd_${id}.tmp`);
      const final = path.join(dir, `cmd_${id}.json`);
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, final);
    } catch (err) {
      return reject(new Error(`Не удалось передать команду моду: ${err.message}`));
    }

    const timer_ = setTimeout(() => {
      st.pending.delete(id);
      reject(
        new Error(
          `Мод не ответил на команду «${name}» за ${COMMAND_TIMEOUT_MS / 1000} с. ` +
            'Проверьте, что сервер запущен и мод-мост включён.'
        )
      );
    }, COMMAND_TIMEOUT_MS);

    st.pending.set(id, { resolve, reject, timer: timer_, action: name });
    logger.info(SOURCE, `Команда моду: ${name} ${JSON.stringify(args)}`, { serverId });
  });
}

function resolveCommand(serverId, event) {
  const data = event.data || {};
  const entry = stateOf(serverId).pending.get(data.id);
  if (!entry) return;

  clearTimeout(entry.timer);
  stateOf(serverId).pending.delete(data.id);

  if (data.ok === false) entry.reject(new Error(data.error || `Мод отклонил команду «${entry.action}»`));
  else entry.resolve(data.result === undefined ? {} : data.result);
}

/** Инвентарь игрока: команда моду + ожидание ответа. */
function inventory(serverId, playerId) {
  if (!playerId) return Promise.reject(new Error('Не указан игрок'));
  return command(serverId, 'inventory', { id: String(playerId) });
}

/* ---------------------------------------------------------------- запуск */

function start() {
  if (timer) return;
  timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref();
  tick();

  for (const server of config.servers()) {
    const st = status(server.id);
    if (st.installed) logger.info(SOURCE, `Папка обмена с модом: ${st.dir}`, { serverId: server.id });
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  eventlog.close();
}

/**
 * Подготовить папку обмена заранее — до первого запуска мода.
 * Так админ видит, куда мод будет писать, ещё до того как его поставит.
 */
function prepare(serverId) {
  const dir = bridgeDir(serverId);
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
  logger.info(SOURCE, `Папка обмена подготовлена: ${dir}`, { serverId });
  return status(serverId);
}

module.exports = {
  start,
  stop,
  tick,
  status,
  players,
  playerOf,
  trail,
  allTrails,
  command,
  inventory,
  prepare,
  bridgeDir,
  worldSize,
  WORLD_SIZES,
  ONLINE_TIMEOUT_MS
};
