'use strict';

/**
 * «Почему панель не открывается снаружи» — проверка доступа по шагам.
 *
 * Между «панель работает» и «панель открылась с другого компьютера» стоят четыре
 * независимые вещи, и в любой из них может быть обрыв:
 *
 *   1. на каком адресе панель слушает (panel.host);
 *   2. пускает ли Windows входящее подключение на её порт (брандмауэр);
 *   3. доходит ли снаружи до этой машины (NAT роутера или фильтр хостера);
 *   4. знает ли тот, кто заходит, мастер-ключ.
 *
 * Модуль проверяет всё, что можно проверить с самой машины, и по каждому пункту
 * говорит: в порядке, не проверить или вот конкретное действие. Гадать
 * «наверное, порты» больше не нужно.
 */

const os = require('os');
const net = require('net');
const { execFile } = require('child_process');

const config = require('./../config');
const logger = require('../logger');
const firewall = require('./firewall');
const auth = require('./auth');

const SOURCE = 'access';

const isWindows = () => process.platform === 'win32';

/* ------------------------------------------------------------------ адреса */

/** Адреса IPv4 этой машины (без loopback). */
function localAddresses() {
  const out = [];

  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      out.push({ iface: name, address: item.address, netmask: item.netmask });
    }
  }
  return out;
}

/** Похож ли адрес на «серый» — тот, что живёт за NAT. */
function isPrivate(address) {
  return (
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ||
    /^169\.254\./.test(address)
  );
}

/* -------------------------------------------------------------- проверки */

/**
 * Принимает ли панель подключение на конкретном адресе.
 *
 * Именно этот шаг отличает «слушаю только себя» от «слушаю сеть»: если панель
 * поднята на 127.0.0.1, подключение к её же локальному IP не пройдёт.
 */
function probe(address, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (ok, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ address, port, ok, error: error || '' });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'таймаут'));
    socket.once('error', (err) => finish(false, err.code || err.message));
    socket.connect(port, address);
  });
}

/** Запущена ли панель с правами администратора (иначе netsh не сработает). */
function isAdmin() {
  if (!isWindows()) return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile('net', ['session'], { windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * Внешний адрес этой машины.
 *
 * Нужен, чтобы сказать: «панель слушает сеть, локально всё хорошо, заходите по
 * такому-то адресу» — либо «ваш внешний адрес не совпадает с адресами машины,
 * значит вы за NAT и нужен проброс порта».
 */
async function publicAddress() {
  if (typeof fetch !== 'function') return { address: '', error: 'нужен Node.js 18+' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    if (!response.ok) return { address: '', error: `сервис ответил ${response.status}` };

    const data = await response.json();
    return { address: String(data.ip || '').trim(), error: '' };
  } catch (err) {
    return { address: '', error: err.name === 'AbortError' ? 'нет ответа за 4 с' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ диагностика */

/**
 * Полная проверка доступа.
 * @param {{skipPublic?: boolean}} [opts]
 */
async function diagnose(opts = {}) {
  const cfg = config.load();
  const host = cfg.panel.host || '127.0.0.1';
  const port = cfg.panel.port || 8787;
  const tls = auth.tls();
  const scheme = tls.enabled ? 'https' : 'http';

  const addresses = localAddresses();
  const loopbackOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const listensEverywhere = host === '0.0.0.0' || host === '::';

  // Указан конкретный адрес, которого на машине нет — самая обидная ошибка:
  // панель просто не поднимется или поднимется не там, где ждут.
  const hostIsLocalAddress = addresses.some((item) => item.address === host);
  const hostUnknown = !loopbackOnly && !listensEverywhere && !hostIsLocalAddress;

  const probes = [await probe('127.0.0.1', port)];
  for (const item of addresses) probes.push(await probe(item.address, port));

  const panelFirewall = await firewall.panelStatus();
  const admin = await isAdmin();
  const authStatus = auth.status();
  const external = opts.skipPublic ? { address: '', error: 'проверка пропущена' } : await publicAddress();

  const reachableFromLan = probes.some((p) => p.ok && p.address !== '127.0.0.1');
  const behindNat = Boolean(external.address) && !addresses.some((item) => item.address === external.address);

  const urls = [];
  if (listensEverywhere || loopbackOnly) urls.push(`${scheme}://127.0.0.1:${port}`);
  for (const item of addresses) {
    if (listensEverywhere || item.address === host) urls.push(`${scheme}://${item.address}:${port}`);
  }
  if (external.address && !behindNat) urls.push(`${scheme}://${external.address}:${port}`);

  const result = {
    host,
    port,
    scheme,
    https: tls.enabled,
    listensEverywhere,
    loopbackOnly,
    hostUnknown,
    addresses,
    probes,
    reachableFromLan,
    firewall: panelFirewall,
    admin,
    auth: { required: authStatus.required, mode: authStatus.mode, keyCount: authStatus.keyCount },
    external,
    behindNat,
    urls: [...new Set(urls)],
    steps: []
  };

  result.steps = buildSteps(result);
  return result;
}

/**
 * Шаги по порядку: что уже в порядке, а что нужно сделать. Формулировки — как
 * если бы рядом сидел человек и показывал пальцем.
 */
function buildSteps(r) {
  const steps = [];
  const add = (title, state, detail, action) => steps.push({ title, state, detail, action: action || '' });

  /* 1. Адрес прослушивания */
  if (r.hostUnknown) {
    add(
      'Адрес прослушивания',
      'bad',
      `panel.host = ${r.host}, но такого адреса у этой машины нет. Внешний («белый») адрес роутера или ` +
        'хостера указывать здесь нельзя — он не принадлежит сетевой карте. ' +
        `Адреса машины: ${r.addresses.map((a) => a.address).join(', ') || 'не найдены'}.`,
      'Поставьте panel.host = 0.0.0.0 — панель будет слушать все адреса машины сразу.'
    );
  } else if (r.loopbackOnly) {
    add(
      'Адрес прослушивания',
      'bad',
      `panel.host = ${r.host} — панель принимает подключения только с самой машины. ` +
        'Именно поэтому снаружи ничего не открывается.',
      'Поставьте panel.host = 0.0.0.0 и перезапустите панель.'
    );
  } else {
    add(
      'Адрес прослушивания',
      'ok',
      r.listensEverywhere
        ? `panel.host = ${r.host} — панель слушает все адреса машины.`
        : `panel.host = ${r.host} — панель слушает этот адрес.`
    );
  }

  /* 2. Слушает ли панель на сетевых адресах на самом деле */
  if (!r.addresses.length) {
    add('Сетевые адреса', 'warn', 'У машины нет ни одного внешнего IPv4-адреса — проверьте сетевое подключение.');
  } else if (r.reachableFromLan) {
    const ok = r.probes.filter((p) => p.ok && p.address !== '127.0.0.1').map((p) => p.address);
    add('Подключение по адресу машины', 'ok', `Порт ${r.port} принимает подключения на ${ok.join(', ')}.`);
  } else {
    add(
      'Подключение по адресу машины',
      'bad',
      `Порт ${r.port} не принимает подключения ни на одном сетевом адресе машины ` +
        `(${r.addresses.map((a) => a.address).join(', ')}).`,
      r.loopbackOnly || r.hostUnknown
        ? 'Сначала исправьте panel.host (см. шаг выше) и перезапустите панель.'
        : 'Похоже, подключение режет брандмауэр или сторонний антивирус — см. следующий шаг.'
    );
  }

  /* 3. Брандмауэр Windows */
  if (!r.firewall.supported) {
    add('Брандмауэр', 'skip', `Проверка правил доступна только в Windows (сейчас ${process.platform}).`);
  } else if (r.firewall.exists) {
    add('Брандмауэр Windows', 'ok', `Правило «${r.firewall.rule.name}» есть — входящие на порт ${r.port} разрешены.`);
  } else {
    add(
      'Брандмауэр Windows',
      'bad',
      `Правила для порта ${r.port} нет: Windows молча отбрасывает входящие подключения, и снаружи ` +
        'панель выглядит недоступной, хотя работает.',
      r.admin === false
        ? 'Нажмите «Открыть порт панели» — панель сохранит .bat, который нужно запустить от имени администратора ' +
          '(сейчас панель запущена без прав администратора и netsh ей недоступен).'
        : 'Нажмите «Открыть порт панели» — панель создаст правило сама.'
    );
  }

  /* 4. Права администратора */
  if (r.admin === false) {
    add(
      'Права администратора',
      'warn',
      'Панель запущена без прав администратора: сама создать правило брандмауэра она не сможет.',
      'Запустите start-panel.bat правым щелчком → «Запуск от имени администратора».'
    );
  }

  /* 5. Путь снаружи: NAT или хостер */
  if (r.external.error) {
    add(
      'Внешний адрес',
      'skip',
      `Не удалось узнать внешний адрес (${r.external.error}). Это не мешает работе — просто ` +
        'панель не может подсказать, по какому адресу заходить.'
    );
  } else if (r.behindNat) {
    add(
      'Путь снаружи (NAT)',
      'warn',
      `Внешний адрес — ${r.external.address}, а у машины ${r.addresses.map((a) => a.address).join(', ')}. ` +
        'Значит машина за роутером или NAT хостера: доходить до неё снаружи подключения не будут, пока порт не проброшен.',
      `Проброс в роутере: внешний порт ${r.port} → внутренний ${r.port} TCP на адрес ` +
        `${r.addresses.filter((a) => isPrivate(a.address)).map((a) => a.address)[0] || 'этой машины'}. ` +
        'У хостера то же самое делается в панели управления («Порты», «Firewall», «Security Group»).'
    );
  } else if (r.external.address) {
    add(
      'Путь снаружи',
      'ok',
      `Внешний адрес ${r.external.address} принадлежит самой машине — NAT нет, проброс не нужен.`
    );
  }

  /* 6. Вход по ключам */
  if (r.auth.required) {
    add(
      'Вход по мастер-ключам',
      'ok',
      `Включён (${r.auth.keyCount} ключа, режим «${r.auth.mode}»). Ключи напечатаны в окне панели при запуске.`
    );
  } else {
    add(
      'Вход по мастер-ключам',
      r.loopbackOnly ? 'ok' : 'bad',
      r.loopbackOnly
        ? 'Не требуется: панель доступна только с этой машины.'
        : 'ВЫКЛЮЧЕН, а панель смотрит в сеть: любой, кто знает адрес, получит полный доступ к серверу и файлам.',
      r.loopbackOnly ? '' : 'Поставьте panel.auth.enabled = "auto" (или true) и перезапустите панель.'
    );
  }

  /* 7. HTTPS */
  if (!r.loopbackOnly) {
    if (r.https) {
      add('HTTPS', 'ok', 'Панель работает по https — ключ и данные шифруются.');
    } else {
      add(
        'HTTPS',
        'warn',
        'Панель работает по http: мастер-ключ и всё содержимое идут по сети открытым текстом. ' +
          'Для локальной сети терпимо, для интернета — нет.',
        'Поставьте панель за reverse-proxy с сертификатом (Caddy, nginx) либо укажите panel.tls в config.json.'
      );
    }
  }

  return steps;
}

/* --------------------------------------------------- открыть доступ снаружи */

/**
 * Панель умеет переехать на другой адрес прослушивания без перезапуска —
 * функцию для этого регистрирует server.js (только он владеет сокетом).
 */
let rebinder = null;

function setRebinder(fn) {
  rebinder = fn;
}

/**
 * Открыть панель наружу одним действием: сменить адрес прослушивания, открыть
 * порт в брандмауэре и показать ключи. Именно та последовательность, которую
 * иначе приходится делать руками в трёх местах и по которой легко ошибиться.
 *
 * @param {{host?: string}} [opts]
 */
async function expose(opts = {}) {
  const host = String(opts.host || '0.0.0.0').trim() || '0.0.0.0';
  const before = config.load().panel;
  const previousHost = before.host;

  // Вход по ключам обязателен, когда панель смотрит в сеть. Если его выключили
  // принудительно, возвращаем режим «auto» — иначе панель окажется открытой.
  const patch = { panel: { host } };
  if (before.auth && before.auth.enabled === false) patch.panel.auth = { enabled: 'auto' };
  config.updateRoot(patch);

  const fw = await firewall.applyPanel();

  // Ключи выпускаются при запуске панели, но в локальном режиме не печатались.
  auth.announce();

  const report = await diagnose();
  return {
    ok: true,
    host,
    previousHost,
    firewall: fw,
    keys: auth.listKeys(),
    diagnose: report,
    // Сам переезд делается после того, как этот ответ уйдёт клиенту: пока
    // соединение открыто, старый слушатель не закрыть.
    rebindPending: Boolean(rebinder)
  };
}

/**
 * Переехать на новый адрес. Вызывается уже после отправки ответа: закрыть
 * слушатель, пока по нему идёт запрос, нельзя — close() ждёт, когда соединение
 * освободится, и всё зависает.
 *
 * @param {string} host
 * @param {string} previousHost куда вернуться, если не получилось
 */
async function rebind(host, previousHost) {
  if (!rebinder) return { ok: false, error: 'смена адреса без перезапуска недоступна' };

  const result = await rebinder(host);

  if (!result.ok) {
    // В конфиге не должно остаться адреса, на котором панель не слушает.
    config.updateRoot({ panel: { host: previousHost || result.host } });
    logger.error(SOURCE, `Не удалось открыть панель наружу: ${result.error}`);
    return result;
  }

  logger.info(SOURCE, `Панель доступна из сети: ${host}`);
  return result;
}

/** Открыть порт панели в брандмауэре (и сохранить .bat, если прав не хватило). */
async function openPort() {
  const result = await firewall.applyPanel({ force: false });

  if (result.created) {
    logger.info(SOURCE, 'Порт панели открыт в брандмауэре Windows');
    return { ...result, bat: null };
  }
  if (result.existed) {
    return { ...result, bat: null };
  }

  // Прав не хватило или netsh недоступен — отдаём .bat для ручного запуска.
  const bat = firewall.generateBat();
  return { ...result, bat: bat.path };
}

module.exports = {
  diagnose,
  openPort,
  expose,
  rebind,
  setRebinder,
  localAddresses,
  probe,
  isAdmin,
  publicAddress
};
