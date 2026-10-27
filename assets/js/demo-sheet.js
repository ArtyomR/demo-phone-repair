// Демо-панель «Google Таблица»: показывает заказчику, как работает связка сайта с таблицей.
// Лист «Цены» — редактируемая колонка price (правка сразу меняет прайс на сайте),
// лист «Заявки» — заявки, отправленные с сайта (в демо хранятся в localStorage).
import { formatPrice, parsePrice } from './prices.js';
import { readDemoLeads, DEMO_LEADS_KEY } from './leads.js';

const $ = (sel, root = document) => root.querySelector(sel);
// Плавная прокрутка из JS — только если пользователь не просил меньше движения
const scrollBehavior = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const icon = (id) => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;
const COLS = 'ABCDEFGHIJ'.split('');
const PRICE_COLS = ['brand', 'model', 'service', 'price', 'duration', 'note'];
const LEAD_COLS = ['created_at', 'name', 'phone', 'model', 'issue', 'comment', 'source', 'status'];
const DOCK_QUERY = '(min-width: 1280px)';
const MIN_ROWS = 26; // как в настоящей таблице: пустые строки сетки до низа панели

/** Пустые строки-заполнители после данных (номера строк продолжаются). */
function fillerRows(from, cols) {
  let html = '';
  for (let n = from; n <= MIN_ROWS; n++) html += `<tr class="gs-filler" aria-hidden="true"><th class="gs-rownum">${n}</th>${'<td></td>'.repeat(cols)}</tr>`;
  return html;
} // шире — панель «пристыкована» справа, сайт виден рядом

// Примеры для скриншота ?sheet=leads, если реальных демо-заявок ещё нет (в storage не пишутся)
const SAMPLE_LEADS = [
  { created_at: '', name: 'Анна', phone: '+7 (900) 123-45-67', model: 'iPhone 13', issue: 'Разбит экран', comment: 'Удобно после 18:00', source: 'site', status: 'Новая' },
  { created_at: '', name: 'Дмитрий', phone: '+7 (916) 555-01-02', model: 'Samsung Galaxy S23', issue: 'Быстро садится батарея', comment: '', source: 'site', status: 'Новая' },
];

function formatDateTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {{store: EventTarget & {items: any[], setPrice: Function, resetOverrides: Function, overrides: object},
 *          params: URLSearchParams}} deps
 */
export function initDemoSheet({ store, params }) {
  const state = {
    open: false,
    sheet: params.get('sheet') === 'leads' ? 'leads' : 'prices',
    unseen: 0,
    flashLead: -1,
    sampleLeads: params.get('sheet') === 'leads' && !readDemoLeads().length,
  };

  document.body.insertAdjacentHTML('beforeend', `
    <button class="demo-fab" type="button" aria-haspopup="dialog" aria-controls="demo-sheet" aria-expanded="false" data-sheet-open>
      <svg class="icon icon-sheet" aria-hidden="true"><use href="#i-sheet"/></svg>
      <span class="demo-fab-text">Таблица цен <span class="demo-fab-tag">демо</span></span>
      <span class="demo-fab-badge" data-fab-badge hidden></span>
    </button>
    <div class="sheet-backdrop" data-sheet-backdrop hidden></div>
    <aside class="sheet-panel" id="demo-sheet" role="dialog" aria-modal="true" aria-labelledby="gs-title" hidden data-sheet>
      <div class="gs-hint">
        <span class="gs-hint-ico">${icon('i-sheet')}</span>
        <p><b>Так выглядит ваша таблица.</b> Меняете цену — сайт обновляется. Заявки приходят сюда&nbsp;же.</p>
        <button class="gs-close" type="button" aria-label="Закрыть таблицу" data-sheet-close>${icon('i-close')}</button>
      </div>
      <header class="gs-top">
        <svg class="gs-logo" aria-hidden="true"><use href="#i-sheet"/></svg>
        <div class="gs-title-wrap">
          <p class="gs-title" id="gs-title">Фикслаб — прайс и заявки</p>
          <p class="gs-menu" aria-hidden="true"><span>Файл</span><span>Правка</span><span>Вид</span><span>Вставка</span><span>Формат</span><span>Данные</span></p>
        </div>
        <button class="gs-reset" type="button" data-sheet-reset>${icon('i-refresh')}<span class="gs-reset-text">Сбросить демо</span></button>
      </header>
      <div class="gs-formula" aria-hidden="true">
        <span class="gs-cellref" data-cellref>D2</span>
        <span class="gs-fx">fx</span>
        <span class="gs-formula-val" data-formula></span>
      </div>
      <div class="gs-grid-wrap" data-grid-wrap tabindex="-1"></div>
      <footer class="gs-bottom">
        <div class="gs-tabs" role="tablist" aria-label="Листы таблицы">
          <button class="gs-tab" type="button" role="tab" id="gs-tab-prices" aria-controls="gs-grid" data-sheet-tab="prices">Цены</button>
          <button class="gs-tab" type="button" role="tab" id="gs-tab-leads" aria-controls="gs-grid" data-sheet-tab="leads">Заявки <span class="gs-tab-count" data-leads-count></span></button>
        </div>
        <p class="gs-sync" aria-live="polite" data-sync><span class="dot"></span><span data-sync-msg>Сайт синхронизирован с таблицей</span></p>
      </footer>
    </aside>`);

  const fab = $('[data-sheet-open]');
  const panel = $('[data-sheet]');
  const backdrop = $('[data-sheet-backdrop]');
  const wrap = $('[data-grid-wrap]');
  const formula = $('[data-formula]');
  const cellref = $('[data-cellref]');
  const syncBox = $('[data-sync]');
  const syncMsg = $('[data-sync-msg]');
  const fabBadge = $('[data-fab-badge]');
  const docked = window.matchMedia(DOCK_QUERY);
  let lastFocus = null;

  const leads = () => (state.sampleLeads ? SAMPLE_LEADS : readDemoLeads());

  /* ----- Рендер листов ----- */
  function colHeads(n, active = -1) {
    return `<tr><th class="gs-corner" aria-hidden="true"></th>${COLS.slice(0, n)
      .map((c, i) => `<th class="gs-col${i === active ? ' is-active' : ''}" aria-hidden="true">${c}</th>`).join('')}</tr>`;
  }

  function renderPrices() {
    const items = store.items;
    const rows = items.map((item, i) => {
      const edited = Object.hasOwn(store.overrides, item.id);
      return `<tr>
        <th class="gs-rownum" scope="row">${i + 2}</th>
        <td>${esc(item.brand)}</td>
        <td>${esc(item.model)}</td>
        <td>${esc(item.service)}</td>
        <td class="gs-price${edited ? ' is-edited' : ''}">
          <input class="gs-input" type="text" inputmode="numeric" autocomplete="off"
            value="${item.price ?? ''}" data-id="${esc(item.id)}" data-row="${i + 2}"
            aria-label="Цена: ${esc(item.model)}, ${esc(item.service)}">
        </td>
        <td>${esc(item.duration)}</td>
        <td class="gs-muted">${esc(item.note)}</td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `<table class="gs-grid gs-grid--prices" id="gs-grid" role="tabpanel" aria-labelledby="gs-tab-prices">
      <thead>${colHeads(6, 3)}</thead>
      <tbody>
        <tr class="gs-head-row"><th class="gs-rownum" scope="row">1</th>${PRICE_COLS
          .map((c) => `<td${c === 'price' ? ' class="gs-price-head"' : ''}>${c}${c === 'price' ? '<span class="gs-edit-tag">правьте здесь</span>' : ''}</td>`).join('')}</tr>
        ${rows}
        ${fillerRows(items.length + 2, 6)}
      </tbody>
    </table>`;
    const first = wrap.querySelector('.gs-input');
    if (first) setActiveCell(first, false);
  }

  function renderLeads() {
    const list = leads();
    const body = list.length
      ? list.map((lead, i) => `<tr class="${i === state.flashLead ? 'is-new' : ''}">
          <th class="gs-rownum" scope="row">${i + 2}</th>
          ${LEAD_COLS.map((c) => (c === 'status'
            ? `<td><span class="gs-chip">${esc(lead.status || 'Новая')}</span></td>`
            : `<td${c === 'comment' ? ' class="gs-muted"' : ''}>${esc(c === 'created_at' ? formatDateTime(lead.created_at) : lead[c])}</td>`)).join('')}
        </tr>`).join('')
      : `<tr class="gs-empty-row"><th class="gs-rownum" scope="row">2</th><td colspan="8">
          <span>Пока пусто. Отправьте заявку с сайта — она появится здесь строкой.</span>
          <button class="gs-link" type="button" data-goto-form>Заполнить форму ${icon('i-arrow')}</button>
        </td></tr>`;
    wrap.innerHTML = `<table class="gs-grid gs-grid--leads" id="gs-grid" role="tabpanel" aria-labelledby="gs-tab-leads">
      <thead>${colHeads(8)}</thead>
      <tbody>
        <tr class="gs-head-row"><th class="gs-rownum" scope="row">1</th>${LEAD_COLS.map((c) => `<td>${c}</td>`).join('')}</tr>
        ${body}
        ${fillerRows(Math.max(list.length, 1) + 2, 8)}
      </tbody>
    </table>`;
    cellref.textContent = list.length ? `A${list.length + 1}` : 'A2';
    formula.textContent = list.length ? formatDateTime(list.at(-1).created_at) : '';
    state.flashLead = -1;
  }

  function render() {
    for (const tab of panel.querySelectorAll('[data-sheet-tab]')) {
      const sel = tab.dataset.sheetTab === state.sheet;
      tab.setAttribute('aria-selected', String(sel));
      tab.tabIndex = sel ? 0 : -1;
    }
    const count = leads().length;
    $('[data-leads-count]').textContent = count ? String(count) : '';
    if (state.sheet === 'prices') renderPrices(); else renderLeads();
  }

  function setActiveCell(input, focus = true) {
    wrap.querySelectorAll('.gs-price.is-active').forEach((td) => td.classList.remove('is-active'));
    input.closest('td').classList.add('is-active');
    cellref.textContent = `D${input.dataset.row}`;
    formula.textContent = input.value;
    if (focus) input.focus();
  }

  function flashSync(text) {
    syncMsg.textContent = text;
    syncBox.classList.remove('is-flash');
    void syncBox.offsetWidth; // перезапуск анимации
    syncBox.classList.add('is-flash');
  }

  /* ----- Открытие / закрытие ----- */
  function applyLayout() {
    // Пристыкованная панель сдвигает сайт влево, узкий экран — шторка снизу с фоном
    const html = document.documentElement;
    html.classList.toggle('sheet-docked', state.open && docked.matches);
    html.classList.toggle('sheet-overlay', state.open && !docked.matches);
    backdrop.hidden = !state.open || docked.matches;
  }

  function open(sheet = state.sheet) {
    state.sheet = sheet;
    state.open = true;
    state.unseen = 0;
    fabBadge.hidden = true;
    lastFocus = document.activeElement;
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    render();
    applyLayout();
    requestAnimationFrame(() => panel.classList.add('is-open'));
    // Чтобы сразу было видно, как правка цены меняет сайт, показываем рядом прайс
    const behavior = params.get('demo') === 'open' ? 'auto' : scrollBehavior();
    const r = document.getElementById('prices').getBoundingClientRect();
    if (docked.matches && (r.bottom < 200 || r.top > window.innerHeight * 0.6)) {
      document.querySelector('#prices .section-head').scrollIntoView({ block: 'start', behavior });
    } else if (!docked.matches) {
      // шторка закрывает низ экрана — поднимаем карточки прайса в видимую верхнюю часть
      const card = document.querySelector('.price-card');
      const header = document.querySelector('[data-header]').offsetHeight;
      if (card) window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - header - 12, behavior });
    }
    const target = panel.querySelector('.gs-price.is-active .gs-input') || panel.querySelector('[data-sheet-tab][aria-selected="true"]');
    target?.focus({ preventScroll: true });
  }

  function close() {
    state.open = false;
    panel.classList.remove('is-open');
    fab.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    applyLayout();
    (lastFocus && document.contains(lastFocus) ? lastFocus : fab).focus({ preventScroll: true });
  }

  fab.addEventListener('click', () => open());
  backdrop.addEventListener('click', close);
  panel.querySelector('[data-sheet-close]').addEventListener('click', close);
  docked.addEventListener('change', applyLayout);

  // Esc закрывает; Tab не выходит за пределы панели (фокус-ловушка)
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (e.target.classList.contains('gs-input')) return; // Esc в ячейке — отмена ввода
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = [...panel.querySelectorAll('button, input, [tabindex="0"]')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    const first = focusables[0];
    const last = focusables.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Вкладки листов (+ стрелки)
  panel.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-sheet-tab]');
    if (tab) { state.sheet = tab.dataset.sheetTab; render(); tab.focus(); }
    if (e.target.closest('[data-goto-form]')) {
      if (!docked.matches) close();
      document.getElementById('lead').scrollIntoView({ behavior: scrollBehavior() });
    }
  });
  panel.querySelector('.gs-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    state.sheet = state.sheet === 'prices' ? 'leads' : 'prices';
    render();
    panel.querySelector(`[data-sheet-tab="${state.sheet}"]`).focus();
  });

  // Редактирование цены: Enter/blur — применить, Esc — отменить, Enter переходит ниже
  const commit = (input) => {
    const raw = input.value.trim();
    const item = store.items.find((i) => i.id === input.dataset.id);
    if (!item) return;
    if (raw && parsePrice(raw) === null) {
      input.value = item.price ?? '';
      input.closest('td').classList.add('is-error');
      setTimeout(() => input.closest('td')?.classList.remove('is-error'), 900);
      flashSync('В колонке price — только число в рублях');
      return;
    }
    if (store.setPrice(item.id, raw)) {
      const now = store.items.find((i) => i.id === item.id);
      flashSync(`Сайт обновлён: ${item.model}, ${item.service.toLowerCase()} — ${formatPrice(now.price)}`);
    }
  };
  wrap.addEventListener('focusin', (e) => { if (e.target.classList.contains('gs-input')) setActiveCell(e.target, false); });
  wrap.addEventListener('input', (e) => { if (e.target.classList.contains('gs-input')) formula.textContent = e.target.value; });
  wrap.addEventListener('focusout', (e) => { if (e.target.classList.contains('gs-input')) commit(e.target); });
  wrap.addEventListener('keydown', (e) => {
    const input = e.target;
    if (!input.classList?.contains('gs-input')) return;
    if (e.key === 'Escape') {
      const item = store.items.find((i) => i.id === input.dataset.id);
      input.value = item?.price ?? '';
      formula.textContent = input.value;
      input.select();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const id = input.dataset.id;
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      commit(input);
      // после commit таблица перерисована — ищем ячейку заново
      const inputs = [...wrap.querySelectorAll('.gs-input')];
      const i = inputs.findIndex((el) => el.dataset.id === id);
      const next = inputs[i + dir] || inputs[i];
      if (next) { setActiveCell(next); next.select(); }
    }
  });

  // Перерисовка при изменении прайса (правка, загрузка, сброс)
  store.addEventListener('change', (e) => {
    if (!state.open || state.sheet !== 'prices') return;
    if (e.detail.reason === 'edit') {
      // Точечно помечаем ячейку: полная перерисовка сбросила бы фокус, пока человек ходит по ячейкам
      for (const id of e.detail.changed) {
        wrap.querySelector(`.gs-input[data-id="${CSS.escape(id)}"]`)?.closest('td').classList.add('is-edited');
      }
    } else {
      renderPrices();
    }
  });

  // Новая заявка с сайта → строка в листе «Заявки»
  document.addEventListener('fixlab:lead', () => {
    state.sampleLeads = false;
    state.flashLead = readDemoLeads().length - 1;
    if (state.open) {
      state.sheet = 'leads';
      render();
      wrap.querySelector('tr.is-new')?.scrollIntoView({ block: 'nearest' });
      flashSync('Новая заявка записана в лист «Заявки»');
    } else {
      state.unseen += 1;
      state.sheet = 'leads';
      fabBadge.textContent = `+${state.unseen}`;
      fabBadge.hidden = false;
      fab.classList.remove('is-ping');
      void fab.offsetWidth;
      fab.classList.add('is-ping');
    }
  });

  panel.querySelector('[data-sheet-reset]').addEventListener('click', () => {
    try { localStorage.removeItem(DEMO_LEADS_KEY); } catch { /* ignore */ }
    state.sampleLeads = false;
    store.resetOverrides();
    render();
    flashSync('Демо сброшено: исходные цены, заявок нет');
  });

  // ?demo=open — открыть панель сразу (для скриншотов и ссылки в отклике)
  if (params.get('demo') === 'open') {
    const openWhenLoaded = () => open(state.sheet);
    if (store.items.length) openWhenLoaded();
    else store.addEventListener('change', openWhenLoaded, { once: true });
  }
}
