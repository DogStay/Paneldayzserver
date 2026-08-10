/**
 * Вкладка «Обращения» — админка тикетов.
 *
 * Здесь настраивается всё, что видит игрок в Discord: какие кнопки показать,
 * что спросить при нажатии, кто видит обращение, что написать при открытии, при
 * «взять тикет» и при закрытии. Бот читает эту настройку по API и перерисовывает
 * кнопки — правка формы здесь не требует правки бота.
 *
 * Вторая половина экрана — сами обращения: ответы на вопросы и переписка. Она
 * хранится в панели, поэтому обращение читается и после того, как Discord
 * заархивирует ветку.
 */

import { api } from '../api.js';
import { can } from '../store.js';
import { $, esc, icon, toast, busy, modal, confirmDialog, fmtDate } from '../ui.js';

let paneRef = null;
let config = { settings: {}, forms: [] };
let filters = { status: '', formId: '', search: '' };

const STATUS_LABEL = { open: 'новое', claimed: 'в работе', closed: 'закрыто' };
const STYLE_LABEL = { primary: 'синяя', secondary: 'серая', success: 'зелёная', danger: 'красная' };

export function initTicketsTab(pane) {
  paneRef = pane;
  pane.__load = showTicketsTab;
  pane.innerHTML = `
    <div class="cards" id="tk-root">
      <div class="card"><div class="card-body">Загружаю…</div></div>
    </div>`;
}

export async function showTicketsTab() {
  if (!paneRef) return;
  await Promise.all([loadConfig(), loadList()]);
}

/* ------------------------------------------------------------------ загрузка */

async function loadConfig() {
  try {
    config = await api.ticketsConfig();
  } catch (err) {
    toast(err.message, 'err');
    config = { settings: {}, forms: [] };
  }
  render();
}

let listData = { tickets: [], counts: {}, forms: [] };

async function loadList() {
  try {
    listData = await api.tickets(filters);
  } catch (err) {
    listData = { tickets: [], counts: {}, forms: [], error: err.message };
  }
  render();
}

/* ---------------------------------------------------------------- отрисовка */

function render() {
  if (!paneRef) return;
  const editable = can('tickets.manage');

  paneRef.querySelector('#tk-root').innerHTML = `
    ${formsCard(editable)}
    ${settingsCard(editable)}
    ${listCard()}`;

  bind(editable);
}

function formsCard(editable) {
  const rows = config.forms.length
    ? config.forms
        .map(
          (form, index) => `
      <tr>
        <td>${form.emoji ? `${esc(form.emoji)} ` : ''}<b>${esc(form.title)}</b>
          ${form.enabled ? '' : '<span class="badge">выключена</span>'}
          <div class="dim" style="font-size:11.5px">${esc(form.description || '')}</div></td>
        <td>${esc(form.buttonLabel)}<div class="dim" style="font-size:11.5px">кнопка ${STYLE_LABEL[form.buttonStyle] || ''}</div></td>
        <td>${form.questions.length}</td>
        <td>${form.staffRoleIds.length ? esc(form.staffRoleIds.join(', ')) : '<span class="dim">общие</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          ${editable
            ? `<button class="btn btn-sm" data-edit="${index}">${icon('settings')}</button>
               <button class="btn btn-sm btn-ghost" data-del="${index}">${icon('trash')}</button>`
            : ''}
        </td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="dim">Форм нет — в Discord не появится ни одной кнопки.</td></tr>`;

  return `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('file')}</span>
        <div style="flex:1">
          <h3>Формы обращений</h3>
          <div class="card-sub">Каждая форма — кнопка в Discord: свой текст, свои вопросы, свои роли.</div>
        </div>
        ${editable ? `<button class="btn btn-sm btn-primary" id="tk-add">${icon('plus')} Новая форма</button>` : ''}
      </div>
      <div class="card-body" style="padding:0">
        <table class="data">
          <thead><tr><th>Форма</th><th>Кнопка</th><th>Вопросов</th><th>Роли поддержки</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="card-body dim" style="border-top:1px solid rgba(255,255,255,.06)">
        Чтобы кнопки появились в Discord, вызовите там <code>/tickets-panel</code> в нужном канале.
        Бот подхватывает изменения сам в течение 5 минут.
      </div>
    </div>`;
}

function field(label, input, hint) {
  return `<div class="field"><label>${label}</label>${input}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function settingsCard(editable) {
  const s = config.settings || {};
  const off = editable ? '' : 'disabled';

  return `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('settings')}</span>
        <div><h2>Общие настройки обращений</h2>
        <div class="card-sub">Заголовок панели с кнопками, надписи кнопок, роли и правила</div></div>
      </div>
      <div class="form-grid">
        ${field('Заголовок панели', `<input id="tk-panelTitle" value="${esc(s.panelTitle || '')}" ${off}>`)}
        ${field('Канал с кнопками (ID)', `<input id="tk-channelId" value="${esc(s.channelId || '')}" ${off}>`,
          'Пусто — берётся «ID канала тикетов» из мастера настройки')}
        ${field('Надпись «взять»', `<input id="tk-claimLabel" value="${esc(s.claimLabel || '')}" ${off}>`)}
        ${field('Надпись «закрыть»', `<input id="tk-closeLabel" value="${esc(s.closeLabel || '')}" ${off}>`)}
        ${field('Роли поддержки (ID)', `<input id="tk-staffRoleIds" value="${esc((s.staffRoleIds || []).join(', '))}" ${off}>`,
          'Кто может брать обращения. Несколько — через запятую')}
        ${field('Роли-наблюдатели (ID)', `<input id="tk-viewerRoleIds" value="${esc((s.viewerRoleIds || []).join(', '))}" ${off}>`,
          'Видят обращение, но не берут его')}
        ${field('Открытых обращений на человека',
          `<input type="number" min="1" max="10" id="tk-maxOpenPerUser" value="${Number(s.maxOpenPerUser || 1)}" ${off}>`)}
        ${field('Ветка архивируется через', `<select id="tk-autoArchiveMinutes" ${off}>
          ${[[60, 'час'], [1440, 'сутки'], [4320, '3 дня'], [10080, 'неделю']]
            .map(([v, t]) => `<option value="${v}" ${Number(s.autoArchiveMinutes) === v ? 'selected' : ''}>${t}</option>`)
            .join('')}</select>`)}
      </div>
      <div class="form-grid one" style="margin-top:16px">
        ${field('Текст панели с кнопками', `<textarea id="tk-panelText" rows="2" ${off}>${esc(s.panelText || '')}</textarea>`)}
      </div>
      <label class="switch" style="margin-top:16px">
        <input type="checkbox" id="tk-deleteOnClose" ${s.deleteOnClose ? 'checked' : ''} ${off}>
        <span class="track"></span>
        <span class="switch-text">Удалять ветку при закрытии
          <small>переписка остаётся здесь, в панели, поэтому ничего не теряется</small></span></label>
      ${editable
        ? `<div class="row" style="margin-top:18px">
             <button class="btn btn-primary" id="tk-save-settings">${icon('check')} Сохранить настройки</button></div>`
        : ''}
    </div>`;
}

function listCard() {
  const counts = listData.counts || {};
  const rows = (listData.tickets || []).length
    ? listData.tickets
        .map(
          (t) => `
      <tr data-open="${esc(t.id)}" style="cursor:pointer">
        <td>№${t.number}</td>
        <td>${esc(t.formTitle)}</td>
        <td>${esc(t.discordTag || t.discordId)}</td>
        <td><span class="badge ${t.status === 'open' ? 'warn' : ''}">${STATUS_LABEL[t.status]}</span>
          ${t.claimedByTag ? `<div class="dim" style="font-size:11.5px">${esc(t.claimedByTag)}</div>` : ''}</td>
        <td>${fmtDate(t.openedAt)}</td>
        <td>${t.messages}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="dim">${esc(listData.error || 'Обращений нет.')}</td></tr>`;

  return `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('activity')}</span>
        <div style="flex:1"><h3>Обращения</h3>
          <div class="card-sub">Новых ${counts.open || 0}, в работе ${counts.claimed || 0}, закрыто ${counts.closed || 0}</div></div>
        <button class="btn btn-sm btn-ghost" id="tk-reload">${icon('refresh')} Обновить</button>
      </div>
      <div class="card-body" style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="tk-f-status" style="max-width:200px">
          <option value="">все состояния</option>
          ${Object.entries(STATUS_LABEL)
            .map(([v, t]) => `<option value="${v}" ${filters.status === v ? 'selected' : ''}>${t}</option>`)
            .join('')}
        </select>
        <select id="tk-f-form" style="max-width:220px">
          <option value="">все формы</option>
          ${(listData.forms || [])
            .map((f) => `<option value="${esc(f.id)}" ${filters.formId === f.id ? 'selected' : ''}>${esc(f.title)}</option>`)
            .join('')}
        </select>
        <input id="tk-f-search"  placeholder="ник, Discord, номер, текст" value="${esc(filters.search)}" style="flex:1;min-width:180px">
      </div>
      <div class="card-body" style="padding:0">
        <table class="data">
          <thead><tr><th>№</th><th>Форма</th><th>Кто</th><th>Состояние</th><th>Открыто</th><th>Сообщений</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------- события */

function bind(editable) {
  const root = paneRef.querySelector('#tk-root');

  const add = root.querySelector('#tk-add');
  if (add) add.addEventListener('click', () => editForm(null));

  root.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => editForm(Number(btn.dataset.edit)))
  );

  root.querySelectorAll('[data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const index = Number(btn.dataset.del);
      const form = config.forms[index];
      const ok = await confirmDialog({
        title: `Удалить форму «${form.title}»?`,
        message: 'Кнопка исчезнет из Discord. Уже открытые обращения останутся.',
        confirmText: 'Удалить',
        danger: true
      });
      if (!ok) return;

      await save({ forms: config.forms.filter((_, i) => i !== index) }, btn);
    })
  );

  const saveSettings = root.querySelector('#tk-save-settings');
  if (saveSettings) {
    saveSettings.addEventListener('click', async (e) => {
      const val = (id) => root.querySelector(`#tk-${id}`).value.trim();
      const list = (id) => val(id).split(/[\s,;]+/).filter(Boolean);

      await save({
        settings: {
          panelTitle: val('panelTitle'),
          panelText: val('panelText'),
          channelId: val('channelId'),
          claimLabel: val('claimLabel'),
          closeLabel: val('closeLabel'),
          staffRoleIds: list('staffRoleIds'),
          viewerRoleIds: list('viewerRoleIds'),
          maxOpenPerUser: Number(val('maxOpenPerUser')) || 1,
          autoArchiveMinutes: Number(val('autoArchiveMinutes')) || 1440,
          deleteOnClose: root.querySelector('#tk-deleteOnClose').checked
        }
      }, e.currentTarget);
    });
  }

  root.querySelector('#tk-reload').addEventListener('click', loadList);

  root.querySelector('#tk-f-status').addEventListener('change', (e) => {
    filters.status = e.target.value;
    loadList();
  });
  root.querySelector('#tk-f-form').addEventListener('change', (e) => {
    filters.formId = e.target.value;
    loadList();
  });

  const search = root.querySelector('#tk-f-search');
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    // Ждём паузу в наборе: иначе запрос уходит на каждую букву.
    timer = setTimeout(() => {
      filters.search = search.value.trim();
      loadList();
    }, 350);
  });

  root.querySelectorAll('[data-open]').forEach((row) =>
    row.addEventListener('click', () => openTicket(row.dataset.open, editable))
  );
}

async function save(patch, button) {
  // busy() сам гасит кнопку и показывает ошибку, поэтому здесь только результат.
  await busy(button, async () => {
    config = await api.saveTicketsConfig(patch);
    toast('Сохранено. Бот подхватит изменения в течение 5 минут', 'ok');
    render();
  }).catch(() => {});
}

/* ------------------------------------------------------ редактор одной формы */

function editForm(index) {
  const form = index === null
    ? {
        id: '',
        title: '',
        description: '',
        emoji: '',
        buttonLabel: '',
        buttonStyle: 'primary',
        enabled: true,
        staffRoleIds: [],
        viewerRoleIds: [],
        questions: [],
        texts: { opened: '', claimed: 'Обращение взял {staff}.', closed: 'Обращение закрыто.' }
      }
    : JSON.parse(JSON.stringify(config.forms[index]));

  const questionRow = (q, i) => `
    <tr data-q="${i}">
      <td><input data-k="label" value="${esc(q.label || '')}" placeholder="Ваш ник"></td>
      <td><input data-k="placeholder" value="${esc(q.placeholder || '')}" placeholder="подсказка"></td>
      <td style="text-align:center"><input type="checkbox" data-k="required" ${q.required !== false ? 'checked' : ''}></td>
      <td style="text-align:center"><input type="checkbox" data-k="long" ${q.long ? 'checked' : ''}></td>
      <td><button class="btn btn-sm btn-ghost" data-qdel="${i}">${icon('trash')}</button></td>
    </tr>`;

  const m = modal({
    title: index === null ? 'Новая форма обращения' : `Форма «${form.title}»`,
    subtitle: 'Так это увидит игрок в Discord',
    icon: 'file',
    wide: true,
    body: `
      <div class="form-grid">
        <div class="field"><label>Название</label>
            <input id="f-title" value="${esc(form.title)}" placeholder="Жалоба на игрока"></div>
        <div class="field"><label>Эмодзи</label>
            <input id="f-emoji" value="${esc(form.emoji)}" placeholder="🚨"></div>
        <div class="field"><label>Описание (видно в панели с кнопками)</label>
            <input id="f-description" value="${esc(form.description)}" placeholder="Читерство, нарушение правил"></div>
        <div class="field"><label>Надпись на кнопке</label>
            <input id="f-buttonLabel" value="${esc(form.buttonLabel)}" placeholder="Пожаловаться"></div>
        <div class="field"><label>Цвет кнопки</label>
            <select id="f-buttonStyle">
            ${Object.entries(STYLE_LABEL)
              .map(([v, t]) => `<option value="${v}" ${form.buttonStyle === v ? 'selected' : ''}>${t}</option>`)
              .join('')}
          </select></div>
        <div class="field"><label>Роли поддержки (ID через запятую)</label>
            <input id="f-staffRoleIds" value="${esc(form.staffRoleIds.join(', '))}" placeholder="пусто — общие роли"></div>
        <div class="field"><label>Роли-наблюдатели (ID)</label>
            <input id="f-viewerRoleIds" value="${esc(form.viewerRoleIds.join(', '))}"></div>
      </div>
      <label class="switch" style="margin-top:14px"><input type="checkbox" id="f-enabled" ${form.enabled ? 'checked' : ''}>
        <span class="track"></span><span class="switch-text">Форма включена (кнопка видна в Discord)</span></label>

      <h4 style="margin:18px 0 6px">Вопросы при нажатии</h4>
      <div class="dim" style="font-size:12px;margin-bottom:8px">
        Discord показывает не больше пяти полей в одном окне. Без вопросов ветка откроется сразу.
      </div>
      <table class="data">
        <thead><tr><th>Вопрос</th><th>Подсказка</th><th>Обязательный</th><th>Много текста</th><th></th></tr></thead>
        <tbody id="f-questions">${form.questions.map(questionRow).join('')}</tbody>
      </table>
      <button class="btn btn-sm" id="f-qadd">${icon('plus')} Добавить вопрос</button>

      <h4 style="margin:18px 0 6px">Тексты</h4>
      <div class="form-grid one">
      <div class="field"><label>Когда обращение открыто</label>
            <textarea id="f-opened" rows="2">${esc(form.texts.opened)}</textarea></div>
      <div class="field"><label>Когда нажали «взять тикет» — {staff} заменится на сотрудника</label>
            <textarea id="f-claimed" rows="2">${esc(form.texts.claimed)}</textarea></div>
      <div class="field"><label>Когда обращение закрыто</label>
            <textarea id="f-closed" rows="2">${esc(form.texts.closed)}</textarea></div>
      </div>`,
    footer: `
      <button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-primary" id="f-save">${icon('check')} Сохранить форму</button>`,
    onMount: (dialog) => {
      const body = dialog.body;
      const tbody = body.querySelector('#f-questions');

      const bindDelete = () =>
        tbody.querySelectorAll('[data-qdel]').forEach((btn) =>
          btn.addEventListener('click', () => {
            btn.closest('tr').remove();
          })
        );
      bindDelete();

      body.querySelector('#f-qadd').addEventListener('click', () => {
        if (tbody.children.length >= 5) {
          toast('Больше пяти вопросов Discord в одном окне не покажет', 'warn');
          return;
        }
        tbody.insertAdjacentHTML('beforeend', questionRow({ required: true }, tbody.children.length));
        bindDelete();
      });

      dialog.footer.querySelector('#f-save').addEventListener('click', async () => {
        const val = (id) => body.querySelector(`#f-${id}`).value.trim();

        const questions = [...tbody.querySelectorAll('tr')].map((tr, i) => ({
          id: `q${i + 1}`,
          label: tr.querySelector('[data-k="label"]').value.trim(),
          placeholder: tr.querySelector('[data-k="placeholder"]').value.trim(),
          required: tr.querySelector('[data-k="required"]').checked,
          long: tr.querySelector('[data-k="long"]').checked
        })).filter((q) => q.label);

        const next = {
          id: form.id || val('title'),
          title: val('title'),
          description: val('description'),
          emoji: val('emoji'),
          buttonLabel: val('buttonLabel') || val('title'),
          buttonStyle: val('buttonStyle'),
          enabled: body.querySelector('#f-enabled').checked,
          staffRoleIds: val('staffRoleIds').split(/[\s,;]+/).filter(Boolean),
          viewerRoleIds: val('viewerRoleIds').split(/[\s,;]+/).filter(Boolean),
          questions,
          texts: { opened: val('opened'), claimed: val('claimed'), closed: val('closed') }
        };

        if (!next.title) {
          toast('Без названия форму не сохранить', 'warn');
          return;
        }

        const forms = [...config.forms];
        if (index === null) forms.push(next);
        else forms[index] = next;

        dialog.close();
        await save({ forms }, null);
      });
    }
  });

  return m;
}

/* --------------------------------------------------------- одно обращение */

async function openTicket(id, editable) {
  let data;
  try {
    data = await api.ticket(id);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }

  const t = data.ticket;
  const form = data.form || { questions: [] };

  const answers = form.questions.length
    ? form.questions
        .map((q) => `<div class="field"><label>${esc(q.label)}</label><div>${esc(t.answers[q.id] || '—')}</div></div>`)
        .join('')
    : Object.entries(t.answers)
        .map(([k, v]) => `<div class="field"><label>${esc(k)}</label><div>${esc(v)}</div></div>`)
        .join('') || '<div class="dim">Вопросов в форме не было.</div>';

  const transcript = t.transcript.length
    ? t.transcript
        .map(
          (m) => `<div style="margin-bottom:8px">
            <div class="dim" style="font-size:11.5px">${esc(m.author)} · ${fmtDate(m.ts)}</div>
            <div>${esc(m.text)}</div></div>`
        )
        .join('')
    : '<div class="dim">Переписки пока нет. Она копится, пока люди пишут в ветке.</div>';

  modal({
    title: `№${t.number} · ${t.formTitle}`,
    subtitle: `${t.discordTag || t.discordId} · ${STATUS_LABEL[t.status]}${t.claimedByTag ? ` · взял ${t.claimedByTag}` : ''}`,
    icon: 'file',
    wide: true,
    body: `
      ${answers}
      <h4 style="margin:16px 0 8px">Переписка (${t.transcript.length})</h4>
      <div style="max-height:320px;overflow:auto">${transcript}</div>
      ${t.closeReason ? `<div class="dim" style="margin-top:12px">Итог: ${esc(t.closeReason)}</div>` : ''}`,
    footer: editable && t.status !== 'closed'
      ? `<button class="btn btn-ghost" data-close>Закрыть окно</button>
         <button class="btn" id="t-claim">Взять в работу</button>
         <button class="btn btn-danger" id="t-close">Закрыть обращение</button>`
      : '<button class="btn btn-ghost" data-close>Закрыть окно</button>',
    onMount: (dialog) => {
      const claim = dialog.footer.querySelector('#t-claim');
      if (claim) {
        claim.addEventListener('click', async () => {
          try {
            await api.claimTicket(t.id);
            toast('Обращение за вами', 'ok');
            dialog.close();
            loadList();
          } catch (err) {
            toast(err.message, 'err');
          }
        });
      }

      const closeBtn = dialog.footer.querySelector('#t-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => askReason(t, dialog));
      }
    }
  });
}

/** Окно с итогом разбора: его увидит автор обращения. */
function askReason(ticket, parent) {
  modal({
    title: `Закрыть обращение №${ticket.number}`,
    subtitle: 'Итог увидит автор — в Discord и здесь',
    icon: 'check',
    body: `<div class="form-grid one">
      ${field('Итог разбора', '<textarea id="tk-reason" rows="3" placeholder="что сделали или почему отказали"></textarea>')}
    </div>`,
    footer: `<button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-danger" id="tk-do-close">Закрыть обращение</button>`,
    onMount: (dialog) => {
      dialog.footer.querySelector('#tk-do-close').addEventListener('click', async (e) => {
        const reason = dialog.body.querySelector('#tk-reason').value.trim();

        await busy(e.currentTarget, async () => {
          await api.closeTicket(ticket.id, reason);
          toast('Обращение закрыто', 'ok');
          dialog.close();
          parent.close();
          loadList();
        }).catch(() => {});
      });
    }
  });
}
