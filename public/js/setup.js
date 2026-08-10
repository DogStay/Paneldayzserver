/**
 * Мастер настройки. Страница целиком рисуется по описанию полей с сервера
 * (services/setup.js STEPS), поэтому новое поле в панели тут появляется само.
 *
 * Отдельный файл, не часть интерфейса панели: мастер открывается до входа и
 * только с этой машины, поэтому он не зависит от store.js и прав.
 */

const root = document.getElementById('root');
const stateLine = document.getElementById('state');
const subLine = document.getElementById('sub');

/** Значения, которые человек поменял. Сохраняется только это. */
const dirty = new Map();

/** Секреты, которые он попросил стереть. */
const clearing = new Set();

let data = null;

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function api(path, options) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options && options.body ? { 'Content-Type': 'application/json' } : undefined
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Ошибка ${res.status}`);
  return body;
}

/* -------------------------------------------------------------------- поля */

function fieldHtml(field) {
  const id = `f-${field.path.replace(/\./g, '-')}`;
  const hint = field.hint ? `<div class="fhint">${esc(field.hint)}</div>` : '';

  if (field.type === 'bool') {
    return `<div class="row"><input type="checkbox" id="${id}" data-path="${field.path}" data-type="bool"${field.value ? ' checked' : ''}>
      <label for="${id}">${esc(field.label)}</label></div>${hint}`;
  }

  if (field.type === 'select' || field.type === 'role') {
    const options = field.type === 'role'
      ? (data.roles || []).map((r) => [r.id, r.title])
      : (field.options || []);

    const list = options
      .map(([value, title]) => `<option value="${esc(value)}"${String(field.value) === String(value) ? ' selected' : ''}>${esc(title)}</option>`)
      .join('');

    return `<label for="${id}">${esc(field.label)}</label>
      <select id="${id}" data-path="${field.path}" data-type="text">${list}</select>${hint}`;
  }

  if (field.type === 'secret') {
    return `<label for="${id}">${esc(field.label)}</label>
      <input type="password" id="${id}" data-path="${field.path}" data-type="secret" placeholder="${field.set ? '••••••••  (задано)' : 'не задано'}" autocomplete="new-password">
      <div class="secret-note">${field.set
        ? 'Пустое поле — оставить как есть. <a href="#" data-clear="' + field.path + '">Стереть</a>'
        : 'Значение никуда не показывается после сохранения.'}</div>${hint}`;
  }

  if (field.type === 'roster') return rosterHtml(field);

  const type = field.type === 'number' ? 'number' : 'text';
  return `<label for="${id}">${esc(field.label)}</label>
    <input type="${type}" id="${id}" data-path="${field.path}" data-type="${field.type}" value="${esc(field.value)}">${hint}`;
}

/**
 * Цели прописки правятся как таблица: файл, формат, фракция.
 *
 * Список отдаётся сервером как есть, поэтому редактор простой — строки с
 * кнопкой «убрать» и кнопка «добавить».
 */
function rosterHtml(field) {
  const rows = (field.value || [])
    .map((t, i) => `<tr data-i="${i}">
      <td><input type="text" data-k="title" value="${esc(t.title || '')}" placeholder="Вайтлист"></td>
      <td><input type="text" data-k="file" value="${esc(t.file || '')}" placeholder="whitelist.txt"></td>
      <td><select data-k="format">
        ${[['lines', 'строки'], ['json-array', 'JSON-массив'], ['group-spawner', 'GroupSpawner']]
          .map(([v, n]) => `<option value="${v}"${t.format === v ? ' selected' : ''}>${n}</option>`).join('')}
      </select></td>
      <td><input type="text" data-k="group" value="${esc(t.group || '')}" placeholder="фракция"></td>
      <td><button class="small" data-roster-del="${i}">убрать</button></td>
    </tr>`)
    .join('');

  return `<div style="grid-column: 1 / -1">
    <table id="roster-table">
      <tr><th>Название</th><th>Файл</th><th>Формат</th><th>Фракция</th><th></th></tr>
      ${rows}
    </table>
    <div class="nav"><a href="#" id="roster-add">+ добавить файл</a></div>
  </div>`;
}

/** Собрать таблицу целей в массив — вызывается перед сохранением. */
function rosterValue() {
  const table = document.getElementById('roster-table');
  if (!table) return null;

  return [...table.querySelectorAll('tr[data-i]')].map((tr, index) => {
    const get = (k) => {
      const el = tr.querySelector(`[data-k="${k}"]`);
      return el ? el.value.trim() : '';
    };
    return {
      id: `target${index + 1}`,
      title: get('title') || get('file'),
      file: get('file'),
      format: get('format') || 'lines',
      group: get('group'),
      comment: true
    };
  }).filter((t) => t.file);
}

/* ------------------------------------------------------------------ отрисовка */

function render() {
  subLine.textContent = `${data.configFile} · Node ${data.node} · ${data.server ? `сервер «${data.server.name}»` : 'сервер не создан'}`;

  const checklist = `<div class="card">
    <h2>Готовность</h2>
    <p class="hint">Что уже работает, а что мешает. Обновляется после сохранения.</p>
    <div class="list">${data.checklist.map((item) => `<div class="item">
      <span class="dot ${item.state}"></span>
      <span>${esc(item.title)}${item.reason ? ` — <span class="why">${esc(item.reason)}</span>` : ''}
      ${item.hint ? `<div class="why">${esc(item.hint)}</div>` : ''}</span>
    </div>`).join('')}</div>
    <div class="nav">${data.steps.map((s) => `<a href="#step-${s.id}">${esc(s.title)}</a>`).join('')}
      <a href="/index.html">Открыть панель →</a></div>
  </div>`;

  const steps = data.steps.map((step) => `<div class="card" id="step-${step.id}">
    <h2>${esc(step.title)}</h2>
    <p class="hint">${esc(step.hint)}</p>
    ${step.blocked ? `<div class="blocked">${esc(step.blocked)}</div>` : ''}
    <div class="grid">${step.fields.map((f) => `<div>${fieldHtml(f)}</div>`).join('')}</div>
    ${step.id === 'database' ? '<div class="nav"><a href="#" id="db-test">Проверить базу</a></div><div class="msg" id="db-msg"></div>' : ''}
  </div>`).join('');

  root.innerHTML = checklist + steps;
  bind();
  showState();
}

function showState() {
  const changed = dirty.size + clearing.size;
  stateLine.textContent = changed ? `Не сохранено изменений: ${changed}` : 'Изменений нет';
}

function bind() {
  root.querySelectorAll('[data-path]').forEach((el) => {
    el.addEventListener('input', () => {
      const path = el.dataset.path;
      dirty.set(path, el.dataset.type === 'bool' ? el.checked : el.value);
      clearing.delete(path);
      showState();
    });
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        dirty.set(el.dataset.path, el.value);
        showState();
      });
    }
  });

  root.querySelectorAll('[data-clear]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      clearing.add(link.dataset.clear);
      dirty.delete(link.dataset.clear);
      link.textContent = 'будет стёрто при сохранении';
      showState();
    });
  });

  const add = document.getElementById('roster-add');
  if (add) {
    add.addEventListener('click', (e) => {
      e.preventDefault();
      const step = data.steps.find((s) => s.id === 'roster');
      const field = step.fields.find((f) => f.type === 'roster');
      field.value = [...(field.value || []), { title: '', file: '', format: 'lines', group: '' }];
      render();
      location.hash = '#step-roster';
    });
  }

  root.querySelectorAll('[data-roster-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = data.steps.find((s) => s.id === 'roster');
      const field = step.fields.find((f) => f.type === 'roster');
      field.value = rosterValue().filter((_, i) => i !== Number(btn.dataset.rosterDel));
      dirty.set('roster.targets', field.value);
      render();
      location.hash = '#step-roster';
    });
  });

  const test = document.getElementById('db-test');
  if (test) {
    test.addEventListener('click', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('db-msg');
      msg.className = 'msg';
      msg.textContent = 'Проверяю…';

      try {
        const st = await api('/setup/database');
        if (st.ok) {
          msg.className = 'msg ok';
          msg.textContent = `Подключено. Таблиц видно: ${(st.tables || []).length}` +
            ((st.foreign || []).length ? `, из них от сайта и бота: ${st.foreign.join(', ')}` : '');
        } else {
          msg.className = 'msg err';
          msg.textContent = st.reason || st.error || 'не подключилась';
        }
      } catch (err) {
        msg.className = 'msg err';
        msg.textContent = err.message;
      }
    });
  }
}

/* ------------------------------------------------------------------ загрузка */

async function load() {
  stateLine.textContent = 'Загружаю…';
  try {
    data = await api('/setup');
    dirty.clear();
    clearing.clear();
    render();
  } catch (err) {
    root.innerHTML = `<div class="card"><h2>Не открылось</h2><p class="hint">${esc(err.message)}</p></div>`;
  }
}

document.getElementById('reload').addEventListener('click', load);

document.getElementById('save').addEventListener('click', async () => {
  const values = Object.fromEntries(dirty);

  // Таблица целей прописки живёт в DOM, поэтому собираем её всегда: человек мог
  // поправить строку и не тронуть ни одного «обычного» поля.
  const targets = rosterValue();
  if (targets) values['roster.targets'] = targets;

  stateLine.textContent = 'Сохраняю…';
  try {
    const result = await api('/setup', { method: 'POST', body: JSON.stringify({ values, clear: [...clearing] }) });
    await load();

    stateLine.textContent = result.restartNeeded
      ? `Сохранено (${result.saved}). Адрес или порт панели изменились — перезапустите панель.`
      : `Сохранено: ${result.saved}`;
  } catch (err) {
    stateLine.textContent = `Не сохранено: ${err.message}`;
  }
});

load();
