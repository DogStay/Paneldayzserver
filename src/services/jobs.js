'use strict';

/**
 * Реестр длительных операций (установка сервера, загрузка модов, обновление).
 *
 * HTTP-запрос не ждёт окончания такой операции: он сразу возвращает job.id,
 * а прогресс приходит в браузер через SSE событиями 'job'. Благодаря этому
 * интерфейс показывает живой прогресс-бар и не отваливается по таймауту.
 */

const crypto = require('crypto');

const bus = require('../events');
const logger = require('../logger');

const jobs = new Map();
const MAX_KEPT = 40;

function emit(job) {
  bus.emit('job', publicJob(job));
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    serverId: job.serverId || null,
    status: job.status,
    progress: job.progress,
    step: job.step,
    total: job.total,
    done: job.done,
    error: job.error,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    cancellable: Boolean(job.onCancel)
  };
}

/**
 * @param {{type: string, title: string, serverId?: string, total?: number, onCancel?: Function}} opts
 */
function create(opts) {
  const job = {
    id: `job_${crypto.randomBytes(5).toString('hex')}`,
    type: opts.type,
    title: opts.title,
    serverId: opts.serverId || null,
    status: 'running',
    progress: 0,
    step: opts.step || 'Запуск…',
    total: opts.total || 0,
    done: 0,
    error: null,
    result: null,
    startedAt: Date.now(),
    finishedAt: null,
    onCancel: opts.onCancel || null
  };

  jobs.set(job.id, job);
  prune();
  logger.info('panel', `Задача «${job.title}» запущена`, { jobId: job.id, serverId: job.serverId });
  emit(job);
  return job;
}

/** Обновить прогресс. progress — 0..100. */
function update(id, patch = {}) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return null;

  if (patch.progress !== undefined) job.progress = Math.max(0, Math.min(100, Math.round(patch.progress)));
  if (patch.step !== undefined) job.step = patch.step;
  if (patch.total !== undefined) job.total = patch.total;
  if (patch.done !== undefined) job.done = patch.done;

  emit(job);
  return job;
}

function finish(id, result = null, step = 'Готово') {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'done';
  job.progress = 100;
  job.step = step;
  job.result = result;
  job.finishedAt = Date.now();
  job.onCancel = null;
  logger.info('panel', `Задача «${job.title}» завершена`, { jobId: job.id, serverId: job.serverId });
  emit(job);
  return job;
}

function fail(id, err) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'failed';
  job.error = err && err.message ? err.message : String(err);
  job.step = 'Ошибка';
  job.finishedAt = Date.now();
  job.onCancel = null;
  logger.error('panel', `Задача «${job.title}» провалилась: ${job.error}`, {
    jobId: job.id,
    serverId: job.serverId
  });
  emit(job);
  return job;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  if (!job.onCancel) return false;
  try {
    job.onCancel();
  } catch (err) {
    logger.warn('panel', `Отмена задачи «${job.title}»: ${err.message}`);
  }
  job.status = 'cancelled';
  job.step = 'Отменено';
  job.finishedAt = Date.now();
  emit(job);
  return true;
}

const get = (id) => {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
};

const list = () => [...jobs.values()].map(publicJob).sort((a, b) => b.startedAt - a.startedAt);

/** Активные задачи — нужны интерфейсу при перезагрузке страницы. */
const active = () => list().filter((j) => j.status === 'running');

function prune() {
  if (jobs.size <= MAX_KEPT) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  while (jobs.size > MAX_KEPT && finished.length) jobs.delete(finished.shift().id);
}

/**
 * Обёртка: создаёт задачу, запускает асинхронную работу и сама закрывает
 * задачу по её итогу. Возвращает job сразу, не дожидаясь завершения.
 */
function run(opts, worker) {
  const job = create(opts);

  Promise.resolve()
    .then(() => worker(job))
    .then((result) => {
      if (jobs.get(job.id) && jobs.get(job.id).status === 'running') finish(job.id, result);
    })
    .catch((err) => {
      if (jobs.get(job.id) && jobs.get(job.id).status === 'running') fail(job.id, err);
    });

  return publicJob(job);
}

module.exports = { create, update, finish, fail, cancel, get, list, active, run };
