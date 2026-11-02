import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildIcs, escapeText, firstOccurrence, foldLine, googleCalendarUrl, monthlyRule } from '../../web/calendar.js';
import { emptyData, nextId, parseBackup, serializeBackup } from '../../web/store.js';

const card = {
  id: 1,
  name: '國泰CUBE',
  last4: '1234',
  statementDay: 25,
  dueDay: 9,
  creditLimit: 0,
  minRate: 10,
  minFloor: 100000,
};

describe('行事曆', () => {
  test('每月重複規則：小月自動改在月底', () => {
    assert.equal(monthlyRule(9), 'FREQ=MONTHLY;BYMONTHDAY=9');
    assert.equal(monthlyRule(28), 'FREQ=MONTHLY;BYMONTHDAY=28');
    assert.equal(monthlyRule(30), 'FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1');
    assert.equal(monthlyRule(31), 'FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1');
  });

  test('第一次出現的日期', () => {
    assert.equal(firstOccurrence(9, '2026-11-02'), '2026-11-09');
    assert.equal(firstOccurrence(1, '2026-11-02'), '2026-12-01');
    assert.equal(firstOccurrence(2, '2026-11-02'), '2026-11-02');
    assert.equal(firstOccurrence(31, '2027-02-10'), '2027-02-28');
  });

  test('文字跳脫與折行', () => {
    assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
    const long = `SUMMARY:${'信用卡'.repeat(30)}`;
    const folded = foldLine(long);
    const encoder = new TextEncoder();
    for (const line of folded.split('\r\n')) {
      assert.ok(encoder.encode(line).length <= 75, line);
    }
    assert.equal(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''), long);
  });

  test('產生 .ics', () => {
    const ics = buildIcs([card], {
      today: '2026-11-02',
      includeClosing: true,
      alarmDaysBefore: 3,
      now: new Date('2026-11-02T00:00:00Z'),
    });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.equal(ics.match(/BEGIN:VEVENT/g).length, 2);
    assert.match(ics, /DTSTART;VALUE=DATE:20261109\r\n/);
    assert.match(ics, /DTEND;VALUE=DATE:20261110\r\n/);
    assert.match(ics, /RRULE:FREQ=MONTHLY;BYMONTHDAY=9\r\n/);
    assert.match(ics, /DTSTART;VALUE=DATE:20261125\r\n/);
    assert.match(ics, /TRIGGER:-P2DT15H\r\n/);
    assert.match(ics, /TRIGGER:PT9H\r\n/);
    assert.equal(ics.match(/BEGIN:VALARM/g).length, 2); // 結帳日事件沒有提醒
    assert.match(ics, /DTSTAMP:20261102T000000Z\r\n/);
  });

  test('提前一天提醒', () => {
    const ics = buildIcs([card], { today: '2026-11-02', alarmDaysBefore: 1 });
    assert.match(ics, /TRIGGER:-PT15H\r\n/);
  });

  test('Google 日曆連結', () => {
    const url = new URL(googleCalendarUrl(card, '2026-11-02'));
    assert.equal(url.hostname, 'calendar.google.com');
    assert.equal(url.searchParams.get('dates'), '20261109/20261110');
    assert.equal(url.searchParams.get('recur'), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=9');
    assert.match(url.searchParams.get('text'), /國泰CUBE/);
  });
});

describe('備份', () => {
  const sample = () => {
    const data = emptyData();
    data.cards.push({ ...card, id: nextId(data), bank: '', note: '' });
    data.transactions.push({ id: nextId(data), cardId: 1, date: '2026-10-30', amount: 265500, description: '晚餐', category: '餐飲' });
    data.payments.push({ id: nextId(data), cardId: 1, date: '2026-11-01', amount: 100000, note: '' });
    data.installments.push({ id: nextId(data), cardId: 1, startDate: '2026-08-10', totalAmount: 3600000, periods: 12, description: '' });
    data.overrides.push({ cardId: 1, closingDate: '2026-10-25', balance: 1234500, minPayment: null });
    return data;
  };

  test('匯出後可完整匯入', () => {
    const data = sample();
    const restored = parseBackup(serializeBackup(data));
    assert.deepEqual(restored.cards, data.cards);
    assert.deepEqual(restored.transactions, data.transactions);
    assert.deepEqual(restored.overrides, data.overrides);
    assert.equal(restored.nextId, 5);
  });

  test('nextId 不會與既有 ID 衝突', () => {
    const data = sample();
    data.nextId = 1;
    assert.equal(parseBackup(JSON.stringify(data)).nextId, 5);
  });

  test('拒絕無效的備份檔', () => {
    assert.throws(() => parseBackup('不是 JSON'), /不是有效的 JSON/);
    assert.throws(() => parseBackup('{"version": 99}'), /不支援的資料版本/);

    const badCard = sample();
    badCard.transactions[0].cardId = 42;
    assert.throws(() => parseBackup(JSON.stringify(badCard)), /不存在的卡片/);

    const badDate = sample();
    badDate.payments[0].date = '2026-02-30';
    assert.throws(() => parseBackup(JSON.stringify(badDate)), /不是有效的日期/);

    const badAmount = sample();
    badAmount.transactions[0].amount = 12.5;
    assert.throws(() => parseBackup(JSON.stringify(badAmount)), /不是有效的數值/);

    const badDay = sample();
    badDay.cards[0].dueDay = 32;
    assert.throws(() => parseBackup(JSON.stringify(badDay)), /繳款截止日/);
  });
});
