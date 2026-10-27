// Заявки: маска телефона, валидация, подготовка данных и отправка в Google Таблицу.
// Чистые функции тестируются в Node (tests/leads.test.mjs); submitLead получает
// fetch/localStorage/document параметрами, поэтому тоже тестируется без браузера.

export const DEMO_LEADS_KEY = 'fixlab:demo-leads';
export const MIN_FILL_MS = 3000; // быстрее 3 секунд форму заполняют только боты

/**
 * Национальная часть номера (до 10 цифр, без +7/8).
 * «8 900 …», «+7 900 …», «900 …» → «900…».
 */
export function phoneDigits(input) {
  const s = String(input ?? '').trim();
  let d;
  if (s.startsWith('+7')) {
    // код страны уже есть (в т.ч. «+7 (» из маски); вставка «8900…»/«+7900…» после него — тоже ок
    d = s.slice(2).replace(/\D/g, '');
    if (d.length > 10 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  } else {
    d = s.replace(/\D/g, '');
    if (d[0] === '7' || d[0] === '8') d = d.slice(1);
  }
  return d.slice(0, 10);
}

/** Маска +7 (XXX) XXX-XX-XX, заполняется по мере ввода. Пустой ввод → ''. */
export function formatPhone(input) {
  const d = phoneDigits(input);
  if (!d) return '';
  let out = `+7 (${d.slice(0, 3)}`;
  if (d.length > 3) out += `) ${d.slice(3, 6)}`;
  if (d.length > 6) out += `-${d.slice(6, 8)}`;
  if (d.length > 8) out += `-${d.slice(8, 10)}`;
  return out;
}

/**
 * Проверка заявки. Возвращает { ok, errors }, где errors — { поле: 'понятный текст' }
 * только для полей с ошибками.
 * @param {{name?:string, phone?:string, model?:string, issue?:string, comment?:string, consent?:boolean}} data
 */
export function validateLead(data = {}) {
  const errors = {};
  const name = String(data.name ?? '').trim();
  const model = String(data.model ?? '').trim();
  const issue = String(data.issue ?? '').trim();
  const comment = String(data.comment ?? '').trim();
  const digits = phoneDigits(data.phone);

  if (!name) errors.name = 'Укажите имя — так мастеру будет проще к вам обратиться';
  else if (name.length < 2) errors.name = 'Имя слишком короткое';
  else if (name.length > 60) errors.name = 'Имя слишком длинное — хватит 60 символов';
  else if (!/[a-zа-яё]/i.test(name)) errors.name = 'Имя должно содержать буквы';

  if (!digits) errors.phone = 'Укажите телефон — перезвоним на него';
  else if (digits.length < 10) errors.phone = 'Номер неполный: нужно 10 цифр после +7';

  if (!model) errors.model = 'Укажите модель — мастер сразу назовёт цену';
  else if (model.length > 80) errors.model = 'Слишком длинное название модели';

  if (!issue) errors.issue = 'Выберите, что случилось с телефоном';

  if (issue === 'Другое' && !comment) errors.comment = 'Опишите неисправность в паре слов';
  else if (comment.length > 1000) errors.comment = 'Комментарий слишком длинный — до 1000 символов';

  if (!data.consent) errors.consent = 'Нужно согласие на обработку данных, иначе мы не сможем перезвонить';

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Признаки спама: заполнено скрытое поле-ловушка или форма отправлена слишком быстро.
 * @returns {'' | 'honeypot' | 'too-fast'}
 */
export function spamReason({ honeypot = '', startedAt = 0, now = Date.now(), minMs = MIN_FILL_MS } = {}) {
  if (String(honeypot).trim()) return 'honeypot';
  if (now - startedAt < minMs) return 'too-fast';
  return '';
}

/** Данные для строки листа «Заявки» (порядок полей = порядок колонок). */
export function buildPayload(data, now = new Date()) {
  return {
    created_at: now.toISOString(),
    name: String(data.name ?? '').trim(),
    phone: formatPhone(data.phone),
    model: String(data.model ?? '').trim(),
    issue: String(data.issue ?? '').trim(),
    comment: String(data.comment ?? '').trim(),
    source: 'site',
    status: 'Новая',
  };
}

/** Короткий номер заявки для клиента: ДДММ-ЧЧММСС по локальному времени. */
export function makeLeadId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(now.getDate())}${p(now.getMonth() + 1)}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Услуга из прайса → пункт «Что случилось» в форме. */
export function issueForService(service) {
  const s = String(service ?? '').toLowerCase().replace(/ё/g, 'е');
  if (s.includes('стекл')) return 'Разбито заднее стекло';
  if (s.includes('экран') || s.includes('дисплей')) return 'Разбит экран';
  if (s.includes('аккумулятор') || s.includes('батаре')) return 'Быстро садится батарея';
  if (s.includes('разъем') || s.includes('заряд')) return 'Не заряжается';
  if (s.includes('камер')) return 'Не работает камера';
  return 'Другое';
}

/** Заявки, сохранённые в демо-режиме (лист «Заявки» демо-панели). */
export function readDemoLeads(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage?.getItem(DEMO_LEADS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Отправка заявки.
 * - endpoint (Google Apps Script) — POST в режиме no-cors: ответ «непрозрачный»,
 *   поэтому успехом считаем отсутствие сетевой ошибки. URLSearchParams не вызывает
 *   CORS-preflight, а Apps Script читает поля из e.parameter.
 * - demo — заявка сохраняется в localStorage и уходит событием в демо-панель.
 */
export async function submitLead(payload, {
  endpoint = '', demo = false,
  fetchImpl = globalThis.fetch, storage = globalThis.localStorage, target = globalThis.document,
} = {}) {
  if (!endpoint && !demo) throw new Error('Не настроен LEADS_ENDPOINT в config.js');

  if (endpoint) {
    await fetchImpl(endpoint, { method: 'POST', mode: 'no-cors', body: new URLSearchParams(payload) });
  }
  if (demo) {
    const leads = readDemoLeads(storage);
    leads.push(payload);
    try { storage?.setItem(DEMO_LEADS_KEY, JSON.stringify(leads)); } catch { /* приватный режим */ }
    target?.dispatchEvent?.(new CustomEvent('fixlab:lead', { detail: payload }));
  }
  return { ok: true };
}
