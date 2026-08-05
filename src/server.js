'use strict';

/**
 * Точка входа панели: поднимает Express, раздаёт статику из public/
 * и подключает API из src/routes/api.js.
 *
 * По умолчанию слушает 127.0.0.1 — панель доступна только с этой машины.
 * Если нужен доступ по локальной сети, поменяйте panel.host на 0.0.0.0
 * в config/config.json, понимая, что панель не имеет авторизации.
 */

const path = require('path');
const express = require('express');

const config = require('./config');
const logger = require('./logger');
const api = require('./routes/api');
const serverProcess = require('./services/serverProcess');
const diagnostics = require('./services/diagnostics');
const scheduler = require('./services/scheduler');

const cfg = config.load();
logger.setMaxLines(cfg.panel.logBufferLines);

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use('/api', api);

app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    maxAge: 0
  })
);

app.use((req, res) => res.status(404).json({ error: `Не найдено: ${req.method} ${req.originalUrl}` }));

const host = cfg.panel.host || '127.0.0.1';
const port = cfg.panel.port || 8787;

const httpServer = app.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  logger.info('panel', '═'.repeat(60));
  logger.info('panel', `DayZ Panel запущена: http://${shown}:${port}`);
  logger.info('panel', `Платформа: ${process.platform}, Node ${process.version}`);
  logger.info('panel', `Конфиг:    ${config.CONFIG_FILE}`);
  logger.info('panel', `Логи:      ${logger.currentFile()}`);
  logger.info('panel', `Отчёты:    ${diagnostics.ROOT}\\diagnostic-report-*.txt`);

  if (host === '0.0.0.0') {
    logger.warn('panel', 'Панель слушает все интерфейсы и не имеет пароля — не выставляйте её в интернет');
  }
  if (process.platform !== 'win32') {
    logger.warn('panel', 'Панель запущена не в Windows: netsh и запуск DayZServer_x64.exe работать не будут');
  }

  const servers = config.servers();
  if (!servers.length) {
    logger.info('panel', 'Серверов пока нет — нажмите «Создать сервер» в панели');
  } else {
    for (const server of servers) {
      const problems = serverProcess.validate(server.id);
      if (problems.length) logger.warn('panel', `«${server.name}»: ${problems.join('; ')}`);
      else logger.info('panel', `«${server.name}»: готов к запуску (порт ${server.server.gamePort})`);
    }
  }
  scheduler.start();
  logger.info('panel', '═'.repeat(60));
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('panel', `Порт ${port} занят. Измените panel.port в config/config.json`);
  } else {
    logger.error('panel', `Ошибка HTTP-сервера: ${err.message}`);
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('panel', `Получен ${signal}, завершаю работу…`);
  scheduler.stop();
  await serverProcess.shutdown();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error('panel', `Необработанная ошибка: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error('panel', `Необработанный rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

module.exports = app;
