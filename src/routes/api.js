'use strict';

/**
 * HTTP API панели. Только маршрутизация и валидация входных данных —
 * вся логика живёт в src/services/*.
 */

const express = require('express');

const config = require('../config');
const logger = require('../logger');
const steamcmd = require('../services/steamcmd');
const mods = require('../services/mods');
const batgen = require('../services/batgen');
const firewall = require('../services/firewall');
const serverCfg = require('../services/serverCfg');
const serverProcess = require('../services/serverProcess');

const router = express.Router();

/** Обёртка, чтобы не писать try/catch в каждом обработчике. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/* ------------------------------------------------------------------- статус */

router.get(
  '/status',
  wrap(async (req, res) => {
    const cfg = config.load();
    res.json({
      server: serverProcess.getStatus(),
      steamcmd: steamcmd.health(),
      problems: serverProcess.validate(cfg),
      panel: {
        version: require('../../package.json').version,
        platform: process.platform,
        node: process.version
      },
      counts: {
        mods: cfg.mods.length,
        enabled: cfg.mods.filter((m) => m.enabled).length
      }
    });
  })
);

/* ----------------------------------------------------------------- конфиг */

router.get('/config', (req, res) => {
  res.json(config.publicView());
});

router.put(
  '/config',
  wrap(async (req, res) => {
    const patch = req.body || {};

    // Пустая строка пароля означает «не менять», а не «стереть».
    if (patch.steam && patch.steam.password === '') delete patch.steam.password;
    delete patch.mods; // список модов меняется только через /mods/*

    const previousWorkshop = config.load().paths.workshopContentDir;
    const previousSteamcmd = config.load().paths.steamcmdExe;

    // Если поменяли steamcmd.exe, а путь к workshop не задавали руками —
    // пересчитываем его от нового расположения steamcmd.
    if (patch.paths && patch.paths.steamcmdExe && patch.paths.steamcmdExe !== previousSteamcmd) {
      const derivedOld = config.deriveWorkshopDir(config.load());
      if (!patch.paths.workshopContentDir && previousWorkshop === derivedOld) {
        patch.paths.workshopContentDir = '';
      }
    }

    const next = config.update(patch);
    logger.info('panel', 'Настройки сохранены');
    logger.setMaxLines(next.panel.logBufferLines);
    res.json(config.publicView());
  })
);

/* -------------------------------------------------------------------- моды */

router.get('/mods', (req, res) => {
  res.json(mods.list());
});

router.post(
  '/mods',
  wrap(async (req, res) => {
    const { id, type, validate } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Не указан Workshop ID' });
    const mod = await mods.addByWorkshopId(id, { type, validate });
    res.json({ mod, ...mods.list() });
  })
);

router.post(
  '/mods/adopt',
  wrap(async (req, res) => {
    const { id, type } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Не указан Workshop ID' });
    const mod = await mods.adoptExisting(id, { type });
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
    const report = await mods.checkAndUpdate();
    res.json({ report, ...mods.list() });
  })
);

router.post(
  '/mods/deploy',
  wrap(async (req, res) => {
    const ids = (req.body || {}).ids || null;
    const report = await mods.deployAll(ids);
    res.json({ report, ...mods.list() });
  })
);

router.patch(
  '/mods/:id',
  wrap(async (req, res) => {
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      mods.setEnabled(req.params.id, body.enabled);
    }
    const allowed = {};
    for (const key of ['name', 'folder', 'type']) {
      if (body[key] !== undefined) allowed[key] = body[key];
    }
    if (Object.keys(allowed).length) mods.patch(req.params.id, allowed);
    res.json(mods.list());
  })
);

router.delete(
  '/mods/:id',
  wrap(async (req, res) => {
    mods.remove(req.params.id, { deleteServerFolder: req.query.deleteFiles === '1' });
    res.json(mods.list());
  })
);

/* -------------------------------------------------------------------- .bat */

router.get('/bat', (req, res) => {
  res.json(batgen.preview());
});

router.post(
  '/bat',
  wrap(async (req, res) => {
    res.json(batgen.generate());
  })
);

/* --------------------------------------------------------------- брандмауэр */

router.get(
  '/firewall',
  wrap(async (req, res) => {
    res.json(await firewall.status());
  })
);

router.post(
  '/firewall/apply',
  wrap(async (req, res) => {
    res.json(await firewall.apply({ force: (req.body || {}).force === true }));
  })
);

router.post('/firewall/bat', (req, res) => {
  res.json(firewall.generateBat());
});

router.delete(
  '/firewall',
  wrap(async (req, res) => {
    res.json(await firewall.removeAll());
  })
);

/* ------------------------------------------------------------- serverDZ.cfg */

router.get('/servercfg', (req, res) => {
  res.json(serverCfg.read());
});

router.put(
  '/servercfg',
  wrap(async (req, res) => {
    const content = (req.body || {}).content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'Ожидалось поле content' });
    res.json(serverCfg.write(content));
  })
);

router.post(
  '/servercfg/sync',
  wrap(async (req, res) => {
    res.json(serverCfg.sync());
  })
);

/* ------------------------------------------------------------------- сервер */

router.post(
  '/server/start',
  wrap(async (req, res) => {
    const result = await serverProcess.start({ skipUpdate: (req.body || {}).skipUpdate === true });
    res.json(result);
  })
);

router.post(
  '/server/stop',
  wrap(async (req, res) => {
    res.json(await serverProcess.stop({ force: (req.body || {}).force !== false }));
  })
);

router.post(
  '/server/restart',
  wrap(async (req, res) => {
    res.json(await serverProcess.restart({ skipUpdate: (req.body || {}).skipUpdate === true }));
  })
);

/* ----------------------------------------------------------------- SteamCMD */

router.post(
  '/steamcmd/update-server',
  wrap(async (req, res) => {
    res.json(await steamcmd.updateServerApp());
  })
);

router.post('/steamcmd/cancel', (req, res) => {
  res.json({ cancelled: steamcmd.cancel() });
});

/* --------------------------------------------------------------------- логи */

router.get('/logs', (req, res) => {
  const since = parseInt(req.query.since, 10);
  res.json(Number.isFinite(since) ? logger.since(since) : logger.tail(500));
});

router.delete('/logs', (req, res) => {
  logger.clear();
  res.json({ ok: true });
});

/** Живой поток лога и статуса (Server-Sent Events). */
router.get('/logs/stream', (req, res) => {
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
  send('backlog', Number.isFinite(since) ? logger.since(since) : logger.tail(300));
  send('status', serverProcess.getStatus());

  const offLog = logger.subscribe((entry) => send('log', entry));
  const offStatus = serverProcess.onStatus((status) => send('status', status));
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    offLog();
    offStatus();
  });
});

/* --------------------------------------------------------- обработка ошибок */

router.use((err, req, res, _next) => {
  logger.error('panel', `${req.method} ${req.originalUrl}: ${err.message}`);
  res.status(err.status || 500).json({ error: err.message });
});

module.exports = router;
