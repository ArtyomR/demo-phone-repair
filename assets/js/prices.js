// Прайс: разбор CSV из Google Таблицы, нормализация, группировка, фильтр, форматирование.
// Только чистые функции — без DOM, тестируются в Node (tests/prices.test.mjs).

/** Бренды с собственными табами; всё остальное попадает в «Другие». */
export const MAIN_BRANDS = ['Apple', 'Samsung', 'Xiaomi'];
export const OTHER_BRAND = 'other';

const NBSP = ' ';

/**
 * Разбор CSV по RFC 4180: кавычки, "" внутри кавычек, запятые и переводы строк
 * в кавычках, CRLF/LF, BOM. Полностью пустые строки пропускаются.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCSV(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  // последняя строка без перевода строки в конце
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * Цена из ячейки таблицы → число рублей или null («по запросу»).
 * Понимает «4 990», «4990 ₽», «4 990,00», «от 4990 руб.».
 * @param {unknown} value
 * @returns {number|null}
 */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const s = String(value ?? '')
    .replace(/[\s  ]/g, '')
    .replace(/(руб\.?|₽|р\.|от)/gi, '')
    .replace(',', '.');
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

/** Устойчивый ключ позиции прайса (бренд + модель + услуга). */
export function priceKey(item) {
  return [item.brand, item.model, item.service].map((v) => normalizeText(v)).join('|');
}

/**
 * Строки CSV (первая — заголовок) → массив позиций прайса.
 * Колонки ищутся по имени (без учёта регистра), порядок в таблице не важен.
 * Строки без модели или услуги отбрасываются.
 * @param {string[][]} rows
 */
export function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    brand: col('brand'), model: col('model'), service: col('service'),
    price: col('price'), duration: col('duration'), note: col('note'),
  };
  const get = (r, key) => (idx[key] >= 0 ? String(r[idx[key]] ?? '').trim() : '');

  const items = [];
  for (const r of rows.slice(1)) {
    const model = get(r, 'model');
    const service = get(r, 'service');
    if (!model || !service) continue;
    const item = {
      brand: get(r, 'brand') || 'Другие',
      model,
      service,
      price: parsePrice(get(r, 'price')),
      duration: get(r, 'duration'),
      note: get(r, 'note'),
    };
    item.id = priceKey(item);
    items.push(item);
  }
  return items;
}

/** Нижний регистр, ё → е, схлопнутые пробелы — для поиска и ключей. */
export function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Ключ таба для бренда: Apple/Samsung/Xiaomi или 'other'. */
export function brandTab(brand) {
  const hit = MAIN_BRANDS.find((b) => normalizeText(b) === normalizeText(brand));
  return hit || OTHER_BRAND;
}

/**
 * Фильтр по табу бренда и строке поиска. Поиск — по всем словам запроса
 * (каждое должно встретиться в бренде, модели или услуге), без учёта регистра и ё/е.
 * @param {Array} items
 * @param {{brand?: string, query?: string}} opts brand: 'all' | 'Apple' | ... | 'other'
 */
export function filterPrices(items, { brand = 'all', query = '' } = {}) {
  const words = normalizeText(query).split(' ').filter(Boolean);
  return items.filter((item) => {
    if (brand && brand !== 'all' && brandTab(item.brand) !== brand) return false;
    if (!words.length) return true;
    const hay = normalizeText(`${item.brand} ${item.model} ${item.service} ${item.note}`);
    return words.every((w) => hay.includes(w));
  });
}

/** Группировка по бренду с сохранением порядка из таблицы: [{brand, items}]. */
export function groupByBrand(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.brand)) map.set(item.brand, { brand: item.brand, items: [] });
    map.get(item.brand).items.push(item);
  }
  return [...map.values()];
}

/** Группировка по модели с сохранением порядка: [{brand, model, items}]. */
export function groupByModel(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${normalizeText(item.brand)}|${normalizeText(item.model)}`;
    if (!map.has(key)) map.set(key, { brand: item.brand, model: item.model, items: [] });
    map.get(key).items.push(item);
  }
  return [...map.values()];
}

/** Число с разделителем разрядов-неразрывным пробелом: 24990 → «24 990». */
export function formatNumber(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/**
 * Цена для показа: «от 4 990 ₽» или «по запросу» (если цены нет).
 * @param {number|null} n
 * @param {{from?: boolean}} opts from=false — без «от»
 */
export function formatPrice(n, { from = true } = {}) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'по запросу';
  return `${from ? `от${NBSP}` : ''}${formatNumber(n)}${NBSP}₽`;
}

/** Количество позиций по табам — для счётчиков на табах. */
export function countByTab(items) {
  const counts = { all: items.length, [OTHER_BRAND]: 0 };
  for (const b of MAIN_BRANDS) counts[b] = 0;
  for (const item of items) counts[brandTab(item.brand)]++;
  return counts;
}
