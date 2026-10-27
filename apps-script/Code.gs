/**
 * Фикслаб — приём заявок с сайта в Google Таблицу.
 *
 * Установка (подробно — README.md):
 *   1. Таблица → Расширения → Apps Script → вставить этот файл.
 *   2. Развернуть → Новое развертывание → Веб-приложение:
 *      «Запуск от имени: я», «Доступ: все». URL вставить в config.js → LEADS_ENDPOINT.
 *   3. (Необязательно) уведомления в Telegram: Настройки проекта → Свойства скрипта →
 *      TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID. Токен в коде не храним.
 */

var SHEET_NAME = 'Заявки';
var HEADERS = ['created_at', 'name', 'phone', 'model', 'issue', 'comment', 'source', 'status'];
var MAX_LEN = 1000; // защита от слишком длинных значений

/** Приём заявки: сайт шлёт POST с полями формы (URLSearchParams). */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // Без блокировки две одновременные заявки могут записаться в одну строку
    lock.waitLock(10000);

    var p = (e && e.parameter) || {};
    // Honeypot: поле website заполняют только боты — делаем вид, что всё хорошо
    if (p.website) return json_({ ok: true });

    var lead = {};
    HEADERS.forEach(function (key) { lead[key] = clean_(p[key]); });
    if (!lead.name || !lead.phone) return json_({ ok: false, error: 'name и phone обязательны' });
    lead.created_at = lead.created_at || new Date().toISOString();
    lead.source = lead.source || 'site';
    lead.status = 'Новая';

    var sheet = getSheet_();
    sheet.appendRow(HEADERS.map(function (key) { return lead[key]; }));

    notifyTelegram_(lead);
    return json_({ ok: true, row: sheet.getLastRow() });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** Проверка, что веб-приложение развернуто: открыть URL в браузере. */
function doGet() {
  return json_({ ok: true, service: 'fixlab-leads' });
}

/** Лист «Заявки»; создаётся вместе с заголовками, если его нет или он пуст. */
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Очистка значения: обрезка и защита от формул. Ячейка, начинающаяся с = + - @,
 * в таблице выполнилась бы как формула — добавляем апостроф.
 */
function clean_(value) {
  var s = String(value == null ? '' : value).trim().slice(0, MAX_LEN);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Уведомление в Telegram, если заданы свойства скрипта. Ошибка уведомления не теряет заявку. */
function notifyTelegram_(lead) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TELEGRAM_BOT_TOKEN');
  var chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return;

  var text = [
    'Новая заявка с сайта',
    'Имя: ' + lead.name,
    'Телефон: ' + lead.phone,
    'Модель: ' + (lead.model || '—'),
    'Неисправность: ' + (lead.issue || '—'),
    lead.comment ? 'Комментарий: ' + lead.comment : '',
  ].filter(String).join('\n');

  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text: text }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    console.warn('Telegram: ' + err);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
