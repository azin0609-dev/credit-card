// 與 tests/test_billing.py、tests/test_dates_money.py 對應，確保網頁版與 Python 版算法一致。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  Status,
  addMonths,
  amountToInput,
  buildSnapshot,
  clampDay,
  closingOnOrAfter,
  daysBetween,
  describeDays,
  dueDateFor,
  formatAmount,
  installmentSchedule,
  isValidDate,
  lastClosedBefore,
  minimumPayment,
  nextClosing,
  parseAmount,
  previousClosing,
  statementStatus,
  upcomingEvents,
} from '../../web/billing.js';

const D = 100;
const TODAY = '2026-11-02';

const card = (extra = {}) => ({
  id: 1,
  name: '測試卡',
  statementDay: 25,
  dueDay: 9,
  creditLimit: 100_000 * D,
  minRate: 10,
  minFloor: 1000 * D,
  ...extra,
});
const txn = (date, amount) => ({ cardId: 1, date, amount: amount * D });
const pay = (date, amount) => ({ cardId: 1, date, amount: amount * D });

function snapshot({ c = card(), txns = [], pays = [], insts = [], overrides = [], today = TODAY } = {}) {
  return buildSnapshot(c, { transactions: txns, payments: pays, installments: insts, overrides }, today);
}

describe('日期', () => {
  test('月底夾擠', () => {
    assert.equal(clampDay(2026, 2, 31), '2026-02-28');
    assert.equal(clampDay(2028, 2, 31), '2028-02-29');
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
    assert.equal(addMonths('2026-11-10', 3), '2027-02-10');
  });

  test('結帳日', () => {
    assert.equal(closingOnOrAfter('2026-11-02', 25), '2026-11-25');
    assert.equal(closingOnOrAfter('2026-11-25', 25), '2026-11-25');
    assert.equal(closingOnOrAfter('2026-12-26', 25), '2027-01-25');
    assert.equal(closingOnOrAfter('2026-02-01', 31), '2026-02-28');
    assert.equal(nextClosing('2026-02-28', 31), '2026-03-31');
    assert.equal(previousClosing('2026-01-05', 5), '2025-12-05');
    assert.equal(lastClosedBefore('2026-11-02', 25), '2026-10-25');
    assert.equal(lastClosedBefore('2026-10-25', 25), '2026-09-25');
  });

  test('繳款截止日', () => {
    assert.equal(dueDateFor('2026-11-05', 20), '2026-11-20');
    assert.equal(dueDateFor('2026-10-25', 9), '2026-11-09');
    assert.equal(dueDateFor('2026-12-15', 1), '2027-01-01');
    assert.equal(dueDateFor('2026-11-05', 5), '2026-12-05');
  });

  test('日期差與描述', () => {
    assert.equal(daysBetween('2026-10-20', TODAY), 13);
    assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(describeDays(TODAY, TODAY), '今天');
    assert.equal(describeDays('2026-11-03', TODAY), '明天');
    assert.equal(describeDays('2026-11-09', TODAY), '7 天後');
    assert.equal(describeDays('2026-10-20', TODAY), '13 天前');
  });

  test('日期驗證', () => {
    assert.ok(isValidDate('2028-02-29'));
    assert.ok(!isValidDate('2026-02-29'));
    assert.ok(!isValidDate('2026-2-1'));
    assert.ok(!isValidDate(null));
  });
});

describe('金額', () => {
  test('解析', () => {
    assert.equal(parseAmount('1,234'), 123400);
    assert.equal(parseAmount('NT$99.5'), 9950);
    assert.equal(parseAmount('$0.01'), 1);
    assert.equal(parseAmount('-300'), -30000);
    assert.equal(parseAmount(' 500 '), 50000);
    for (const bad of ['abc', '', '1.234', 'NaN', '--5', '1e5']) {
      assert.throws(() => parseAmount(bad), /無效的金額/, bad);
    }
  });

  test('格式化', () => {
    assert.equal(formatAmount(123400), '$1,234');
    assert.equal(formatAmount(9950), '$99.50');
    assert.equal(formatAmount(-50000), '-$500');
    assert.equal(formatAmount(0), '$0');
    assert.equal(formatAmount(123456789), '$1,234,567.89');
  });

  test('轉回輸入框文字', () => {
    assert.equal(amountToInput(123400), '1234');
    assert.equal(amountToInput(123450), '1234.5');
    assert.equal(amountToInput(123405), '1234.05');
    assert.equal(amountToInput(-500), '-5');
    assert.equal(parseAmount(amountToInput(987654)), 987654);
  });
});

describe('最低應繳', () => {
  test('比例、下限、全額繳清', () => {
    assert.equal(minimumPayment(20_000 * D, 10, 1000 * D), 2000 * D);
    assert.equal(minimumPayment(5000 * D, 10, 1000 * D), 1000 * D);
    assert.equal(minimumPayment(800 * D, 10, 1000 * D), 800 * D);
    assert.equal(minimumPayment(12_345 * D, 10, 1000 * D), 1235 * D);
    assert.equal(minimumPayment(0, 10, 1000 * D), 0);
    assert.equal(minimumPayment(-500 * D, 10, 1000 * D), 0);
  });

  test('須全額繳納的部分', () => {
    assert.equal(minimumPayment(23_000 * D, 10, 1000 * D, 3000 * D), 5000 * D);
    assert.equal(minimumPayment(2000 * D, 10, 1000 * D, 9000 * D), 2000 * D);
  });

  test('小數比例', () => {
    assert.equal(minimumPayment(10_001 * D, 2.5, 0), 251 * D);
  });
});

describe('帳單試算', () => {
  test('沒有紀錄', () => {
    const snap = snapshot();
    assert.deepEqual(snap.statements, []);
    assert.equal(snap.latest, null);
    assert.equal(snap.totalDebt, 0);
    assert.equal(snap.nextClosingDate, '2026-11-25');
    assert.equal(snap.nextDueDate, '2026-12-09');
  });

  test('週期邊界', () => {
    const snap = snapshot({ txns: [txn('2026-10-25', 1000), txn('2026-10-26', 500)] });
    assert.equal(snap.statements.length, 1);
    const s = snap.latest;
    assert.equal(s.closingDate, '2026-10-25');
    assert.equal(s.periodStart, '2026-09-26');
    assert.equal(s.dueDate, '2026-11-09');
    assert.equal(s.balance, 1000 * D);
    assert.equal(snap.unbilledCharges, 500 * D);
    assert.equal(snap.unbilledSince, '2026-10-26');
    assert.equal(snap.currentBalance, 1500 * D);
  });

  test('結帳日當天仍屬進行中週期', () => {
    const snap = snapshot({ txns: [txn('2026-10-20', 1000)], today: '2026-10-25' });
    assert.deepEqual(snap.statements, []);
    assert.equal(snap.nextClosingDate, '2026-10-25');
    assert.equal(snap.unbilledCharges, 1000 * D);
  });

  test('狀態', () => {
    const txns = [txn('2026-10-10', 20_000)];
    const pending = snapshot({ txns }).latest;
    assert.equal(pending.minPayment, 2000 * D);
    assert.equal(statementStatus(pending, TODAY), Status.PENDING);
    assert.equal(statementStatus(pending, '2026-11-10'), Status.OVERDUE);

    const minPaid = snapshot({ txns, pays: [pay('2026-11-01', 2000)] }).latest;
    assert.equal(statementStatus(minPaid, TODAY), Status.MIN_PAID);
    assert.equal(minPaid.remaining, 18_000 * D);
    assert.equal(minPaid.minRemaining, 0);

    const paid = snapshot({ txns, pays: [pay('2026-11-01', 20_000)] }).latest;
    assert.equal(statementStatus(paid, TODAY), Status.PAID);

    const empty = snapshot({ txns: [txn('2026-10-10', 100), txn('2026-10-11', -100)] }).latest;
    assert.equal(statementStatus(empty, TODAY), Status.NO_PAYMENT);
  });

  test('結轉與前期未繳最低應繳累加', () => {
    const snap = snapshot({
      txns: [txn('2026-08-10', 5000), txn('2026-09-10', 5000)],
      pays: [pay('2026-09-01', 500)],
    });
    const [aug, sep, oct] = snap.statements;
    assert.equal(aug.balance, 5000 * D);
    assert.equal(aug.minPayment, 1000 * D);
    assert.equal(aug.paid, 500 * D);
    assert.equal(sep.previousBalance, 5000 * D);
    assert.equal(sep.credits, 500 * D);
    assert.equal(sep.balance, 9500 * D);
    assert.equal(sep.minPayment, 1500 * D);
    assert.equal(oct.balance, 9500 * D);
    assert.equal(oct.minPayment, 2500 * D);
  });

  test('手動帳單金額覆蓋試算並往後結轉', () => {
    const snap = snapshot({
      txns: [txn('2026-10-01', 1000)],
      pays: [pay('2026-10-05', 12_345)],
      overrides: [{ cardId: 1, closingDate: '2026-09-25', balance: 12_345 * D, minPayment: 1235 * D }],
    });
    const [sep, oct] = snap.statements;
    assert.ok(sep.overridden);
    assert.equal(sep.balance, 12_345 * D);
    assert.equal(sep.minPayment, 1235 * D);
    assert.equal(statementStatus(sep, TODAY), Status.PAID);
    assert.equal(oct.previousBalance, 12_345 * D);
    assert.equal(oct.balance, 1000 * D);
    assert.ok(!oct.overridden);
  });

  test('只覆蓋應繳總額時重算最低應繳', () => {
    const s = snapshot({
      overrides: [{ cardId: 1, closingDate: '2026-10-25', balance: 30_000 * D, minPayment: null }],
    }).latest;
    assert.equal(s.balance, 30_000 * D);
    assert.equal(s.minPayment, 3000 * D);
  });

  test('溢繳', () => {
    const snap = snapshot({
      txns: [txn('2026-10-10', 1000), txn('2026-10-28', 300)],
      pays: [pay('2026-10-30', 1500)],
    });
    assert.equal(statementStatus(snap.latest, TODAY), Status.PAID);
    assert.equal(snap.currentBalance, -200 * D);
  });

  test('未來日期的紀錄不計入', () => {
    const snap = snapshot({ txns: [txn('2026-12-01', 1000)], pays: [pay('2026-12-01', 50)] });
    assert.equal(snap.currentBalance, 0);
    assert.deepEqual(snap.statements, []);
  });

  test('分期', () => {
    const inst = { id: 1, cardId: 1, startDate: '2026-08-10', totalAmount: 10_000 * D, periods: 3 };
    assert.deepEqual(installmentSchedule(inst), [
      { date: '2026-08-10', amount: 3334 * D },
      { date: '2026-09-10', amount: 3333 * D },
      { date: '2026-10-10', amount: 3333 * D },
    ]);
    const snap = snapshot({ insts: [inst], today: '2026-09-30' });
    assert.deepEqual(
      snap.statements.map((s) => s.newCharges),
      [3334 * D, 3333 * D],
    );
    assert.equal(snap.remainingInstallments, 3333 * D);
    assert.equal(snap.totalDebt, 10_000 * D);
    assert.equal(snap.availableCredit, 90_000 * D);
    const p = snap.installments[0];
    assert.equal(p.postedPeriods, 2);
    assert.equal(p.nextDate, '2026-10-10');
    assert.ok(!p.finished);
  });

  test('分期當期金額全額計入最低應繳', () => {
    const inst = { id: 1, cardId: 1, startDate: '2026-10-10', totalAmount: 36_000 * D, periods: 12 };
    const s = snapshot({ txns: [txn('2026-10-01', 20_000)], insts: [inst] }).latest;
    assert.equal(s.balance, 23_000 * D);
    assert.equal(s.minPayment, 5000 * D);
  });

  test('超過額度的部分全額計入最低應繳', () => {
    const s = snapshot({ c: card({ creditLimit: 10_000 * D }), txns: [txn('2026-10-01', 12_000)] }).latest;
    assert.equal(s.minPayment, 3000 * D);
  });

  test('月底結帳日', () => {
    const snap = snapshot({
      c: card({ statementDay: 31, dueDay: 15 }),
      txns: [txn('2026-02-10', 1000)],
      today: '2026-03-05',
    });
    assert.equal(snap.latest.closingDate, '2026-02-28');
    assert.equal(snap.latest.dueDate, '2026-03-15');
    assert.equal(snap.nextClosingDate, '2026-03-31');
  });
});

describe('提醒', () => {
  test('依急迫程度排序', () => {
    const cube = snapshot({
      overrides: [{ cardId: 1, closingDate: '2026-10-25', balance: 12_345 * D, minPayment: 1235 * D }],
    });
    const pi = buildSnapshot(
      card({ id: 2, statementDay: 5, dueDay: 20 }),
      { transactions: [{ cardId: 2, date: '2026-09-20', amount: 7500 * D }], payments: [], installments: [], overrides: [] },
      TODAY,
    );
    const events = upcomingEvents([cube, pi], TODAY, 7);
    assert.deepEqual(
      events.map((e) => [e.kind, e.snap.card.id, e.date]),
      [
        ['overdue', 2, '2026-10-20'],
        ['due', 1, '2026-11-09'],
        ['closing', 2, '2026-11-05'],
      ],
    );
  });
});
