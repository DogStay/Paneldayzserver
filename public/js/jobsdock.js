/**
 * Плашки текущих задач в правом нижнем углу: установка сервера,
 * загрузка модов, запуск. Показывают живой прогресс и позволяют отменить
 * длительную операцию.
 */

import { api } from './api.js';
import { on, state } from './store.js';
import { el, esc, icon, toast } from './ui.js';

const cards = new Map();
let dock = null;

export function initJobsDock() {
  dock = el('<div class="job-dock" id="job-dock"></div>');
  document.body.appendChild(dock);

  for (const job of state.jobs.values()) upsert(job);
  on('job', upsert);
}

function upsert(job) {
  if (job.status === 'running') {
    const card = cards.get(job.id) || create(job);
    update(card, job);
    return;
  }

  const card = cards.get(job.id);

  // Задача могла упасть раньше, чем браузер увидел её «running» — карточки
  // тогда нет, но молчать об ошибке нельзя.
  if (!card) {
    if (job.status === 'failed') toast(`${job.title}: ${job.error}`, 'err', 14000);
    return;
  }

  update(card, job);
  if (job.status === 'done') toast(`${job.title}: готово`, 'ok');
  else if (job.status === 'failed') toast(`${job.title}: ${job.error}`, 'err', 14000);

  // Успешные плашки убираем быстро, проваленные держим дольше — чтобы прочитали.
  setTimeout(() => remove(job.id), job.status === 'done' ? 2600 : 9000);
}

function create(job) {
  const card = el(`
    <div class="job-card" data-id="${job.id}">
      <div class="jt">
        <span class="spinner"></span>
        <span class="nm" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${esc(job.title)}</span>
        ${job.cancellable ? `<button class="btn btn-sm btn-ghost btn-icon" data-cancel title="Отменить">${icon('x')}</button>` : ''}
      </div>
      <div class="js"></div>
      <div class="progress"><div class="bar"></div></div>
      <div class="jp"><span class="step-pct">0%</span><span class="tail"></span></div>
    </div>`);

  const cancel = card.querySelector('[data-cancel]');
  if (cancel) {
    cancel.addEventListener('click', async () => {
      try {
        await api.cancelJob(job.id);
        toast('Операция отменяется…', 'warn');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  dock.appendChild(card);
  cards.set(job.id, card);
  return card;
}

function update(card, job) {
  card.querySelector('.js').textContent = job.status === 'failed' ? job.error || 'Ошибка' : job.step;
  card.querySelector('.bar').style.width = `${job.progress}%`;
  card.querySelector('.step-pct').textContent = `${job.progress}%`;

  const spinner = card.querySelector('.spinner');
  if (job.status !== 'running' && spinner) {
    const mark = job.status === 'done' ? icon('check') : icon('alert');
    spinner.outerHTML = `<span style="color:var(--${job.status === 'done' ? 'acc' : 'danger'});display:grid">${mark}</span>`;
  }

  const bar = card.querySelector('.progress');
  if (job.status === 'failed') bar.classList.add('info');

  const cancel = card.querySelector('[data-cancel]');
  if (cancel && job.status !== 'running') cancel.remove();
}

function remove(id) {
  const card = cards.get(id);
  if (!card) return;
  card.classList.add('closing');
  setTimeout(() => card.remove(), 250);
  cards.delete(id);
}
