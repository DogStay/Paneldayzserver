'use strict';

/**
 * Вход через Steam (OpenID 2.0).
 *
 * Steam не даёт ни OAuth, ни ключа для «докажи, что это твой аккаунт» — только
 * OpenID 2.0. Игрок уходит на steamcommunity.com, вводит пароль там, и Steam
 * возвращает его назад с подписанным ответом.
 *
 * Проверять ответ обязательно **у самого Steam** (`check_authentication`):
 * параметры в адресной строке подделать может кто угодно, и без этой проверки
 * верификация ничего не доказывает. Библиотеки для этого не нужны — здесь весь
 * протокол в двух функциях.
 */

const https = require('https');
const { URL, URLSearchParams } = require('url');

const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const IDENTIFIER = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/**
 * Куда отправить игрока.
 *
 * `returnTo` — адрес, на который Steam вернёт его; `realm` — сайт, которому
 * игрок доверяет (Steam покажет его на своей странице).
 */
function loginUrl(returnTo, realm) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  });

  return `${OPENID_ENDPOINT}?${params.toString()}`;
}

/** POST на endpoint Steam. Отдельно, чтобы проверка читалась одним куском. */
function post(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(OPENID_ENDPOINT);
    const payload = body.toString();

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
      }
    );

    req.on('timeout', () => req.destroy(new Error('Steam не ответил за 15 с')));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Проверить возврат от Steam и достать steamId64.
 *
 * `query` — объект параметров из адресной строки (req.query).
 * Возвращает { ok, steamId, reason }.
 */
async function verify(query = {}) {
  if (query['openid.mode'] !== 'id_res') {
    return { ok: false, reason: 'Steam не подтвердил вход (вы могли нажать «Отмена»)' };
  }

  const claimed = String(query['openid.claimed_id'] || '');
  const match = claimed.match(IDENTIFIER);
  if (!match) return { ok: false, reason: 'Steam вернул неожиданный ответ — попробуйте ещё раз' };

  // Пересылаем Steam ровно то, что он прислал, сменив mode: только он знает,
  // подписывал ли он это.
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('openid.')) body.append(key, String(value));
  }
  body.set('openid.mode', 'check_authentication');

  let answer = '';
  try {
    answer = await post(body);
  } catch (err) {
    return { ok: false, reason: `Не удалось проверить ответ Steam: ${err.message}` };
  }

  if (!/is_valid\s*:\s*true/i.test(answer)) {
    return { ok: false, reason: 'Steam не подтвердил подпись ответа — вход не принят' };
  }

  return { ok: true, steamId: match[1] };
}

/**
 * Ник из профиля Steam.
 *
 * Нужен Steam Web API Key. Без него верификация всё равно работает — просто ник
 * в файлах будет из Discord, поэтому отсутствие ключа не ошибка.
 */
function profileName(steamId, apiKey) {
  return new Promise((resolve, reject) => {
    const key = String(apiKey || '').trim();
    if (!key) return resolve('');

    const url =
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/' +
      `?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId)}`;

    const req = https.get(url, { timeout: 10000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          const players = JSON.parse(text).response.players || [];
          resolve(players.length ? String(players[0].personaname || '') : '');
        } catch (err) {
          reject(new Error(`Steam ответил не тем, что ожидалось: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Steam не ответил за 10 с')));
    req.on('error', reject);
  });
}

module.exports = { loginUrl, verify, profileName, IDENTIFIER };
