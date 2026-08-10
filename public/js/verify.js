/**
 * Страница верификации игрока.
 *
 * Всё состояние — в токене из адресной строки: панель не знает этого человека,
 * пока Steam не подтвердит вход. Поэтому здесь нет ни входа, ни cookie.
 */

const card = document.getElementById('card');
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';

function show(icon, title, text, extra = '') {
  card.innerHTML = `<div class="big">${icon}</div><h1>${title}</h1><p>${text}</p>${extra}`;
}

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function main() {
  if (!token) {
    show('🚫', 'Ссылка неполная', 'Откройте ссылку из Discord целиком — в ней есть код, без которого проверка не начнётся.');
    return;
  }

  // Возврат от Steam уже всё решил: панель дописала связку и поставила прописку.
  if (params.get('done')) {
    show('✅', 'Готово', 'Steam подтверждён, вы прописаны на сервере. Можно закрыть страницу и вернуться в Discord — роль появится в течение минуты.');
    return;
  }

  const error = params.get('error');

  let state = {};
  try {
    const res = await fetch(`/api/verify/session?token=${encodeURIComponent(token)}`);
    state = await res.json();
  } catch (_) {
    show('⚠️', 'Панель не отвечает', 'Попробуйте открыть ссылку ещё раз через минуту.');
    return;
  }

  if (!state.ok) {
    show('⌛', 'Ссылка не действует', esc(state.reason || 'нажмите кнопку верификации в Discord заново'));
    return;
  }

  if (state.stage === 'done') {
    show('✅', 'Уже подтверждено', `Steam ${esc(state.steamId)} привязан. Прописка поставлена, роль выдаст бот.`);
    return;
  }

  const minutes = Math.max(1, Math.round((state.secondsLeft || 0) / 60));

  show(
    '🎮',
    'Подтвердите Steam',
    `Вход происходит на сайте Steam — пароль вводится там, панель его не видит и не получает. ` +
      `Нужно только, чтобы Steam подтвердил, что аккаунт ваш.`,
    `<a class="steam" href="/api/verify/steam/start?token=${encodeURIComponent(token)}">Войти через Steam</a>
     ${error ? `<div class="err">${esc(error)}</div>` : ''}
     <div class="small">Ссылка действует ещё ${minutes} мин.${state.discordTag ? ` Discord: <code>${esc(state.discordTag)}</code>` : ''}
     <br>Ссылка одноразовая и личная — не передавайте её никому.</div>`
  );
}

main();
