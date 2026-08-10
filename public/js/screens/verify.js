/**
 * Вкладка «Верификация» — все доказанные связки Discord ↔ Steam.
 *
 * Здесь видно, кто прошёл проверку, каким способом и прописан ли он в файлы
 * сервера. Прописка проверяется по самим файлам, а не по отметке в базе: только
 * так видно расхождение «в базе есть, а в вайтлисте нет», из-за которого игрок
 * приходит и не может зайти.
 */

import { api } from '../api.js';
import { can } from '../store.js';
import { esc, icon, toast, busy, modal, confirmDialog, fmtDate } from '../ui.js';

let paneRef = null;
let links = [];
let search = '';
let rosterInfo = { targets: [], queue: [], reason: '' };

const SOURCE_LABEL = {
  'steam-openid': 'Steam подтвердил вход',
  manual: 'связал администратор'
};

export function initVerifyTab(pane) {
  paneRef = pane;
  pane.__load = showVerifyTab;
  pane.innerHTML = `<div class="cards" id="vf-root"><div class="card"><div class="card-body">Загружаю…</div></div></div>`;
}

export async function showVerifyTab() {
  if (!paneRef) return;
  await load();
}

async function load() {
  try {
    const [data, roster] = await Promise.all([api.verifyLinks(500), api.rosterStatus().catch(() => rosterInfo)]);
    links = data.links || [];
    rosterInfo = roster || rosterInfo;
  } catch (err) {
    toast(err.message, 'err');
    links = [];
  }
  render();
}

function render() {
  const editable = can('files.write');
  const needle = search.trim().toLowerCase();

  const shown = links.filter((l) =>
    !needle
      ? true
      : [l.discordId, l.discordTag, l.steamId, l.nickname].join(' ').toLowerCase().includes(needle)
  );

  const rows = shown.length
    ? shown
        .map(
          (l) => `
      <tr data-open="${esc(l.discordId)}" style="cursor:pointer">
        <td><b>${esc(l.nickname || '—')}</b>
          <div class="dim" style="font-size:11.5px">${esc(l.discordTag || l.discordId)}</div></td>
        <td><code>${esc(l.steamId)}</code></td>
        <td>${esc(SOURCE_LABEL[l.source] || l.source || '')}</td>
        <td>${l.verifiedAt ? fmtDate(l.verifiedAt) : '—'}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="4" class="dim">${links.length ? 'Ничего не найдено.' : 'Пока никто не проходил верификацию.'}</td></tr>`;

  const queue = rosterInfo.queue && rosterInfo.queue.length
    ? `<div class="dim" style="margin-top:10px">В очереди на прописку: ${rosterInfo.queue
        .map((j) => `${esc(j.steamId)}${j.lastError ? ` (${esc(j.lastError)})` : ''}`)
        .join(', ')}</div>`
    : '';

  paneRef.querySelector('#vf-root').innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('shield')}</span>
        <div style="flex:1"><h2>Проверенные игроки</h2>
          <div class="card-sub">Связок: ${links.length}. Владение Steam подтверждает сам Steam, ник берётся оттуда же</div></div>
        ${editable ? `<button class="btn btn-sm" id="vf-add">${icon('plus')} Связать вручную</button>` : ''}
        <button class="btn btn-sm btn-ghost" id="vf-reload">${icon('refresh')} Обновить</button>
      </div>
      <div class="card-body">
        <input id="vf-search" placeholder="ник, Discord или Steam ID" value="${esc(search)}">
        ${rosterInfo.reason ? `<div class="dim" style="margin-top:10px">Прописка: ${esc(rosterInfo.reason)}</div>` : ''}
        ${queue}
      </div>
      <div class="card-body" style="padding:0">
        <table class="data">
          <thead><tr><th>Игрок</th><th>Steam</th><th>Чем подтверждено</th><th>Когда</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  bind(editable);
}

function bind(editable) {
  const root = paneRef.querySelector('#vf-root');

  root.querySelector('#vf-reload').addEventListener('click', load);

  const input = root.querySelector('#vf-search');
  input.addEventListener('input', () => {
    // Фильтр местный: связки уже загружены, дёргать панель на каждую букву незачем.
    search = input.value;
    const caret = input.selectionStart;
    render();
    const next = paneRef.querySelector('#vf-search');
    next.focus();
    next.setSelectionRange(caret, caret);
  });

  const add = root.querySelector('#vf-add');
  if (add) add.addEventListener('click', linkManually);

  root.querySelectorAll('[data-open]').forEach((row) =>
    row.addEventListener('click', () => openProfile(row.dataset.open, editable))
  );
}

/* ------------------------------------------------------------------ профиль */

async function openProfile(discordId, editable) {
  let data;
  try {
    data = await api.verifyStatusOf(discordId);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }

  const targets = (data.roster || [])
    .map((t) => `<div class="row"><span>${t.present ? '✅' : '⏳'}</span><span>${esc(t.title)}</span></div>`)
    .join('') || '<div class="dim">Цели прописки не настроены.</div>';

  modal({
    title: data.nickname || data.discordTag || discordId,
    subtitle: `Discord ${data.discordTag || discordId} · Steam ${data.steamId}`,
    icon: 'shield',
    body: `
      <div class="form-grid">
        <div class="field"><label>Steam ID</label><div><code>${esc(data.steamId || '')}</code></div></div>
        <div class="field"><label>Ник из Steam</label><div>${esc(data.nickname || '—')}</div></div>
        <div class="field"><label>Чем подтверждено</label><div>${esc(SOURCE_LABEL[data.source] || data.source || '')}</div></div>
        <div class="field"><label>Когда</label><div>${data.verifiedAt ? fmtDate(data.verifiedAt) : '—'}</div></div>
      </div>
      <h4 style="margin:16px 0 8px">Прописан в файлы сервера</h4>
      ${targets}
      <div class="dim" style="margin-top:10px">
        Проверяется по самим файлам сервера, а не по отметке в базе.
      </div>`,
    footer: editable
      ? `<button class="btn btn-ghost" data-close>Закрыть</button>
         <button class="btn" id="vf-requeue">Прописать заново</button>
         <button class="btn btn-danger" id="vf-unlink">Снять связку</button>`
      : '<button class="btn btn-ghost" data-close>Закрыть</button>',
    onMount: (dialog) => {
      const requeue = dialog.footer.querySelector('#vf-requeue');
      if (requeue) {
        requeue.addEventListener('click', async () => {
          try {
            await api.rosterAdd({ steamId: data.steamId, name: data.nickname, discordId });
            toast('Поставлено в очередь — панель допишет в файлы', 'ok');
            dialog.close();
            load();
          } catch (err) {
            toast(err.message, 'err');
          }
        });
      }

      const unlink = dialog.footer.querySelector('#vf-unlink');
      if (unlink) {
        unlink.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Снять связку?',
            message: 'Игрок сможет пройти верификацию заново. Из файлов сервера запись не убирается — это делается вручную.',
            confirmText: 'Снять',
            danger: true
          });
          if (!ok) return;

          try {
            await api.verifyUnlink(discordId);
            toast('Связка снята', 'ok');
            dialog.close();
            load();
          } catch (err) {
            toast(err.message, 'err');
          }
        });
      }
    }
  });
}

function linkManually() {
  modal({
    title: 'Связать вручную',
    subtitle: 'Когда у человека не выходит войти в Steam в браузере',
    icon: 'plus',
    body: `
      <div class="form-grid">
        <div class="field"><label>Discord ID</label><input id="vf-d" placeholder="18 цифр"></div>
        <div class="field"><label>Steam ID64</label><input id="vf-s" placeholder="17 цифр"></div>
        <div class="field"><label>Ник</label><input id="vf-n" placeholder="как показывать в файлах"></div>
      </div>
      <div class="dim" style="margin-top:10px">
        Ручная связка ничего не доказывает — Steam её не подтверждал. Пользуйтесь ею, только если
        уверены, что аккаунт принадлежит этому человеку.
      </div>`,
    footer: `
      <button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-primary" id="vf-do">${icon('check')} Связать и прописать</button>`,
    onMount: (dialog) => {
      dialog.footer.querySelector('#vf-do').addEventListener('click', async (e) => {
        const body = {
          discordId: dialog.body.querySelector('#vf-d').value.trim(),
          steamId: dialog.body.querySelector('#vf-s').value.trim(),
          nickname: dialog.body.querySelector('#vf-n').value.trim()
        };

        // busy() гасит кнопку и сам показывает причину отказа.
        await busy(e.currentTarget, async () => {
          await api.verifyLink(body);
          toast('Связано, прописка поставлена в очередь', 'ok');
          dialog.close();
          load();
        }).catch(() => {});
      });
    }
  });
}
