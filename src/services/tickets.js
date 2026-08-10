'use strict';

/**
 * Обращения (тикеты): настройка и учёт.
 *
 * Вся настройка живёт здесь, а не в коде бота: владелец меняет тексты, кнопки,
 * роли и вопросы в панели, бот читает это по API и перерисовывает свои кнопки.
 * Поэтому «добавить ещё одну кнопку» — правка в панели, а не правка бота.
 *
 * Что описывает форма (тип обращения):
 *   - какую кнопку показать в канале (надпись, эмодзи, цвет);
 *   - что спросить при нажатии (поля модального окна);
 *   - кто видит обращение (роли) и кто может его взять (роли поддержки);
 *   - что написать при открытии, при «взять» и при закрытии.
 *
 * Учёт: каждое обращение — запись со ссылкой на ветку Discord, ответами на
 * вопросы и перепиской. Переписка нужна, чтобы обращение можно было прочитать в
 * панели и на сайте, когда ветка уже заархивирована.
 *
 * Хранение — файл data/tickets.json. Записей тут тысячи, а не миллионы, и панель
 * обязана работать без базы, поэтому файл, а не MySQL. Запись атомарная
 * (tmp + rename): при падении посреди записи файл не остаётся обрезанным.
 */

const fs = require('fs');
const path = require('path');

const logger = require('./../logger');
const bus = require('./../events');

const SOURCE = 'tickets';

const FILE = path.join(__dirname, '..', '..', 'data', 'tickets.json');

/** Сколько сообщений переписки храним на обращение. */
const MAX_TRANSCRIPT = 500;

/** Сколько закрытых обращений держим в файле. */
const MAX_CLOSED = 2000;

const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'];

const STATUSES = ['open', 'claimed', 'closed'];

/**
 * Формы по умолчанию: то, что нужно почти любому серверу.
 *
 * Владелец их переименует или удалит, но пустой список на первом запуске — это
 * «кнопок нет и непонятно, что делать», поэтому даём рабочий пример.
 */
const DEFAULT_FORMS = [
  {
    id: 'help',
    title: 'Вопрос администрации',
    description: 'Общий вопрос: правила, доступ, что-то не работает.',
    emoji: '❓',
    buttonLabel: 'Задать вопрос',
    buttonStyle: 'primary',
    questions: [
      { id: 'nick', label: 'Ваш ник на сервере', placeholder: 'как вас видно в игре', required: true, long: false },
      { id: 'text', label: 'Что случилось', placeholder: 'опишите подробно', required: true, long: true }
    ],
    texts: {
      opened: 'Спасибо за обращение. Администрация ответит здесь. Пока опишите всё, что важно.',
      claimed: 'Обращение взял {staff}. Дальше отвечает он.',
      closed: 'Обращение закрыто. Если вопрос вернётся — откройте новое.'
    }
  },
  {
    id: 'report',
    title: 'Жалоба на игрока',
    description: 'Читерство, недопустимое поведение, нарушение правил.',
    emoji: '🚨',
    buttonLabel: 'Пожаловаться',
    buttonStyle: 'danger',
    questions: [
      { id: 'nick', label: 'Ваш ник', placeholder: '', required: true, long: false },
      { id: 'suspect', label: 'На кого жалоба', placeholder: 'ник или Steam ID', required: true, long: false },
      { id: 'when', label: 'Когда это было', placeholder: 'дата и примерное время', required: true, long: false },
      { id: 'text', label: 'Что произошло', placeholder: 'подробно, по шагам', required: true, long: true },
      { id: 'proof', label: 'Доказательства', placeholder: 'ссылки на видео или скриншоты', required: false, long: true }
    ],
    texts: {
      opened: 'Жалоба принята. Пришлите доказательства сюда — видео или скриншоты.',
      claimed: 'Жалобу разбирает {staff}.',
      closed: 'Жалоба закрыта. Итог разбора выше.'
    }
  }
];

let store = null;

/* ------------------------------------------------------------------ хранение */

function empty() {
  return {
    settings: {
      // Канал, в котором бот держит кнопки. Пусто — берётся ticketChannelId из
      // настроек Discord, чтобы не заполнять одно и то же дважды.
      channelId: '',
      panelTitle: 'Обращение к администрации',
      panelText:
        'Выберите, с чем вы пришли. Откроется приватная ветка — её видите только вы и администрация.',
      // Роли, которые видят все обращения (общая поддержка).
      staffRoleIds: [],
      viewerRoleIds: [],
      claimLabel: 'Взять тикет',
      closeLabel: 'Закрыть',
      // Закрытую ветку можно удалять, но по умолчанию она остаётся историей.
      deleteOnClose: false,
      autoArchiveMinutes: 1440,
      // Сколько открытых обращений разрешено одному человеку одновременно.
      maxOpenPerUser: 1
    },
    // Через normalizeForm, а не как есть: иначе у форм по умолчанию не будет
    // полей вроде staffRoleIds, и панель падёт на первом же открытии вкладки.
    forms: DEFAULT_FORMS.map(normalizeForm),
    tickets: [],
    seq: 0
  };
}

function load(force = false) {
  if (store && !force) return store;

  try {
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    store = normalize(stored);
  } catch (_) {
    store = empty();
  }

  return store;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    logger.error(SOURCE, `Обращения не сохранены: ${err.message}`);
  }
}

/* --------------------------------------------------------------- нормализация */

const text = (value, fallback = '', limit = 2000) => {
  const out = String(value === undefined || value === null ? fallback : value);
  return out.slice(0, limit);
};

const ids = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map((v) => String(v).trim()).filter((v) => /^\d{5,32}$/.test(v)))];

function slug(value, fallback) {
  const out = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return out || fallback;
}

function normalizeQuestion(raw, index) {
  return {
    id: slug(raw.id, `q${index + 1}`),
    label: text(raw.label, `Вопрос ${index + 1}`, 45),
    placeholder: text(raw.placeholder, '', 100),
    required: raw.required !== false,
    long: Boolean(raw.long)
  };
}

function normalizeForm(raw, index) {
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    // Discord показывает в одном окне не больше пяти полей — обрезаем здесь,
    // иначе бот получит форму, которую Discord откажется открывать.
    .slice(0, 5)
    .map(normalizeQuestion);

  return {
    id: slug(raw.id, `form${index + 1}`),
    title: text(raw.title, `Обращение ${index + 1}`, 80),
    description: text(raw.description, '', 300),
    emoji: text(raw.emoji, '', 8),
    buttonLabel: text(raw.buttonLabel, text(raw.title, 'Создать обращение', 40), 40),
    buttonStyle: BUTTON_STYLES.includes(raw.buttonStyle) ? raw.buttonStyle : 'primary',
    enabled: raw.enabled !== false,
    // Свои роли формы: например, жалобы видит только модерация.
    staffRoleIds: ids(raw.staffRoleIds),
    viewerRoleIds: ids(raw.viewerRoleIds),
    questions,
    texts: {
      opened: text((raw.texts || {}).opened, 'Опишите вопрос одним сообщением.', 1500),
      claimed: text((raw.texts || {}).claimed, 'Обращение взял {staff}.', 500),
      closed: text((raw.texts || {}).closed, 'Обращение закрыто.', 500)
    }
  };
}

function normalizeTicket(raw) {
  return {
    id: text(raw.id, '', 32),
    number: Number(raw.number) || 0,
    formId: text(raw.formId, '', 32),
    formTitle: text(raw.formTitle, '', 80),
    discordId: text(raw.discordId, '', 32),
    discordTag: text(raw.discordTag, '', 64),
    guildId: text(raw.guildId, '', 32),
    channelId: text(raw.channelId, '', 32),
    threadId: text(raw.threadId, '', 32),
    status: STATUSES.includes(raw.status) ? raw.status : 'open',
    answers: raw.answers && typeof raw.answers === 'object' ? raw.answers : {},
    claimedBy: text(raw.claimedBy, '', 32),
    claimedByTag: text(raw.claimedByTag, '', 64),
    claimedAt: Number(raw.claimedAt) || 0,
    openedAt: Number(raw.openedAt) || Date.now(),
    closedAt: Number(raw.closedAt) || 0,
    closedBy: text(raw.closedBy, '', 64),
    closeReason: text(raw.closeReason, '', 500),
    transcript: (Array.isArray(raw.transcript) ? raw.transcript : []).slice(-MAX_TRANSCRIPT).map((m) => ({
      ts: Number(m.ts) || 0,
      author: text(m.author, '', 64),
      authorId: text(m.authorId, '', 32),
      text: text(m.text, '', 2000)
    }))
  };
}

function normalize(raw) {
  const base = empty();
  const s = raw && typeof raw === 'object' ? raw : {};
  const settings = { ...base.settings, ...(s.settings || {}) };

  return {
    settings: {
      channelId: text(settings.channelId, '', 32),
      panelTitle: text(settings.panelTitle, base.settings.panelTitle, 100),
      panelText: text(settings.panelText, base.settings.panelText, 1500),
      staffRoleIds: ids(settings.staffRoleIds),
      viewerRoleIds: ids(settings.viewerRoleIds),
      claimLabel: text(settings.claimLabel, 'Взять тикет', 40),
      closeLabel: text(settings.closeLabel, 'Закрыть', 40),
      deleteOnClose: Boolean(settings.deleteOnClose),
      autoArchiveMinutes: [60, 1440, 4320, 10080].includes(Number(settings.autoArchiveMinutes))
        ? Number(settings.autoArchiveMinutes)
        : 1440,
      maxOpenPerUser: Math.min(Math.max(Number(settings.maxOpenPerUser) || 1, 1), 10)
    },
    // Формы без кнопки бессмысленны, но пустой список — это осознанный выбор
    // владельца («обращения выключены»), поэтому не подставляем стандартные.
    forms: (Array.isArray(s.forms) ? s.forms : base.forms).map(normalizeForm),
    tickets: (Array.isArray(s.tickets) ? s.tickets : []).map(normalizeTicket),
    seq: Number(s.seq) || 0
  };
}

/* ---------------------------------------------------------------- настройка */

/** Настройка целиком — её читает бот и экран панели. */
function config() {
  const s = load();
  return { settings: s.settings, forms: s.forms };
}

/**
 * Сохранить настройку. Частично: пришло только `forms` — настройки не тронуты.
 */
function saveConfig(patch = {}) {
  const s = load();

  if (patch.settings) s.settings = normalize({ settings: { ...s.settings, ...patch.settings } }).settings;
  if (Array.isArray(patch.forms)) s.forms = patch.forms.map(normalizeForm);

  // Две формы с одним id — это две кнопки, которые бот не различит.
  const seen = new Set();
  s.forms = s.forms.map((form, index) => {
    let id = form.id;
    while (seen.has(id)) id = `${form.id}-${index + 1}`;
    seen.add(id);
    return { ...form, id };
  });

  persist();
  bus.emit('tickets');
  logger.info(SOURCE, `Настройка обращений сохранена: форм ${s.forms.length}`);

  return config();
}

/* ------------------------------------------------------------------ записи */

function openOf(discordId) {
  return load().tickets.filter((t) => t.discordId === String(discordId) && t.status !== 'closed');
}

/**
 * Открыть обращение. Зовёт бот, когда человек заполнил форму.
 *
 * Ветку в Discord создаёт бот (только он умеет), поэтому её id приходит сюда
 * вторым шагом — `attachThread`. Запись создаётся до ветки: если бот упадёт
 * между шагами, обращение не потеряется и будет видно в панели.
 */
function create(data = {}) {
  const s = load();
  const form = s.forms.find((f) => f.id === String(data.formId)) || null;
  if (!form) throw new Error(`форма «${data.formId}» не найдена`);
  if (!form.enabled) throw new Error(`форма «${form.title}» выключена`);

  const already = openOf(data.discordId);
  if (already.length >= s.settings.maxOpenPerUser) {
    const err = new Error(
      `у вас уже есть открытое обращение (${already.length}). Дождитесь ответа или закройте прежнее`
    );
    err.tickets = already.map((t) => ({ id: t.id, number: t.number, threadId: t.threadId }));
    throw err;
  }

  s.seq += 1;
  const ticket = normalizeTicket({
    id: `t${s.seq.toString(36)}${Date.now().toString(36).slice(-4)}`,
    number: s.seq,
    formId: form.id,
    formTitle: form.title,
    discordId: data.discordId,
    discordTag: data.discordTag,
    guildId: data.guildId,
    channelId: data.channelId,
    answers: data.answers,
    status: 'open',
    openedAt: Date.now()
  });

  s.tickets.push(ticket);
  persist();
  bus.emit('tickets');
  logger.info(SOURCE, `Обращение №${ticket.number} («${form.title}») от ${ticket.discordTag || ticket.discordId}`);

  return { ticket, form, settings: s.settings };
}

function byId(id) {
  return load().tickets.find((t) => t.id === String(id)) || null;
}

function byThread(threadId) {
  return load().tickets.find((t) => t.threadId === String(threadId)) || null;
}

/** Привязать созданную ветку Discord к записи. */
function attachThread(id, threadId) {
  const ticket = byId(id);
  if (!ticket) throw new Error('обращение не найдено');

  ticket.threadId = String(threadId || '');
  persist();
  bus.emit('tickets');
  return ticket;
}

/** Взять обращение в работу. */
function claim(id, staff = {}) {
  const ticket = byId(id);
  if (!ticket) throw new Error('обращение не найдено');
  if (ticket.status === 'closed') throw new Error('обращение уже закрыто');
  if (ticket.claimedBy && ticket.claimedBy !== String(staff.id || '')) {
    throw new Error(`обращение уже взял ${ticket.claimedByTag || ticket.claimedBy}`);
  }

  ticket.status = 'claimed';
  ticket.claimedBy = String(staff.id || '');
  ticket.claimedByTag = String(staff.tag || '');
  ticket.claimedAt = Date.now();

  persist();
  bus.emit('tickets');
  logger.info(SOURCE, `Обращение №${ticket.number} взял ${ticket.claimedByTag || ticket.claimedBy}`);

  return ticket;
}

function close(id, data = {}) {
  const ticket = byId(id);
  if (!ticket) throw new Error('обращение не найдено');

  ticket.status = 'closed';
  ticket.closedAt = Date.now();
  ticket.closedBy = String(data.by || '');
  ticket.closeReason = String(data.reason || '').slice(0, 500);

  // Старые закрытые убираем, чтобы файл не рос без предела. Открытые не трогаем
  // никогда: обращение без ответа терять нельзя.
  const s = load();
  const closed = s.tickets.filter((t) => t.status === 'closed').sort((a, b) => a.closedAt - b.closedAt);
  if (closed.length > MAX_CLOSED) {
    const extra = new Set(closed.slice(0, closed.length - MAX_CLOSED).map((t) => t.id));
    s.tickets = s.tickets.filter((t) => !extra.has(t.id));
  }

  persist();
  bus.emit('tickets');
  logger.info(SOURCE, `Обращение №${ticket.number} закрыто (${ticket.closedBy || 'без автора'})`);

  return ticket;
}

/**
 * Дописать сообщение в переписку.
 *
 * Так обращение читается в панели даже после архивации ветки — Discord её
 * когда-нибудь свернёт, а разбор жалобы может понадобиться месяцем позже.
 */
function addMessage(threadId, message = {}) {
  const ticket = byThread(threadId);
  if (!ticket) return null;

  ticket.transcript.push({
    ts: Number(message.ts) || Date.now(),
    author: String(message.author || '').slice(0, 64),
    authorId: String(message.authorId || '').slice(0, 32),
    text: String(message.text || '').slice(0, 2000)
  });

  if (ticket.transcript.length > MAX_TRANSCRIPT) ticket.transcript = ticket.transcript.slice(-MAX_TRANSCRIPT);

  persist();
  return ticket;
}

/** Список для панели и сайта. Переписка в список не попадает — она тяжёлая. */
function list(query = {}) {
  const s = load();
  const status = String(query.status || '').trim();
  const formId = String(query.formId || '').trim();
  const search = String(query.search || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 1000);

  const filtered = s.tickets
    .filter((t) => (status ? t.status === status : true))
    .filter((t) => (formId ? t.formId === formId : true))
    .filter((t) => {
      if (!search) return true;
      const haystack = [t.discordTag, t.discordId, t.formTitle, String(t.number), ...Object.values(t.answers)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(search);
    })
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, limit)
    .map(({ transcript, ...rest }) => ({ ...rest, messages: transcript.length }));

  return {
    tickets: filtered,
    counts: {
      total: s.tickets.length,
      open: s.tickets.filter((t) => t.status === 'open').length,
      claimed: s.tickets.filter((t) => t.status === 'claimed').length,
      closed: s.tickets.filter((t) => t.status === 'closed').length
    },
    forms: s.forms.map((f) => ({ id: f.id, title: f.title }))
  };
}

/** Что боту нужно, чтобы нарисовать кнопки: настройка + открытые обращения. */
function botView() {
  const s = load();
  return {
    settings: s.settings,
    forms: s.forms.filter((f) => f.enabled),
    open: s.tickets
      .filter((t) => t.status !== 'closed')
      .map((t) => ({ id: t.id, number: t.number, formId: t.formId, discordId: t.discordId, threadId: t.threadId, status: t.status }))
  };
}

module.exports = {
  FILE,
  BUTTON_STYLES,
  DEFAULT_FORMS,
  config,
  saveConfig,
  create,
  attachThread,
  claim,
  close,
  addMessage,
  byId,
  byThread,
  list,
  botView,
  load
};
