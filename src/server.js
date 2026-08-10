'use strict';

/**
 * Точка входа панели: поднимает Express, раздаёт статику из public/
 * и подключает API из src/routes/api.js.
 *
 * По умолчанию слушает 127.0.0.1 — панель доступна только с этой машины.
 * Если нужен доступ по локальной сети, поменяйте panel.host на 0.0.0.0
 * в config/config.json, понимая, что панель не имеет авторизации.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const express = require('express');

const config = require('./config');
const logger = require('./logger');
const api = require('./routes/api');
const serverProcess = require('./services/serverProcess');
const diagnostics = require('./services/diagnostics');
const scheduler = require('./services/scheduler');
const announcer = require('./services/announcer');
const bridge = require('./services/bridge');
const adminlog = require('./services/adminlog');
const roster = require('./services/roster');
const auth = require('./services/auth');
const firewall = require('./services/firewall');
const access = require('./services/access');

const cfg = config.load();
logger.setMaxLines(cfg.panel.logBufferLines);

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

// Вход по мастер-ключам. Стоит раньше API и статики: до входа наружу отдаются
// только страница входа и сама проверка ключа.
auth.start();
app.use(auth.middleware());

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

/**
 * HTTPS, если в настройках указаны сертификат и ключ.
 *
 * Панель, открытая наружу по http://, отдаёт мастер-ключ и все данные открытым
 * текстом. Поэтому либо reverse-proxy с сертификатом, либо этот путь.
 */
const tls = auth.tls();
let httpServer;

if (tls.enabled) {
  try {
    httpServer = https.createServer(
      { cert: fs.readFileSync(tls.certFile), key: fs.readFileSync(tls.keyFile) },
      app
    );
  } catch (err) {
    logger.error('panel', `Не удалось прочитать сертификат (${err.message}) — панель поднимается по HTTP`);
    httpServer = http.createServer(app);
  }
} else {
  httpServer = http.createServer(app);
}

httpServer.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  const scheme = tls.enabled && httpServer instanceof https.Server ? 'https' : 'http';

  logger.info('panel', '═'.repeat(60));
  logger.info('panel', `DayZ Panel запущена: ${scheme}://${shown}:${port}`);
  logger.info('panel', `Платформа: ${process.platform}, Node ${process.version}`);
  logger.info('panel', `Конфиг:    ${config.CONFIG_FILE}`);
  logger.info('panel', `Логи:      ${logger.currentFile()}`);
  logger.info('panel', `Отчёты:    ${diagnostics.ROOT}\\diagnostic-report-*.txt`);

  /*
   * Панель смотрит в сеть — значит нужно, чтобы Windows пускала входящие на её
   * порт. Про это правило легко забыть, и получается «панель работает, а снаружи
   * недоступна». Открываем сами; если прав администратора нет — прямо говорим,
   * что делать.
   */
  if (host !== '127.0.0.1' && host !== 'localhost' && cfg.panel.autoFirewall !== false) {
    firewall
      .applyPanel()
      .then((result) => {
        if (result.created || result.existed) {
          const addresses = access.localAddresses().map((a) => `${scheme}://${a.address}:${port}`);
          if (addresses.length) logger.info('panel', `Адреса для входа: ${addresses.join(', ')}`);
        } else if (result.supported) {
          logger.warn(
            'panel',
            `Порт ${port} не открыт в брандмауэре: ${result.error || 'нет прав'}. ` +
              'Запустите панель от имени администратора или нажмите «Открыть порт панели» ' +
              'в настройках — она сохранит .bat для запуска с правами администратора.'
          );
        }
      })
      .catch((err) => logger.warn('panel', `Проверка брандмауэра не удалась: ${err.message}`));
  }

  const authSettings = auth.settings();
  if (host !== '127.0.0.1' && !authSettings.enabled) {
    logger.warn(
      'panel',
      'Панель слушает сеть, а вход по мастер-ключам выключен — любой, кто знает адрес, получит полный доступ'
    );
  } else if (authSettings.enabled) {
    logger.info('panel', 'Вход в панель: по мастер-ключу (ключи напечатаны выше)');
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
  announcer.start();
  bridge.start();
  adminlog.start();
  roster.start();
  logger.info('panel', '═'.repeat(60));
});

/**
 * Переезд на другой адрес прослушивания без перезапуска панели.
 *
 * Иначе «открыть панель наружу» превращается в квест: поправь конфиг, закрой
 * окно, запусти заново, не забудь про брандмауэр. Сокет закрывается и
 * открывается заново; уже установленные соединения (включая эту страницу)
 * доживают своё, а при неудаче панель возвращается на прежний адрес.
 */
let currentHost = host;

access.setRebinder(
  (newHost) =>
    new Promise((resolve) => {
      if (newHost === currentHost) return resolve({ ok: true, host: newHost, unchanged: true });

      const previous = currentHost;

      // Соединения в keep-alive не дают закрыть слушатель: без этого close()
      // ждёт их сам по себе минутами. SSE-поток браузер поднимет заново.
      if (httpServer.closeIdleConnections) httpServer.closeIdleConnections();
      const force = setTimeout(() => {
        if (httpServer.closeAllConnections) httpServer.closeAllConnections();
      }, 2000);
      force.unref();

      const onError = (err) => {
        httpServer.removeListener('error', onError);
        logger.error('panel', `Не удалось занять ${newHost}:${port} (${err.code || err.message}) — возвращаюсь на ${previous}`);
        httpServer.listen(port, previous, () => resolve({ ok: false, host: previous, error: err.code || err.message }));
      };

      httpServer.close(() => {
        clearTimeout(force);
        httpServer.once('error', onError);
        httpServer.listen(port, newHost, () => {
          httpServer.removeListener('error', onError);
          currentHost = newHost;
          logger.info('panel', `Панель теперь слушает ${newHost}:${port}`);
          resolve({ ok: true, host: newHost, previous });
        });
      });
    })
);

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('panel', `Порт ${port} занят. Измените panel.port в config/config.json`);
  } else if (err.code === 'EADDRNOTAVAIL') {
    // Самая частая ошибка при попытке открыть панель наружу: в panel.host
    // вписывают внешний («белый») адрес, которого у сетевой карты нет.
    const own = access.localAddresses().map((a) => a.address).join(', ') || 'не найдены';
    logger.error(
      'panel',
      `Адрес ${host} не принадлежит этой машине, слушать его нельзя. Адреса машины: ${own}. ` +
        'Чтобы панель была доступна из сети, поставьте panel.host = 0.0.0.0 — она примет подключения ' +
        'на всех адресах, включая внешний.'
    );
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
  announcer.stop();
  bridge.stop();
  adminlog.stop();
  roster.stop();
  auth.stop();
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
