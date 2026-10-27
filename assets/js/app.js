// Инициализация страницы: шапка, прайс из Google Таблицы, связь с формой и демо-панелью.
import {
  parseCSV, normalizeRows, filterPrices, groupByModel, formatPrice, countByTab, parsePrice,
} from './prices.js';
import {
  formatPhone, validateLead, spamReason, buildPayload, makeLeadId, issueForService, submitLead,
} from './leads.js';
import { initDemoSheet } from './demo-sheet.js';

const CONFIG = { PRICES_CSV_URL: '', LEADS_ENDPOINT: '', DEMO_MODE: true, ...(window.FIXLAB_CONFIG || {}) };
const params = new URLSearchParams(location.search);

const $ = (sel, root = document) => root.querySelector(sel);
// Плавная прокрутка из JS — только если пользователь не просил меньше движения
const scrollBehavior = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const icon = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/** Экранирование: тексты из таблицы — внешние данные, вставляем только как текст. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const safeStorage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/* ---------------- Шапка и меню ---------------- */
function initHeader() {
  const header = $('[data-header]');
  const burger = $('[data-burger]');
  const nav = $('[data-nav]');
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    burger.querySelector('use').setAttribute('href', open ? '#i-close' : '#i-menu');
  };
  burger.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) { setOpen(false); burger.focus(); }
  });
}

/* ---------------- Хранилище прайса ----------------
   base — цены из таблицы; overrides — правки цен из демо-панели (только DEMO_MODE).
   Подписчики (рендер прайса, демо-панель) получают событие 'change'. */
const CACHE_KEY = 'fixlab:prices-cache';
const OVERRIDES_KEY = 'fixlab:demo-price-overrides';

// Класс, а не Object.assign: геттер items должен вычисляться при каждом обращении
class PriceStore extends EventTarget {
  base = [];
  overrides = CONFIG.DEMO_MODE ? (safeStorage.get(OVERRIDES_KEY) || {}) : {};
  loadedAt = null;
  status = 'loading'; // loading | ok | stale | error

  get items() {
    return this.base.map((item) => (Object.hasOwn(this.overrides, item.id)
      ? { ...item, price: this.overrides[item.id] } : item));
  }
  setBase(items, loadedAt, status) {
    this.base = items;
    this.loadedAt = loadedAt;
    this.status = status;
    this.emit({ reason: 'load' });
  }

  /** Правка цены из демо-панели: value — число или строка из ячейки. */
  setPrice(id, value) {
    const price = parsePrice(value);
    const current = this.items.find((i) => i.id === id);
    if (!current || current.price === price) return false;
    this.overrides = { ...this.overrides, [id]: price };
    safeStorage.set(OVERRIDES_KEY, this.overrides);
    this.loadedAt = new Date();
    this.emit({ reason: 'edit', changed: [id] });
    return true;
  }

  resetOverrides() {
    this.overrides = {};
    safeStorage.remove(OVERRIDES_KEY);
    this.emit({ reason: 'reset' });
  }

  emit(detail) { this.dispatchEvent(new CustomEvent('change', { detail })); }
}
export const priceStore = new PriceStore();

async function loadPrices() {
  const url = CONFIG.PRICES_CSV_URL || 'data/prices.csv';
  try {
    if (params.get('prices') === 'error') throw new Error('Имитация ошибки сети');
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const items = normalizeRows(parseCSV(text));
    if (!items.length) throw new Error('В таблице нет строк с ценами');
    const savedAt = new Date();
    safeStorage.set(CACHE_KEY, { text, savedAt: savedAt.toISOString() });
    priceStore.setBase(items, savedAt, 'ok');
  } catch (err) {
    console.warn('Не удалось загрузить цены:', err);
    // Фолбэк: последний удачный прайс из localStorage
    const cache = safeStorage.get(CACHE_KEY);
    const items = cache?.text ? normalizeRows(parseCSV(cache.text)) : [];
    if (items.length) priceStore.setBase(items, new Date(cache.savedAt), 'stale');
    else priceStore.setBase([], null, 'error');
  }
}

/* ---------------- Рендер прайса ---------------- */
const ui = { brand: params.get('brand') || 'all', query: params.get('q') || '', expanded: false };
// На телефоне во вкладке «Все» сначала показываем несколько моделей, остальные — по кнопке
const MOBILE_LIMIT = 4;
const isNarrow = () => window.matchMedia('(max-width: 640px)').matches;

function formatUpdated(date) {
  if (!date) return '';
  const now = new Date();
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = date.toDateString() === now.toDateString();
  const day = sameDay ? 'сегодня' : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `${day} в ${time}`;
}

function renderBadge(flash = false) {
  const badge = $('[data-sync-badge]');
  const text = $('[data-sync-text]');
  if (priceStore.status === 'error') {
    text.innerHTML = 'Таблица недоступна';
  } else {
    text.innerHTML = `Цены обновлены <b>${esc(formatUpdated(priceStore.loadedAt))}</b><span class="sync-src"><span class="sync-sep"> · </span>из&nbsp;Google&nbsp;Таблицы</span>`;
  }
  if (flash) {
    badge.classList.remove('is-flash');
    void badge.offsetWidth; // перезапуск CSS-анимации
    badge.classList.add('is-flash');
  }
}

function renderStatus() {
  const box = $('[data-price-status]');
  if (priceStore.status === 'stale') {
    box.className = 'price-status';
    box.innerHTML = `${icon('i-refresh')}<span>Не удалось обновить цены из таблицы — показаны сохранённые от ${esc(formatUpdated(priceStore.loadedAt))}.</span>
      <button class="btn btn-secondary btn-sm" type="button" data-retry>Обновить</button>`;
    box.hidden = false;
  } else if (priceStore.status === 'error') {
    box.className = 'price-status price-status--error';
    box.innerHTML = `${icon('i-refresh')}<span>Не удалось загрузить цены. Проверьте интернет или позвоните: +7 (900) 000-00-00 — назовём цену сразу.</span>
      <button class="btn btn-secondary btn-sm" type="button" data-retry>Повторить</button>`;
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

function renderTabs() {
  const counts = countByTab(priceStore.items);
  for (const tab of $$('[data-tabs] [role="tab"]')) {
    const selected = tab.dataset.brand === ui.brand;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    // счётчик моделей на табе
    let badge = tab.querySelector('.tab-count');
    if (!badge) { badge = document.createElement('span'); badge.className = 'tab-count'; tab.append(badge); }
    const models = groupByModel(filterPrices(priceStore.items, { brand: tab.dataset.brand })).length;
    badge.textContent = counts.all ? String(models) : '';
  }
  $('[data-price-grid]').setAttribute('aria-labelledby', $(`[data-tabs] [data-brand="${ui.brand}"]`)?.id || 'tab-all');
}

function serviceRow(item) {
  const price = formatPrice(item.price);
  const note = item.note ? `<span class="service-note">${esc(item.note)}</span>` : '';
  const duration = item.duration ? `<span>${icon('i-clock')}${esc(item.duration)}</span>` : '';
  return `<li class="service" data-id="${esc(item.id)}">
    <div>
      <p class="service-name">${esc(item.service)}</p>
      <p class="service-meta">${duration}${note}</p>
    </div>
    <span class="service-price${item.price === null ? ' service-price--request' : ''}">${price}</span>
    <button class="service-book" type="button" data-book="${esc(item.id)}"
      aria-label="Записаться: ${esc(item.service)}, ${esc(item.model)}" title="Записаться">${icon('i-arrow')}</button>
  </li>`;
}

function renderPrices(changed = []) {
  const grid = $('[data-price-grid]');
  grid.setAttribute('aria-busy', 'false');
  if (priceStore.status === 'error' && !priceStore.base.length) {
    grid.innerHTML = '';
    return;
  }
  if (changed.length) ui.expanded = true; // изменённая цена должна быть видна
  const filtered = filterPrices(priceStore.items, ui);
  const groups = groupByModel(filtered);
  if (!groups.length) {
    grid.innerHTML = `<div class="price-empty">
      <p class="h3">Ничего не нашли${ui.query ? ` по запросу «${esc(ui.query)}»` : ''}</p>
      <p>Попробуйте написать короче — например, «13» или «экран». Или оставьте заявку: подскажем цену для любой модели.</p>
      <button class="btn btn-secondary" type="button" data-reset-search>Сбросить поиск</button>
    </div>`;
    return;
  }
  const collapsed = !ui.expanded && !ui.query && ui.brand === 'all' && isNarrow() && groups.length > MOBILE_LIMIT;
  const shown = collapsed ? groups.slice(0, MOBILE_LIMIT) : groups;
  grid.innerHTML = shown.map((g) => {
    const hasChanged = g.items.some((i) => changed.includes(i.id));
    return `<article class="price-card${hasChanged ? ' is-updated' : ''}">
      <div class="price-card-head">
        <div>
          <p class="price-brand">${esc(g.brand)}</p>
          <h3 class="price-model">${esc(g.model)}</h3>
        </div>
        <span class="price-ico">${icon('i-smartphone')}</span>
      </div>
      <ul class="service-list">${g.items.map(serviceRow).join('')}</ul>
    </article>`;
  }).join('') + (collapsed
    ? `<button class="btn btn-secondary btn-lg price-more" type="button" data-show-all>Показать все модели · ${groups.length}</button>`
    : '');

  // подсветка изменённых цен + прокрутка к ним, если они вне экрана
  for (const id of changed) {
    const row = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    row.classList.add('is-updated');
    const r = row.getBoundingClientRect();
    if (document.documentElement.classList.contains('sheet-overlay')) {
      // таблица открыта шторкой снизу — строка должна оказаться в видимой верхней части
      const top = r.top + window.scrollY - document.querySelector('[data-header]').offsetHeight - 24;
      window.scrollTo({ top, behavior: scrollBehavior() });
    } else if (r.top < 80 || r.bottom > window.innerHeight) {
      row.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    }
  }
  if (changed.length) {
    clearTimeout(renderPrices.t);
    renderPrices.t = setTimeout(() => $$('.is-updated', grid).forEach((el) => el.classList.remove('is-updated')), 2800);
  }
}

function renderModelsDatalist() {
  const list = $('[data-models-list]');
  if (!list) return;
  const models = groupByModel(priceStore.items).map((g) => displayModel(g.brand, g.model));
  list.innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
}

/** «Galaxy S23» → «Samsung Galaxy S23»; «iPhone 13» остаётся как есть. */
export function displayModel(brand, model) {
  if (/^apple$/i.test(brand) || model.toLowerCase().includes(brand.toLowerCase())) return model;
  return `${brand} ${model}`;
}

function initPrices() {
  const tabs = $$('[data-tabs] [role="tab"]');
  const selectTab = (tab, focus = false) => {
    ui.brand = tab.dataset.brand;
    renderTabs();
    renderPrices();
    if (focus) tab.focus();
  };
  for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab));
  // клавиатура для ARIA tabs: стрелки, Home/End
  $('[data-tabs]').addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(tabs[(next + tabs.length) % tabs.length], true);
  });

  const search = $('[data-search]');
  search.value = ui.query;
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { ui.query = search.value; renderPrices(); }, 150);
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-reset-search]')) {
      ui.query = ''; search.value = ''; ui.brand = 'all';
      renderTabs(); renderPrices(); search.focus();
    }
    if (e.target.closest('[data-retry]')) loadPrices();
    if (e.target.closest('[data-show-all]')) { ui.expanded = true; renderPrices(); }
    const book = e.target.closest('[data-book]');
    if (book) {
      const item = priceStore.items.find((i) => i.id === book.dataset.book);
      if (item) document.dispatchEvent(new CustomEvent('fixlab:book', { detail: item }));
    }
  });

  priceStore.addEventListener('change', (e) => {
    const { reason, changed = [] } = e.detail;
    renderBadge(reason === 'edit');
    renderStatus();
    renderTabs();
    renderPrices(changed);
    if (reason === 'load') {
      renderModelsDatalist();
      // прайс вырос после загрузки — восстанавливаем прокрутку к #якорю из адреса (один раз)
      if (!initPrices.restored && location.hash.length > 1) {
        initPrices.restored = true;
        document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
      }
    }
  });
  renderTabs();
  loadPrices();
}

/* ---------------- Запись из прайса в форму ---------------- */
function initBooking() {
  document.addEventListener('fixlab:book', (e) => {
    const item = e.detail;
    const form = $('[data-lead-form]');
    if (!form) return;
    form.elements.model.value = displayModel(item.brand, item.model);
    form.elements.model.dispatchEvent(new Event('input', { bubbles: true }));
    const comment = form.elements.comment;
    if (!comment.value.trim()) comment.value = `${item.service}, ${formatPrice(item.price).replace(/ /g, ' ')}`;
    document.dispatchEvent(new CustomEvent('fixlab:prefill', { detail: item }));
    $('#lead').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    setTimeout(() => form.elements.name.focus({ preventScroll: true }), 500);
  });
}


/* ---------------- Форма заявки ---------------- */
const FIELDS = ['name', 'phone', 'model', 'issue', 'comment', 'consent'];

function initForm() {
  const form = $('[data-lead-form]');
  const card = $('[data-form-card]');
  const success = $('[data-form-success]');
  const formError = $('[data-form-error]');
  const submitBtn = $('[data-submit]');
  const submitLabel = $('[data-submit-label]');
  const { phone, issue } = form.elements;
  const touched = new Set();
  let startedAt = Date.now();

  const readData = () => ({
    name: form.elements.name.value,
    phone: phone.value,
    model: form.elements.model.value,
    issue: issue.value,
    comment: form.elements.comment.value,
    consent: form.elements.consent.checked,
    website: form.elements.website.value,
  });

  // Показ ошибки под полем + aria-invalid; only=[...] — обновить только эти поля
  const showErrors = (errors, only = FIELDS) => {
    for (const name of only) {
      const el = form.elements[name];
      const field = el.closest('.field');
      const msg = errors[name] || '';
      $(`[data-error-for="${name}"]`, form).textContent = msg;
      field.classList.toggle('is-invalid', Boolean(msg));
      field.classList.toggle('is-valid', !msg && name !== 'consent' && name !== 'comment' && Boolean(String(el.value).trim()));
      if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    }
  };

  // Маска телефона: «+7 (» появляется при фокусе, курсор всегда в конце
  phone.addEventListener('focus', () => { if (!phone.value) phone.value = '+7 ('; });
  // (маска всегда заканчивается цифрой, поэтому Backspace стирает цифру, а не разделитель)
  phone.addEventListener('input', () => { phone.value = formatPhone(phone.value); });
  phone.addEventListener('blur', () => { if (phone.value === '+7 (' || phone.value === '+7') phone.value = ''; });

  const syncSelect = () => issue.classList.toggle('is-placeholder', !issue.value);
  issue.addEventListener('change', syncSelect);
  syncSelect();

  // Живая валидация: после первого blur поле проверяется на каждый ввод
  for (const name of FIELDS) {
    const el = form.elements[name];
    const validate = () => showErrors(validateLead(readData()).errors, [name]);
    el.addEventListener('blur', () => { touched.add(name); validate(); });
    el.addEventListener(name === 'consent' || name === 'issue' ? 'change' : 'input', () => {
      if (touched.has(name)) validate();
      // «Другое» делает комментарий обязательным — перепроверяем его
      if (name === 'issue' && touched.has('comment')) showErrors(validateLead(readData()).errors, ['comment']);
    });
  }

  const setSending = (sending) => {
    submitBtn.disabled = sending;
    form.setAttribute('aria-busy', String(sending));
    submitLabel.textContent = sending ? 'Отправляем…' : 'Отправить заявку';
    const ico = submitBtn.querySelector('.icon, .spinner');
    if (sending) ico.outerHTML = '<span class="spinner" aria-hidden="true"></span>';
    else if (ico.classList.contains('spinner')) ico.outerHTML = icon('i-arrow');
  };

  const showSuccess = (payload, id) => {
    $('[data-lead-id]', success).textContent = `№ ${id}`;
    const rows = [['Имя', payload.name], ['Телефон', payload.phone], ['Модель', payload.model], ['Что случилось', payload.issue]];
    $('[data-success-summary]', success).innerHTML = rows
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
    form.hidden = true;
    success.hidden = false;
    card.classList.add('is-success');
    success.focus({ preventScroll: true });
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.hidden = true;
    const data = readData();
    const { ok, errors } = validateLead(data);
    FIELDS.forEach((f) => touched.add(f));
    showErrors(errors);
    if (!ok) {
      form.elements[FIELDS.find((f) => errors[f])].focus();
      return;
    }
    const spam = spamReason({ honeypot: data.website, startedAt });
    const payload = buildPayload(data);
    const id = makeLeadId();
    if (spam === 'honeypot') { showSuccess(payload, id); return; } // боту — «успех» без отправки
    if (spam === 'too-fast') {
      formError.textContent = 'Слишком быстро :) Проверьте данные и нажмите «Отправить» ещё раз.';
      formError.hidden = false;
      startedAt = 0; // повторная отправка человеком пройдёт
      return;
    }
    setSending(true);
    try {
      await submitLead(payload, { endpoint: CONFIG.LEADS_ENDPOINT, demo: CONFIG.DEMO_MODE });
      showSuccess(payload, id);
    } catch (err) {
      console.error(err);
      formError.textContent = 'Не получилось отправить заявку. Проверьте интернет или позвоните: +7 (900) 000-00-00.';
      formError.hidden = false;
    } finally {
      setSending(false);
    }
  });

  $('[data-form-again]').addEventListener('click', () => {
    form.reset();
    touched.clear();
    showErrors({});
    syncSelect();
    startedAt = Date.now();
    success.hidden = true;
    form.hidden = false;
    card.classList.remove('is-success');
    form.elements.name.focus();
  });

  // Запись из прайса: подставляем неисправность по услуге
  document.addEventListener('fixlab:prefill', (e) => {
    issue.value = issueForService(e.detail.service);
    syncSelect();
    if (touched.has('model')) showErrors(validateLead(readData()).errors, ['model', 'issue']);
  });

  // Состояния для скриншотов: ?form=errors и ?form=success
  if (params.get('form') === 'errors') {
    form.elements.name.value = 'А';
    phone.value = '+7 (900) 12';
    FIELDS.forEach((f) => touched.add(f));
    showErrors(validateLead(readData()).errors);
  } else if (params.get('form') === 'success') {
    showSuccess(buildPayload({
      name: 'Анна', phone: '9001234567', model: 'iPhone 13', issue: 'Разбит экран',
    }), makeLeadId());
  }
}

initHeader();
initPrices();
initBooking();
initForm();
if (CONFIG.DEMO_MODE) initDemoSheet({ store: priceStore, params });
