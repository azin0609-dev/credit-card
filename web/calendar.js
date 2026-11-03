// 產生行事曆提醒：.ics 檔（iPhone／各種行事曆 App）與 Google 日曆連結。
// 每張卡建立「每月繳款截止日」的重複事件，可選擇一併建立「每月結帳日」事件。

import { clampDay, parts, shiftMonth } from './billing.js';

/** 每月 day 號的 RRULE；29～31 號遇到小月時改在月底（RFC 5545 BYSETPOS 寫法）。 */
export function monthlyRule(day) {
  if (day <= 28) return `FREQ=MONTHLY;BYMONTHDAY=${day}`;
  const days = [];
  for (let d = 28; d <= day; d += 1) days.push(d);
  return `FREQ=MONTHLY;BYMONTHDAY=${days.join(',')};BYSETPOS=-1`;
}

/** today 當天或之後第一個「每月 day 號」。 */
export function firstOccurrence(day, today) {
  const [y, m] = parts(today);
  const candidate = clampDay(y, m, day);
  if (candidate >= today) return candidate;
  const [ny, nm] = shiftMonth(y, m, 1);
  return clampDay(ny, nm, day);
}

const compact = (date) => date.replaceAll('-', '');

function nextDay(date) {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function escapeText(text) {
  return String(text)
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** 依 RFC 5545 每行最多 75 bytes 折行（以 UTF-8 計算，不切斷多位元組字元）。 */
export function foldLine(line) {
  const encoder = new TextEncoder();
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // 續行開頭的空白佔 1 byte
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function cardTitle(card) {
  return card.last4 ? `${card.name}（*${card.last4}）` : card.name;
}

function events(card, today, includeClosing) {
  const list = [
    {
      key: 'due',
      day: card.dueDay,
      summary: `💳 ${cardTitle(card)} 繳款截止`,
      description: `每月 ${card.dueDay} 日是「${card.name}」的繳款截止日。請打開信用卡管理 App 確認本期應繳與最低應繳金額。`,
      alarms: true,
    },
  ];
  if (includeClosing) {
    list.push({
      key: 'closing',
      day: card.statementDay,
      summary: `🧾 ${cardTitle(card)} 結帳日`,
      description: `每月 ${card.statementDay} 日是「${card.name}」的結帳日。`,
      alarms: false,
    });
  }
  return list.map((e) => ({ ...e, start: firstOccurrence(e.day, today) }));
}

/** 產生 .ics 內容。alarmDaysBefore：提前幾天提醒（另外截止日當天早上 9 點也會提醒）。 */
export function buildIcs(cards, { today, includeClosing = false, alarmDaysBefore = 3, now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//credit-card//信用卡管理//ZH-TW',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:信用卡繳款提醒',
  ];
  for (const card of cards) {
    for (const ev of events(card, today, includeClosing)) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${ev.key}-${card.id}-${ev.day}@credit-card.local`,
        `DTSTAMP:${stamp(now)}`,
        `DTSTART;VALUE=DATE:${compact(ev.start)}`,
        `DTEND;VALUE=DATE:${nextDay(ev.start)}`,
        `RRULE:${monthlyRule(ev.day)}`,
        `SUMMARY:${escapeText(ev.summary)}`,
        `DESCRIPTION:${escapeText(ev.description)}`,
        'TRANSP:TRANSPARENT',
      );
      if (ev.alarms) {
        if (alarmDaysBefore > 0) {
          // 全天事件從 00:00 起算：提前 N 天的早上 9 點
          lines.push(
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `DESCRIPTION:${escapeText(`${cardTitle(card)} ${alarmDaysBefore} 天後繳款截止`)}`,
            `TRIGGER:-P${alarmDaysBefore > 1 ? `${alarmDaysBefore - 1}D` : ''}T15H`,
            'END:VALARM',
          );
        }
        lines.push(
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escapeText(`${cardTitle(card)} 今天繳款截止`)}`,
          'TRIGGER:PT9H',
          'END:VALARM',
        );
      }
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** 「加到 Google 日曆」連結（每月重複的全天事件）。 */
export function googleCalendarUrl(card, today, kind = 'due') {
  const ev = events(card, today, true).find((e) => e.key === kind);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.summary,
    dates: `${compact(ev.start)}/${nextDay(ev.start)}`,
    details: ev.description,
    recur: `RRULE:${monthlyRule(ev.day)}`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
