/**
 * Мелкие кирпичики интерфейса: иконки, тосты, модальные окна,
 * форматирование и вспомогательные функции DOM.
 *
 * Иконки нарисованы прямо здесь (inline SVG) — панель не тянет ничего
 * из интернета и одинаково выглядит без сети.
 */

const ICONS = {
  server: '<path d="M3 5.5A1.5 1.5 0 014.5 4h15A1.5 1.5 0 0121 5.5v3A1.5 1.5 0 0119.5 10h-15A1.5 1.5 0 013 8.5v-3zM3 15.5A1.5 1.5 0 014.5 14h15a1.5 1.5 0 011.5 1.5v3a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5v-3z"/><path d="M7 7h.01M7 17h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M3 12a9 9 0 019-9 9 9 0 018 5"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-9 9 9 9 0 01-8-5"/><path d="M3 21v-5h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 3.6h.09A1.65 1.65 0 0010 2.09V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 8v.09a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  package: '<path d="M16.5 9.4L7.5 4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  folder: '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  users: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
  key: '<rect x="4" y="10.5" width="16" height="11" rx="2"/><path d="M8 10.5V7a4 4 0 018 0v3.5"/><path d="M12 15v2.5"/>',
  map: '<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16M16 6v16"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>',
  terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  bug: '<path d="M8 2l1.88 1.88M14.12 3.88L16 2"/><path d="M9 7.13V6a3 3 0 116 0v1.13"/><path d="M18 11v2a6 6 0 01-12 0v-2a4 4 0 014-4h4a4 4 0 014 4z"/><path d="M3 13h3M18 13h3M4.5 19.5L7 18M19.5 19.5L17 18"/>',
  external: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M9 22V12h6v10"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  save: '<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  thumb: '<path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  link: '<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>'
};

export function icon(name, size) {
  const body = ICONS[name] || ICONS.info;
  const s = size ? ` width="${size}" height="${size}"` : '';
  return `<svg${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/* --------------------------------------------------------------- DOM */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );
}

/* ---------------------------------------------------------- тосты */

export function toast(message, kind = 'info', timeout) {
  const box = $('#toasts');
  if (!box) return;

  const ic = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[kind] || 'info';
  const node = el(`<div class="toast ${kind}"><span class="ic">${icon(ic)}</span><div>${esc(message)}</div></div>`);
  box.appendChild(node);

  const life = timeout ?? (kind === 'err' ? 10000 : 4800);
  setTimeout(() => {
    node.classList.add('closing');
    setTimeout(() => node.remove(), 240);
  }, life);

  return node;
}

/* -------------------------------------------------------- модалки */

let openModals = 0;

/**
 * Универсальное модальное окно.
 * @param {{title: string, subtitle?: string, icon?: string, body: string|HTMLElement,
 *          footer?: string|HTMLElement, wide?: boolean, onMount?: Function,
 *          closable?: boolean}} opts
 * @returns {{root: HTMLElement, body: HTMLElement, footer: HTMLElement, close: Function}}
 */
export function modal(opts) {
  const backdrop = el(`
    <div class="modal-backdrop">
      <div class="modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          ${opts.icon ? `<span class="card-title-icon">${icon(opts.icon)}</span>` : ''}
          <div style="flex:1;min-width:0">
            <h2>${esc(opts.title)}</h2>
            ${opts.subtitle ? `<div class="sub">${esc(opts.subtitle)}</div>` : ''}
          </div>
          ${opts.closable === false ? '' : `<button class="modal-close" data-close aria-label="Закрыть">${icon('x')}</button>`}
        </div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>
    </div>`);

  const bodyEl = backdrop.querySelector('.modal-body');
  const footEl = backdrop.querySelector('.modal-foot');

  const mount = (target, content) => {
    if (!content) return;
    if (typeof content === 'string') target.innerHTML = content;
    else target.appendChild(content);
  };
  mount(bodyEl, opts.body);
  mount(footEl, opts.footer);
  if (!footEl.childNodes.length) footEl.remove();

  function close() {
    backdrop.classList.add('closing');
    backdrop.querySelector('.modal').classList.add('closing');
    setTimeout(() => backdrop.remove(), 200);
    document.removeEventListener('keydown', onKey);
    if (--openModals <= 0) document.body.style.overflow = '';
  }

  function onKey(e) {
    if (e.key === 'Escape' && opts.closable !== false) close();
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && opts.closable !== false) close();
    if (e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(backdrop);
  openModals++;
  document.body.style.overflow = 'hidden';

  const api = { root: backdrop, body: bodyEl, footer: footEl, close };
  if (opts.onMount) opts.onMount(api);

  const firstInput = bodyEl.querySelector('input, select, textarea');
  if (firstInput) setTimeout(() => firstInput.focus(), 60);

  return api;
}

/** Диалог подтверждения. Возвращает Promise<boolean>. */
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    let decided = false;

    const m = modal({
      title: opts.title,
      subtitle: opts.subtitle,
      icon: opts.icon || 'alert',
      body: `<div style="font-size:13.5px;line-height:1.6">${opts.message}</div>`,
      footer: `
        <span class="spacer"></span>
        <button class="btn" data-no>${esc(opts.cancelText || 'Отмена')}</button>
        <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(opts.confirmText || 'Подтвердить')}</button>`
    });

    m.root.addEventListener('click', (e) => {
      if (e.target.closest('[data-yes]')) {
        decided = true;
        m.close();
        resolve(true);
      } else if (e.target.closest('[data-no]')) {
        decided = true;
        m.close();
        resolve(false);
      }
    });

    const observer = new MutationObserver(() => {
      if (!document.body.contains(m.root)) {
        observer.disconnect();
        if (!decided) resolve(false);
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

/* ------------------------------------------------------- состояние кнопок */

/** Показывает на кнопке спиннер на время запроса. */
export async function busy(btn, fn) {
  if (btn) btn.classList.add('loading');
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'err');
    throw err;
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

/* ------------------------------------------------------ форматирование */

export function fmtBytes(bytes) {
  if (!bytes) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function fmtUptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}д ${h}ч`;
  if (h) return `${h}ч ${m}м`;
  if (m) return `${m}м ${s}с`;
  return `${s}с`;
}

export function fmtDate(value) {
  if (!value) return '—';
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU');
}

export function fmtUnix(sec) {
  return sec ? new Date(sec * 1000).toLocaleDateString('ru-RU') : '—';
}

export function fmtNumber(value) {
  return Number(value || 0).toLocaleString('ru-RU');
}

/** Плавная «перемотка» числа в плитке статистики. */
export function animateNumber(node, to, format = (v) => String(Math.round(v))) {
  const from = parseFloat(node.dataset.value || '0') || 0;
  if (from === to) {
    node.textContent = format(to);
    return;
  }
  node.dataset.value = String(to);

  const started = performance.now();
  const duration = 420;

  function frame(now) {
    const p = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - p) ** 3;
    node.textContent = format(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Подсветка карточки под курсором (радиальный блик). */
export function trackPointer(node) {
  node.addEventListener('pointermove', (e) => {
    const rect = node.getBoundingClientRect();
    node.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    node.style.setProperty('--my', `${e.clientY - rect.top}px`);
  });
}

export const STATUS_LABEL = {
  stopped: 'Остановлен',
  preparing: 'Подготовка',
  running: 'Работает',
  stopping: 'Остановка'
};
