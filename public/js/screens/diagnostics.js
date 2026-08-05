/**
 * Вкладка «Диагностика».
 *
 * Здесь можно одной кнопкой собрать подробный отчёт о состоянии панели и
 * сервера. Файл сохраняется в корень папки панели
 * (diagnostic-report-*.txt) — его можно целиком отправить тому, кто
 * помогает разобраться, почему сервер не запускается.
 *
 * Тут же видны автоматические отчёты о сбоях (logs/crash-*.txt): панель
 * пишет их сама, если сервер упал или запуск сорвался.
 */

import { api } from '../api.js';
import { esc, icon, toast, busy, modal, confirmDialog, fmtBytes, fmtDate } from '../ui.js';

export function initDiagnosticsTab(pane) {
  pane.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('bug')}</span>
        <div><h2>Отчёт для диагностики</h2>
          <div class="card-sub">Собирает всё, что нужно для разбора проблемы, в один текстовый файл</div></div>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="diag-build">${icon('bug')} Собрать отчёт</button>
      </div>

      <div class="notice info mb"><span class="ic">${icon('info')}</span>
        <div>В отчёт попадают: версия панели и ОС, все пути и признак «файл на месте / не найден»,
        настройки серверов, список модов с их состоянием, аргументы запуска, содержимое
        <span class="inline-code">serverDZ.cfg</span> и <span class="inline-code">.bat</span>,
        последние строки логов панели и логов сервера (*.RPT, *.ADM).<br>
        <b>Пароли Steam и пароли сервера в отчёт не попадают.</b></div></div>

      <div class="notice warn"><span class="ic">${icon('alert')}</span>
        <div>Если сервер падает сам или не стартует, отчёт создаётся <b>автоматически</b> —
        искать его в папке <span class="inline-code">logs</span> рядом с панелью.</div></div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title-icon">${icon('file')}</span>
        <div><h2>Сохранённые отчёты</h2>
          <div class="card-sub">Файлы лежат в папке панели и в подпапке logs</div></div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="diag-reload">${icon('restart')} Обновить</button>
      </div>
      <div id="diag-list"></div>
    </div>`;

  pane.querySelector('#diag-build').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const report = await api.buildReport();
      toast(`Отчёт сохранён: ${report.name}`, 'ok', 9000);
      renderList(pane, report.reports);
      openReport(report.name);
    })
  );

  pane.querySelector('#diag-reload').addEventListener('click', (e) => busy(e.currentTarget, () => load(pane)));

  pane.__load = () => load(pane);
}

async function load(pane) {
  const box = pane.querySelector('#diag-list');
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    const data = await api.diagnostics();
    renderList(pane, data.reports);
  } catch (err) {
    box.innerHTML = `<div class="notice err"><span class="ic">${icon('alert')}</span><div>${esc(err.message)}</div></div>`;
  }
}

function renderList(pane, reports) {
  const box = pane.querySelector('#diag-list');

  if (!reports || !reports.length) {
    box.innerHTML = `
      <div class="empty-state">
        <div class="ic">${icon('file')}</div>
        <h3>Отчётов пока нет</h3>
        <p>Нажмите «Собрать отчёт», чтобы создать файл с полным состоянием панели и сервера.</p>
      </div>`;
    return;
  }

  box.innerHTML = `
    <table class="data">
      <thead><tr><th>Файл</th><th>Тип</th><th>Размер</th><th>Создан</th><th></th></tr></thead>
      <tbody>
        ${reports
          .map(
            (r) => `
          <tr data-name="${esc(r.name)}">
            <td class="mono small">${esc(r.name)}</td>
            <td>${r.kind === 'crash'
              ? '<span class="badge err">сбой сервера</span>'
              : '<span class="badge info">отчёт</span>'}</td>
            <td class="mono small">${fmtBytes(r.size)}</td>
            <td class="small dim">${fmtDate(r.mtime)}</td>
            <td>
              <div class="row" style="gap:6px;justify-content:flex-end">
                <button class="btn btn-sm" data-act="view">${icon('search')} Посмотреть</button>
                <a class="btn btn-sm" href="/api/diagnostics/${encodeURIComponent(r.name)}?download=1"
                   download>${icon('download')} Скачать</a>
                <button class="btn btn-sm btn-ghost btn-icon" data-act="del" title="Удалить">${icon('trash')}</button>
              </div>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <div class="hint mt">Полный путь к файлам виден в консоли логов при их создании.
      «Скачать» сохраняет файл через браузер — так его удобнее переслать.</div>`;

  box.querySelectorAll('tr[data-name]').forEach((row) => {
    const name = row.dataset.name;

    row.querySelector('[data-act="view"]').addEventListener('click', (e) =>
      busy(e.currentTarget, () => openReport(name))
    );

    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: 'Удалить отчёт?',
        message: `Файл <span class="inline-code">${esc(name)}</span> будет удалён с диска.`,
        confirmText: 'Удалить',
        danger: true
      });
      if (!yes) return;
      const data = await api.deleteReport(name);
      renderList(pane, data.reports);
      toast('Отчёт удалён', 'ok');
    });
  });
}

async function openReport(name) {
  const data = await api.readReport(name);

  modal({
    title: name,
    subtitle: `${fmtBytes(data.size)} · ${fmtDate(data.mtime)}`,
    icon: 'file',
    wide: true,
    body: `<pre class="code" style="max-height:60vh">${esc(data.content)}</pre>`,
    footer: `
      <button class="btn btn-sm" id="rep-copy">${icon('save')} Скопировать в буфер</button>
      <span class="spacer"></span>
      <a class="btn btn-sm btn-primary" href="/api/diagnostics/${encodeURIComponent(name)}?download=1" download>
        ${icon('download')} Скачать файл</a>
      <button class="btn btn-sm" data-close>Закрыть</button>`,
    onMount: (m) => {
      m.footer.querySelector('#rep-copy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(data.content);
          toast('Отчёт скопирован в буфер обмена', 'ok');
        } catch (_) {
          toast('Браузер не дал доступ к буферу — воспользуйтесь кнопкой «Скачать файл»', 'warn');
        }
      });
    }
  });
}
