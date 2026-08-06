'use strict';

/**
 * HTTP API панели. Здесь только маршрутизация и валидация входных данных —
 * вся логика живёт в src/services/*.
 *
 * Длительные операции (установка сервера, загрузка модов, запуск) не держат
 * HTTP-соединение: они возвращают job.id, а прогресс приходит в браузер
 * через SSE-поток /api/stream.
 */

const express = require('express');

const config = require('../config');
const logger = require('../logger');
const bus = require('../events');

const jobs = require('../services/jobs');
const steamcmd = require('../services/steamcmd');
const workshop = require('../services/workshop');
const instances = require('../services/instances');
const mods = require('../services/mods');
const batgen = require('../services/batgen');
const firewall = require('../services/firewall');
const serverCfg = require('../services/serverCfg');
const missions = require('../services/missions');
const cftools = require('../services/cftools');
const serverProcess = require('../services/serverProcess');
const diagnostics = require('../services/diagnostics');
const scheduler = require('../services/scheduler');
const announcer = require('../services/announcer');
const ingame = require('../services/ingame');
const battleye = require('../services/battleye');
const bridge = require('../services/bridge');
const auth = require('../services/auth');
const access = require('../services/access');
const eventlog = require('../services/eventlog');

const router = express.Router();

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** id сервера из запроса: ?serverId=… или активный. */
function serverIdOf(req) {
  const id = req.query.serverId || (req.body && req.body.serverId);
  if (id) {
    if (!config.getServer(id)) throw new Error(`Сервер ${id} не найден`);
    return id;
  }
  const active = config.activeServer();
  if (!active) throw new Error('Сервер не выбран. Создайте сервер в панели.');
  return active.id;
}

/* ------------------------------------------------------------------- статус */

/* ------------------------------------------------------------------- вход */

/*
 * Эти маршруты работают до входа (см. PUBLIC_PATHS в services/auth.js), поэтому
 * из них наружу не уходит ничего, кроме факта «вход нужен» и результата попытки.
 */

router.get('/auth/status', (req, res) => res.json(auth.status(req)));

/* --------------------------------------------------- доступ снаружи */

/** Проверка «почему панель не открывается из сети», по шагам. */
router.get(
  '/access',
  wrap(async (req, res) => res.json(await access.diagnose({ skipPublic: req.query.local === '1' })))
);

/** Открыть порт панели в брандмауэре Windows. */
router.post('/access/firewall', wrap(async (req, res) => res.json(await access.openPort())));

/**
 * Открыть панель наружу одним действием: адрес прослушивания, брандмауэр,
 * ключи. Без перезапуска панели.
 */
router.post(
  '/access/expose',
  wrap(async (req, res) => {
    const result = await access.expose({ host: (req.body || {}).host });

    // Ответ уходит первым и с Connection: close — иначе слушатель нельзя
    // закрыть: он будет ждать, пока освободится это самое соединение.
    res.setHeader('Connection', 'close');
    res.json(result);

    if (result.rebindPending) {
      res.on('finish', () => {
        access.rebind(result.host, result.previousHost).catch((err) =>
          logger.error('panel', `Переезд панели не удался: ${err.message}`)
        );
      });
    }
  })
);

router.post('/auth/login', (req, res) => {
  const result = auth.login(req, (req.body || {}).key);
  if (!result.ok) return res.status(result.status || 401).json({ error: result.error });

  res.setHeader('Set-Cookie', auth.cookieHeader(result.token, result.expiresAt));
  res.json({ ok: true, keyIndex: result.keyIndex, expiresAt: result.expiresAt });
});

router.post('/auth/logout', (req, res) => {
  auth.destroySession(req);
  res.setHeader('Set-Cookie', auth.clearCookieHeader());
  res.json({ ok: true });
});

/** Ключи текущего запуска — чтобы передать второй ключ коллеге. */
router.get('/auth/keys', (req, res) => res.json({ keys: auth.listKeys(), issuedAt: auth.status(req).keysIssuedAt }));

/** Выпустить новые ключи, не перезапуская панель. Открытые сессии остаются. */
router.post('/auth/rotate', (req, res) => {
  auth.generate('запрос из панели');
  auth.announce();
  res.json({ keys: auth.listKeys() });
});

/** Кто сейчас в панели. */
router.get('/auth/sessions', (req, res) => {
  const current = auth.sessionOf(req);
  res.json({
    sessions: auth.listSessions().map((s) => ({ ...s, current: current ? current.token.slice(0, 8) === s.id : false }))
  });
});

router.delete('/auth/sessions/:id', (req, res) => res.json({ closed: auth.revoke(req.params.id) }));

router.get(
  '/status',
  wrap(async (req, res) => {
    const cfg = config.load();
    const active = config.activeServer();

    res.json({
      hasServers: cfg.servers.length > 0,
      activeServerId: cfg.activeServerId,
      servers: serversOverview(),
      statuses: serverProcess.allStatuses(),
      server: active ? serverProcess.getStatus(active.id) : null,
      problems: active
        ? [
            ...serverProcess.validate(active.id),
            ...scheduler.warnings(active.id),
            ...announcer.warnings(active.id)
          ]
        : [],
      restart: active ? scheduler.state(active.id) : null,
      restarts: scheduler.allStates(),
      announcements: announcer.allStates(),
      steamcmd: steamcmd.health(),
      jobs: jobs.active(),
      panel: {
        version: require('../../package.json').version,
        platform: process.platform,
        node: process.version,
        isWindows: process.platform === 'win32'
      }
    });
  })
);

/** Краткая сводка по каждому серверу — для экрана со списком. */
function serversOverview() {
  return config.servers().map((s) => {
    const status = serverProcess.getStatus(s.id);
    return {
      id: s.id,
      name: s.name,
      installed: s.installed,
      createdAt: s.createdAt,
      serverPath: s.paths.serverPath,
      gamePort: s.server.gamePort,
      steamQueryPort: s.server.steamQueryPort,
      maxPlayers: s.server.maxPlayers,
      mission: s.server.mission,
      hasPassword: Boolean(s.server.password),
      modsTotal: s.mods.length,
      modsEnabled: s.mods.filter((m) => m.enabled).length,
      status: status.status,
      uptimeSec: status.uptimeSec,
      lastError: status.lastError,
      lastCrashReport: status.lastCrashReport,
      restart: scheduler.state(s.id)
    };
  });
}

/* ------------------------------------------------------------------ серверы */

router.get('/servers', (req, res) => {
  res.json({ servers: serversOverview(), activeServerId: config.load().activeServerId });
});

router.get('/servers/suggest', (req, res) => {
  const ports = instances.suggestPorts();
  res.json({
    ...ports,
    serverPath: instances.suggestPath(req.query.name || 'DayZServer'),
    missions: missions.catalogue()
  });
});

/** Создать сервер и сразу запустить установку файлов через SteamCMD. */
router.post(
  '/servers',
  wrap(async (req, res) => {
    const input = req.body || {};
    const server = instances.create(input);

    if (input.install === false) {
      return res.json({ server, job: null, servers: serversOverview() });
    }

    const job = jobs.run(
      {
        type: 'install-server',
        title: `Установка сервера «${server.name}»`,
        serverId: server.id,
        onCancel: () => steamcmd.cancel()
      },
      async (j) =>
        config.withServer(server.id, () =>
          instances.install(server.id, {
            onProgress: (p) => jobs.update(j.id, { progress: p.percent ?? undefined, step: p.step })
          })
        )
    );

    res.json({ server, job, servers: serversOverview() });
  })
);

/** Переустановить/дозакачать файлы сервера. */
router.post(
  '/servers/:id/install',
  wrap(async (req, res) => {
    const server = config.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Сервер не найден' });

    const job = jobs.run(
      {
        type: 'install-server',
        title: `Обновление файлов сервера «${server.name}»`,
        serverId: server.id,
        onCancel: () => steamcmd.cancel()
      },
      async (j) =>
        config.withServer(server.id, () =>
          instances.install(server.id, {
            validate: req.body && req.body.validate !== false,
            onProgress: (p) => jobs.update(j.id, { progress: p.percent ?? undefined, step: p.step })
          })
        )
    );

    res.json({ job });
  })
);

router.post(
  '/servers/:id/activate',
  wrap(async (req, res) => {
    config.setActive(req.params.id);
    res.json({ activeServerId: req.params.id, servers: serversOverview() });
  })
);

router.patch(
  '/servers/:id',
  wrap(async (req, res) => {
    const patch = { ...(req.body || {}) };
    delete patch.id;
    delete patch.mods;

    // Пустой пароль RCon означает «не менять» — как пароль Steam и секрет CFTools.
    if (patch.ingame && patch.ingame.battleye) {
      if (!patch.ingame.battleye.password) delete patch.ingame.battleye.password;
      delete patch.ingame.battleye.hasPassword;
    }

    const updated = config.updateServer(req.params.id, patch);

    // Настройки подключения могли измениться — пробуем связаться заново.
    if (patch.ingame) {
      battleye.resetBlocked(req.params.id);
      ingame.resetFailures(req.params.id);
    }
    // Название сервера в конфиге DayZ следует за названием в панели.
    if (patch.name && (!patch.server || patch.server.name === undefined)) {
      config.updateServer(req.params.id, { server: { name: patch.name } });
    }
    logger.info('panel', `Настройки сервера «${updated.name}» сохранены`);
    res.json({ server: config.getServer(req.params.id), servers: serversOverview() });
  })
);

router.delete(
  '/servers/:id',
  wrap(async (req, res) => {
    if (serverProcess.isRunning(req.params.id)) {
      return res.status(409).json({ error: 'Сначала остановите сервер' });
    }
    instances.remove(req.params.id, { deleteFiles: req.query.deleteFiles === '1' });
    res.json({ servers: serversOverview(), activeServerId: config.load().activeServerId });
  })
);

/* ----------------------------------------------------------------- конфиг */

router.get('/config', (req, res) => {
  res.json(config.publicView());
});

/** Глобальные настройки: панель, SteamCMD, аккаунт Steam. */
router.put(
  '/config',
  wrap(async (req, res) => {
    const patch = { ...(req.body || {}) };

    // Пустая строка секрета означает «не менять», а не «стереть».
    if (patch.steam && patch.steam.password === '') delete patch.steam.password;
    if (patch.steam && patch.steam.webApiKey === '') delete patch.steam.webApiKey;
    if (patch.cftools && patch.cftools.secret === '') delete patch.cftools.secret;
    delete patch.servers;
    delete patch.activeServerId;

    const before = config.load();
    if (patch.paths && patch.paths.steamcmdExe && patch.paths.steamcmdExe !== before.paths.steamcmdExe) {
      // Путь к workshop пересчитываем, если пользователь не задавал его вручную.
      if (!patch.paths.workshopContentDir && before.paths.workshopContentDir === config.deriveWorkshopDir(before)) {
        patch.paths.workshopContentDir = '';
      }
    }

    const next = config.updateRoot(patch);
    // Ключи приложения могли измениться — прежний токен CFTools больше не нужен.
    if (patch.cftools) cftools.resetToken();
    logger.setMaxLines(next.panel.logBufferLines);
    logger.info('panel', 'Общие настройки сохранены');
    res.json(config.publicView());
  })
);

/* -------------------------------------------------------------------- моды */

router.get(
  '/mods',
  wrap(async (req, res) => {
    res.json(mods.list());
  })
);

/** Поиск в Workshop по названию или ID/ссылке. */
router.get(
  '/workshop/search',
  wrap(async (req, res) => {
    const query = String(req.query.q || '').trim();
    const page = parseInt(req.query.page, 10) || 1;
    res.json(await workshop.search(query, { page }));
  })
);

/** Кнопка «Загрузить» в окне подписки: скачивание выбранных модов. */
router.post(
  '/mods/download',
  wrap(async (req, res) => {
    const items = (req.body || {}).items || [];
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Не выбрано ни одного мода' });
    }
    const stopServer = Boolean((req.body || {}).stopServer);
    const serverId = serverIdOf(req);
    const server = config.getServer(serverId);

    const job = jobs.run(
      {
        type: 'download-mods',
        title: `Загрузка модов (${items.length}) для «${server.name}»`,
        serverId,
        total: items.length,
        onCancel: () => steamcmd.cancel()
      },
      async (j) =>
        config.withServer(serverId, () =>
          mods.downloadMany(items, {
            stopServer,
            onProgress: (p) => jobs.update(j.id, { progress: p.percent, step: p.step })
          })
        )
    );

    res.json({ job });
  })
);

router.post(
  '/mods/adopt',
  wrap(async (req, res) => {
    const { id, type } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Не указан Workshop ID' });
    const mod = mods.adoptExisting(id, { type });
    res.json({ mod, ...mods.list() });
  })
);

/** Подключить мод из собственной папки (локальный, чаще всего серверный). */
router.post(
  '/mods/local',
  wrap(async (req, res) => {
    const body = req.body || {};
    if (!body.path) return res.status(400).json({ error: 'Укажите путь к папке мода' });

    const serverId = serverIdOf(req);
    let created;

    const mod = await config.withServer(serverId, async () => {
      try {
        created = mods.addLocal({
          path: body.path,
          name: body.name,
          type: body.type,
          folder: body.folder
        });
      } catch (err) {
        err.status = 400; // некорректный путь — это ошибка ввода, а не сбой панели
        throw err;
      }
      // Если папка лежит вне каталога сервера — сразу переносим её на место.
      try {
        await mods.deploy(created);
      } catch (err) {
        logger.warn('mods', `Локальный мод добавлен, но не разложен: ${err.message}`);
      }
      return created;
    });

    res.json({ mod, ...mods.list() });
  })
);

router.post(
  '/mods/reorder',
  wrap(async (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'Ожидался массив ids' });
    mods.reorder(ids);
    res.json(mods.list());
  })
);

router.post(
  '/mods/update',
  wrap(async (req, res) => {
    const serverId = serverIdOf(req);
    const job = jobs.run(
      {
        type: 'update-mods',
        title: 'Проверка обновлений модов',
        serverId,
        onCancel: () => steamcmd.cancel()
      },
      async (j) =>
        config.withServer(serverId, () =>
          mods.checkAndUpdate({
            stopServer: Boolean((req.body || {}).stopServer),
            onProgress: (p) => jobs.update(j.id, { progress: p.percent, step: p.step })
          })
        )
    );
    res.json({ job });
  })
);

/** Перекачать один мод целиком (для модов, установленных переносом). */
router.post(
  '/mods/:id/force-update',
  wrap(async (req, res) => {
    const serverId = serverIdOf(req);
    const server = config.getServer(serverId);
    const mod = config.active(serverId).mods.find((m) => m.id === req.params.id);
    if (!mod) return res.status(404).json({ error: 'Мод не найден' });

    const job = jobs.run(
      {
        type: 'download-mods',
        title: `Перезагрузка «${mod.name}» для «${server.name}»`,
        serverId,
        onCancel: () => steamcmd.cancel()
      },
      async (j) =>
        config.withServer(serverId, () =>
          mods.forceUpdate(mod.id, {
            stopServer: Boolean((req.body || {}).stopServer),
            onProgress: (p) => jobs.update(j.id, { progress: p.percent, step: p.step })
          })
        )
    );

    res.json({ job });
  })
);

router.post(
  '/mods/deploy',
  wrap(async (req, res) => {
    const serverId = serverIdOf(req);
    const body = req.body || {};
    const report = await config.withServer(serverId, () =>
      mods.deployAll(body.ids || null, { stopServer: Boolean(body.stopServer) })
    );
    res.json({ report, ...mods.list() });
  })
);

router.patch(
  '/mods/:id',
  wrap(async (req, res) => {
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) mods.setEnabled(req.params.id, body.enabled);

    const allowed = {};
    for (const key of ['name', 'folder', 'type']) if (body[key] !== undefined) allowed[key] = body[key];
    if (Object.keys(allowed).length) mods.patch(req.params.id, allowed);

    res.json(mods.list());
  })
);

/** Что будет удалено вместе с модом — для диалога подтверждения. */
router.get('/mods/:id/removal-info', wrap(async (req, res) => res.json(mods.removalInfo(req.params.id))));

router.delete(
  '/mods/:id',
  wrap(async (req, res) => {
    const report = mods.remove(req.params.id, {
      deleteServerFolder: req.query.deleteFiles === '1',
      // Полное удаление: файлы в steamapps/workshop/content и запись о версии.
      deleteWorkshop: req.query.deleteWorkshop === '1',
      deleteKeys: req.query.deleteKeys === '1',
      force: req.query.force === '1'
    });
    res.json({ report, ...mods.list() });
  })
);

/** Удалить из репозитория SteamCMD мод, не подключённый ни к одному серверу. */
router.delete(
  '/mods/workshop/:id',
  wrap(async (req, res) => {
    const result = mods.removeWorkshopItem(req.params.id, { force: req.query.force === '1' });
    res.json({ result, ...mods.list() });
  })
);

/* -------------------------------------------------------------------- .bat */

router.get('/bat', wrap(async (req, res) => res.json(batgen.preview(config.active(serverIdOf(req))))));

router.post('/bat', wrap(async (req, res) => res.json(batgen.generate(config.active(serverIdOf(req))))));

/* --------------------------------------------------------------- брандмауэр */

router.get('/firewall', wrap(async (req, res) => res.json(await firewall.status())));

router.post(
  '/firewall/apply',
  wrap(async (req, res) => res.json(await firewall.apply({ force: (req.body || {}).force === true })))
);

router.post('/firewall/bat', (req, res) => res.json(firewall.generateBat()));

router.delete('/firewall', wrap(async (req, res) => res.json(await firewall.removeAll())));

/* ------------------------------------------------------------- serverDZ.cfg */

router.get('/servercfg', wrap(async (req, res) => res.json(serverCfg.read(serverIdOf(req)))));

router.put(
  '/servercfg',
  wrap(async (req, res) => {
    const content = (req.body || {}).content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'Ожидалось поле content' });
    res.json(serverCfg.write(content, serverIdOf(req)));
  })
);

router.post('/servercfg/sync', wrap(async (req, res) => res.json(serverCfg.sync(serverIdOf(req)))));

/* ------------------------------------------------------------------- карты */

/** Список миссий (карт) из mpmissions выбранного сервера. */
router.get('/missions', wrap(async (req, res) => res.json(missions.list(serverIdOf(req)))));

/** Выбрать карту: правит настройки сервера и serverDZ.cfg. */
router.post(
  '/missions/select',
  wrap(async (req, res) => {
    const body = req.body || {};
    const result = missions.select(serverIdOf(req), body.mission, { force: body.force === true });
    res.json({ ...result, ...missions.list(serverIdOf(req)) });
  })
);

/* ------------------------------------------------------------------- сервер */

router.post(
  '/server/start',
  wrap(async (req, res) => {
    const serverId = serverIdOf(req);
    const server = config.getServer(serverId);

    const job = jobs.run(
      { type: 'start-server', title: `Запуск сервера «${server.name}»`, serverId },
      async (j) =>
        config.withServer(serverId, () =>
          serverProcess.start(serverId, {
            skipUpdate: (req.body || {}).skipUpdate === true,
            onProgress: (p) => jobs.update(j.id, { progress: p.percent, step: p.step })
          })
        )
    );

    res.json({ job });
  })
);

router.post(
  '/server/stop',
  wrap(async (req, res) => res.json(await serverProcess.stop(serverIdOf(req), { force: (req.body || {}).force !== false })))
);

router.post(
  '/server/restart',
  wrap(async (req, res) => {
    const serverId = serverIdOf(req);
    const server = config.getServer(serverId);

    const job = jobs.run(
      { type: 'restart-server', title: `Перезапуск сервера «${server.name}»`, serverId },
      async (j) =>
        config.withServer(serverId, () =>
          serverProcess.restart(serverId, {
            skipUpdate: (req.body || {}).skipUpdate === true,
            onProgress: (p) => jobs.update(j.id, { progress: p.percent, step: p.step })
          })
        )
    );

    res.json({ job });
  })
);

/* ------------------------------------------- мост с серверным модом */

/*
 * Обмен с модом @DayZPanelBridge идёт файлами в папке профиля; протокол описан
 * в docs/bridge-mod-prompt.md. Пока мод не установлен, все эти маршруты честно
 * отвечают, что моста нет.
 */

router.get('/bridge', (req, res) => res.json(bridge.status(serverIdOf(req))));

/** Создать папку обмена заранее — до первого запуска мода. */
router.post('/bridge/prepare', wrap(async (req, res) => res.json(bridge.prepare(serverIdOf(req)))));

/** Игроки онлайн с координатами — основа интерактивной карты. */
router.get('/bridge/players', (req, res) => {
  const serverId = serverIdOf(req);
  res.json({ ...bridge.players(serverId), status: bridge.status(serverId) });
});

/** Где игрок был: трасса перемещений по снимкам состояния. */
router.get('/bridge/players/:id/trail', (req, res) =>
  res.json(bridge.trail(serverIdOf(req), req.params.id, parseInt(req.query.minutes, 10) || 30))
);

/** Трассы всех, кто онлайн. */
router.get('/bridge/trails', (req, res) =>
  res.json(bridge.allTrails(serverIdOf(req), parseInt(req.query.minutes, 10) || 15))
);

/** Инвентарь игрока: запрос уходит моду и ждёт ответа. */
router.get(
  '/bridge/players/:id/inventory',
  wrap(async (req, res) => res.json(await bridge.inventory(serverIdOf(req), req.params.id)))
);

/** Действие над игроком или миром: message, kick, teleport, heal, set_stat, … */
router.post(
  '/bridge/command',
  wrap(async (req, res) => {
    const body = req.body || {};
    const result = await bridge.command(serverIdOf(req), body.action, body.args || {});
    res.json({ ok: true, action: body.action, result });
  })
);

/* --------------------------------------------------------- журнал событий */

/**
 * Лента событий. Фильтры: types (через запятую), playerId, search, before/since,
 * days — насколько глубоко смотреть историю в файлах.
 */
router.get('/events', (req, res) => {
  const serverId = serverIdOf(req);
  res.json({
    ...eventlog.list(serverId, req.query),
    online: bridge.status(serverId).online
  });
});

/** Сводка по типам событий за последние часы. */
router.get('/events/summary', (req, res) =>
  res.json(eventlog.summary(serverIdOf(req), parseInt(req.query.hours, 10) || 24))
);

/** Файлы истории событий по дням. */
router.get('/events/files', (req, res) => res.json({ files: eventlog.files(serverIdOf(req)) }));

/* ------------------------------------------------- сообщения в игру */

/** Каким каналом панель пишет игрокам и готов ли он. */
router.get('/ingame', (req, res) => {
  const serverId = serverIdOf(req);
  const v = config.active(serverId);

  res.json({
    channel: v.ingame.channel,
    delivery: ingame.available(serverId),
    battleye: battleye.status(serverId),
    cftools: cftools.status(serverId)
  });
});

/** Отправить произвольный текст игрокам — кнопка проверки канала. */
router.post(
  '/ingame/say',
  wrap(async (req, res) => {
    const result = await ingame.say(serverIdOf(req), (req.body || {}).text, {
      label: 'проверка канала',
      quiet: true
    });
    if (!result.sent) return res.status(400).json({ error: `Не отправлено: ${result.reason}` });
    res.json(result);
  })
);

/* ------------------------------------------------------ BattlEye RCon */

router.get('/battleye', (req, res) => res.json(battleye.status(serverIdOf(req))));

/** Вход по паролю RCon и запрос списка игроков — проверка связи. */
router.post('/battleye/test', wrap(async (req, res) => res.json(await battleye.test(serverIdOf(req)))));

/** Создать battleye\beserver_x64.cfg с паролем RCon. */
router.post(
  '/battleye/setup',
  wrap(async (req, res) => {
    const body = req.body || {};
    const result = battleye.setupConfig(serverIdOf(req), {
      force: body.force === true,
      password: body.password,
      port: body.port
    });
    res.json({ ...result, status: battleye.status(serverIdOf(req)) });
  })
);

/** Игроки онлайн по данным BattlEye — работает без CFTools. */
router.get('/battleye/players', wrap(async (req, res) => res.json(await battleye.players(serverIdOf(req)))));

/** Произвольная RCon-команда (`#shutdown`, `kick 0 …`, `players`). */
router.post(
  '/battleye/command',
  wrap(async (req, res) => {
    const line = String((req.body || {}).command || '').trim();
    if (!line) return res.status(400).json({ error: 'Не указана команда' });

    const output = await battleye.command(serverIdOf(req), line);
    logger.warn('panel', `Выполнена RCon-команда BattlEye: ${line}`);
    res.json({ output });
  })
);

/* ------------------------------------------------------- объявления в чат */

/** Список объявлений, расписание отправки и готовность канала доставки. */
router.get('/announcements', (req, res) => {
  const serverId = serverIdOf(req);
  const v = config.active(serverId);

  res.json({
    ...v.announcements,
    state: announcer.state(serverId),
    delivery: ingame.available(serverId),
    maxLength: ingame.available(serverId).maxLength,
    warnings: announcer.warnings(serverId)
  });
});

/** Отправить объявление сейчас: по номеру из списка или произвольный текст. */
router.post(
  '/announcements/send',
  wrap(async (req, res) => {
    const body = req.body || {};
    const result = await announcer.sendNow(serverIdOf(req), { index: body.index, text: body.text });
    res.json({ ...result, state: announcer.state(serverIdOf(req)) });
  })
);

/** Предпросмотр подстановок ({server}, {map}, {restart}) без отправки. */
router.post('/announcements/preview', (req, res) => {
  const serverId = serverIdOf(req);
  const texts = Array.isArray((req.body || {}).texts) ? req.body.texts : [];
  const limit = ingame.available(serverId).maxLength;

  res.json({
    maxLength: limit,
    preview: texts.map((text) => {
      const rendered = ingame.render(text, serverId);
      return { text: rendered, length: rendered.length, tooLong: rendered.length > limit };
    })
  });
});

/* ---------------------------------------------------------------- CFTools */

/*
 * Все маршруты работают только когда интеграция включена и заполнены ключи —
 * проверку делает сам сервис и объясняет, чего именно не хватает.
 */

router.get('/cftools/status', (req, res) => res.json(cftools.status(serverIdOf(req))));

router.post('/cftools/test', wrap(async (req, res) => res.json(await cftools.test(serverIdOf(req)))));

router.get('/cftools/grants', wrap(async (req, res) => res.json(await cftools.grants())));

router.get('/cftools/server', wrap(async (req, res) => res.json(await cftools.serverInfo(serverIdOf(req)))));

router.get(
  '/cftools/players',
  wrap(async (req, res) => res.json({ players: await cftools.players(serverIdOf(req)) }))
);

router.get(
  '/cftools/player',
  wrap(async (req, res) => res.json(await cftools.playerStats(serverIdOf(req), req.query.cftoolsId)))
);

router.get('/cftools/lookup', wrap(async (req, res) => res.json(await cftools.lookup(req.query.identifier))));

router.post(
  '/cftools/kick',
  wrap(async (req, res) => {
    const body = req.body || {};
    res.json(await cftools.kick(serverIdOf(req), body.sessionId, body.reason));
  })
);

router.post(
  '/cftools/message',
  wrap(async (req, res) => {
    const body = req.body || {};
    res.json(await cftools.messagePrivate(serverIdOf(req), body.sessionId, body.content));
  })
);

router.post(
  '/cftools/broadcast',
  wrap(async (req, res) => res.json(await cftools.broadcast(serverIdOf(req), (req.body || {}).content)))
);

router.post(
  '/cftools/rcon',
  wrap(async (req, res) => res.json(await cftools.rcon(serverIdOf(req), (req.body || {}).command)))
);

router.get(
  '/cftools/bans',
  wrap(async (req, res) => res.json({ bans: await cftools.listBans(serverIdOf(req), req.query.filter) }))
);

router.post(
  '/cftools/bans',
  wrap(async (req, res) => res.json(await cftools.createBan(serverIdOf(req), req.body || {})))
);

router.delete(
  '/cftools/bans/:banId',
  wrap(async (req, res) => res.json(await cftools.deleteBan(serverIdOf(req), req.params.banId)))
);

/* ----------------------------------------------------------------- задачи */

router.get('/jobs', (req, res) => res.json(jobs.list()));

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  res.json(job);
});

router.post('/jobs/:id/cancel', (req, res) => res.json({ cancelled: jobs.cancel(req.params.id) }));

/* ----------------------------------------------------------------- SteamCMD */

router.post('/steamcmd/cancel', (req, res) => res.json({ cancelled: steamcmd.cancel() }));

/* -------------------------------------------------------------- диагностика */

router.get('/diagnostics', (req, res) => res.json({ reports: diagnostics.listReports() }));

/** Собрать отчёт и сохранить его в корень папки панели. */
router.post(
  '/diagnostics',
  wrap(async (req, res) => {
    const report = diagnostics.writeReport({ statuses: serverProcess.allStatuses() });
    res.json({ ...report, reports: diagnostics.listReports() });
  })
);

router.get(
  '/diagnostics/:name',
  wrap(async (req, res) => {
    const report = diagnostics.readReport(req.params.name);
    if (req.query.download === '1') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${report.name}"`);
      return res.send(report.content);
    }
    res.json(report);
  })
);

router.delete(
  '/diagnostics/:name',
  wrap(async (req, res) => {
    diagnostics.removeReport(req.params.name);
    res.json({ reports: diagnostics.listReports() });
  })
);

/* --------------------------------------------------------------------- логи */

router.get('/logs', (req, res) => {
  const since = parseInt(req.query.since, 10);
  res.json(Number.isFinite(since) ? logger.since(since) : logger.tail(600));
});

router.delete('/logs', (req, res) => {
  logger.clear();
  res.json({ ok: true });
});

/** Единый живой поток: лог, статусы серверов, прогресс задач. */
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const since = parseInt(req.query.since, 10);
  send('backlog', Number.isFinite(since) ? logger.since(since) : logger.tail(400));
  send('statuses', serverProcess.allStatuses());
  jobs.active().forEach((job) => send('job', job));

  send('restarts', scheduler.allStates());
  send('announcements', announcer.allStates());

  const activeServer = config.activeServer();
  if (activeServer) {
    send('bridge-status', { serverId: activeServer.id, ...bridge.status(activeServer.id) });
    send('bridge-players', { serverId: activeServer.id, ...bridge.players(activeServer.id) });
  }

  const offLog = logger.subscribe((entry) => send('log', entry));
  const onStatus = (status) => send('status', status);
  const onJob = (job) => send('job', job);
  const onServers = () => send('servers', serversOverview());
  const onPlan = (plan) => send('restart-plan', plan);
  const onWarning = (warning) => send('restart-warning', warning);
  const onAnnouncements = (states) => send('announcements', states);
  const onAnnouncement = (a) => send('announcement', a);
  const onBridgeStatus = (s) => send('bridge-status', s);
  const onBridgePlayers = (p) => send('bridge-players', p);
  const onBridgeEvents = (e) => send('bridge-events', e);

  bus.on('status', onStatus);
  bus.on('job', onJob);
  bus.on('servers', onServers);
  bus.on('restart-plan', onPlan);
  bus.on('restart-warning', onWarning);
  bus.on('announcements', onAnnouncements);
  bus.on('announcement', onAnnouncement);
  bus.on('bridge-status', onBridgeStatus);
  bus.on('bridge-players', onBridgePlayers);
  bus.on('bridge-events', onBridgeEvents);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    offLog();
    bus.off('status', onStatus);
    bus.off('job', onJob);
    bus.off('servers', onServers);
    bus.off('restart-plan', onPlan);
    bus.off('restart-warning', onWarning);
    bus.off('announcements', onAnnouncements);
    bus.off('announcement', onAnnouncement);
    bus.off('bridge-status', onBridgeStatus);
    bus.off('bridge-players', onBridgePlayers);
    bus.off('bridge-events', onBridgeEvents);
  });
});

/* --------------------------------------------------------- обработка ошибок */

router.use((err, req, res, _next) => {
  logger.error('panel', `${req.method} ${req.originalUrl}: ${err.message}`);
  res.status(err.status || 500).json({ error: err.message });
});

module.exports = router;
