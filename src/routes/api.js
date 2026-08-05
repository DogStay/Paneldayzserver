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
        ? [...serverProcess.validate(active.id), ...scheduler.warnings(active.id)]
        : [],
      restart: active ? scheduler.state(active.id) : null,
      restarts: scheduler.allStates(),
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

    const updated = config.updateServer(req.params.id, patch);
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

  const offLog = logger.subscribe((entry) => send('log', entry));
  const onStatus = (status) => send('status', status);
  const onJob = (job) => send('job', job);
  const onServers = () => send('servers', serversOverview());
  const onPlan = (plan) => send('restart-plan', plan);
  const onWarning = (warning) => send('restart-warning', warning);

  bus.on('status', onStatus);
  bus.on('job', onJob);
  bus.on('servers', onServers);
  bus.on('restart-plan', onPlan);
  bus.on('restart-warning', onWarning);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    offLog();
    bus.off('status', onStatus);
    bus.off('job', onJob);
    bus.off('servers', onServers);
    bus.off('restart-plan', onPlan);
    bus.off('restart-warning', onWarning);
  });
});

/* --------------------------------------------------------- обработка ошибок */

router.use((err, req, res, _next) => {
  logger.error('panel', `${req.method} ${req.originalUrl}: ${err.message}`);
  res.status(err.status || 500).json({ error: err.message });
});

module.exports = router;
