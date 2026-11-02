// 帳單計算核心（與 Python 版 creditcard/billing.py 相同的規則）。
// 日期一律以 'YYYY-MM-DD' 字串表示；金額一律以「分」為單位的整數，避免浮點誤差。

export const UNIT = 100; // 1 元 = 100 分

// ---------------------------------------------------------------- 日期
const pad2 = (n) => String(n).padStart(2, '0');

export function ymd(y, m, d) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

export function parts(s) {
  return s.split('-').map(Number);
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** year/month 的第 day 天；超過當月天數時取月底。 */
export function clampDay(y, m, day) {
  return ymd(y, m, Math.min(day, daysInMonth(y, m)));
}

export function shiftMonth(y, m, delta) {
  const idx = y * 12 + (m - 1) + delta;
  return [Math.floor(idx / 12), (((idx % 12) + 12) % 12) + 1];
}

export function addMonths(s, n, day) {
  const [y, m, d] = parts(s);
  const [ny, nm] = shiftMonth(y, m, n);
  return clampDay(ny, nm, day ?? d);
}

/** s 當天或之後的第一個結帳日（＝包含 s 的帳單週期的結帳日）。 */
export function closingOnOrAfter(s, statementDay) {
  const [y, m] = parts(s);
  const closing = clampDay(y, m, statementDay);
  if (closing >= s) return closing;
  const [ny, nm] = shiftMonth(y, m, 1);
  return clampDay(ny, nm, statementDay);
}

export function previousClosing(closing, statementDay) {
  const [y, m] = parts(closing);
  const [py, pm] = shiftMonth(y, m, -1);
  return clampDay(py, pm, statementDay);
}

export function nextClosing(closing, statementDay) {
  const [y, m] = parts(closing);
  const [ny, nm] = shiftMonth(y, m, 1);
  return clampDay(ny, nm, statementDay);
}

/** 結帳日之後第一個「每月 dueDay 號」即為繳款截止日。 */
export function dueDateFor(closing, dueDay) {
  const [y, m] = parts(closing);
  const due = clampDay(y, m, dueDay);
  if (due > closing) return due;
  const [ny, nm] = shiftMonth(y, m, 1);
  return clampDay(ny, nm, dueDay);
}

/** 今天（含）以前最後一個已結帳的結帳日。結帳日當天仍算進行中。 */
export function lastClosedBefore(today, statementDay) {
  return previousClosing(closingOnOrAfter(today, statementDay), statementDay);
}

const toUTC = (s) => {
  const [y, m, d] = parts(s);
  return Date.UTC(y, m - 1, d);
};

export function daysBetween(from, to) {
  return Math.round((toUTC(to) - toUTC(from)) / 86400000);
}

export function addDays(s, n) {
  const t = new Date(toUTC(s) + n * 86400000);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function todayString(now = new Date()) {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parts(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function describeDays(target, today) {
  const diff = daysBetween(today, target);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  return diff > 0 ? `${diff} 天後` : `${-diff} 天前`;
}

// ---------------------------------------------------------------- 金額
export function parseAmount(text) {
  let raw = String(text ?? '').trim().replace(/[,，\s]/g, '');
  let sign = 1;
  if (raw.startsWith('-')) {
    sign = -1;
    raw = raw.slice(1);
  } else if (raw.startsWith('+')) {
    raw = raw.slice(1);
  }
  raw = raw.replace(/^(NT\$|nt\$|\$)/, '');
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) throw new Error(`無效的金額：${text}`);
  const [whole, frac = ''] = raw.split('.');
  const cents = Number(whole) * UNIT + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`金額太大：${text}`);
  return sign * cents;
}

export function formatAmount(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / UNIT);
  const rem = abs % UNIT;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rem ? `${sign}$${grouped}.${pad2(rem)}` : `${sign}$${grouped}`;
}

/** 金額（分）轉成輸入框用的文字，例如 123450 → "1234.5"。 */
export function amountToInput(cents) {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const rem = abs % UNIT;
  const whole = Math.floor(abs / UNIT);
  return rem ? `${sign}${whole}.${pad2(rem)}`.replace(/0$/, '') : `${sign}${whole}`;
}

// ---------------------------------------------------------------- 帳單
export const Status = Object.freeze({
  NO_PAYMENT: '免繳',
  PAID: '已繳清',
  MIN_PAID: '已繳最低',
  PENDING: '待繳',
  OVERDUE: '逾期',
});

/**
 * 最低應繳金額（依台灣多數銀行的規則試算）：
 * 一般消費 × 比例（無條件進位到元）+ 須全額繳納的部分（分期當期金額、超過額度的金額），
 * 且不低於下限；應繳總額低於下限時須全額繳清。
 */
export function minimumPayment(balance, ratePercent, floor, fullAmount = 0) {
  if (balance <= 0) return 0;
  if (balance <= floor) return balance;
  const full = Math.min(Math.max(fullAmount, 0), balance);
  const rateMilli = Math.round(ratePercent * 1000);
  const byRate = Math.ceil(((balance - full) * rateMilli) / (100 * 1000 * UNIT)) * UNIT;
  return Math.min(Math.max(byRate + full, floor), balance);
}

export function statementStatus(stmt, today) {
  if (stmt.balance <= 0) return Status.NO_PAYMENT;
  if (stmt.paid >= stmt.balance) return Status.PAID;
  if (stmt.paid >= stmt.minPayment) return Status.MIN_PAID;
  if (today > stmt.dueDate) return Status.OVERDUE;
  return Status.PENDING;
}

/** 分期的每期 {date, amount}：每期取整數元，餘數併入第一期。 */
export function installmentSchedule(inst) {
  const base = Math.floor(Math.floor(inst.totalAmount / inst.periods) / UNIT) * UNIT;
  const first = inst.totalAmount - base * (inst.periods - 1);
  return Array.from({ length: inst.periods }, (_, k) => ({
    date: addMonths(inst.startDate, k),
    amount: k === 0 ? first : base,
  }));
}

export function installmentProgress(inst, today) {
  const schedule = installmentSchedule(inst);
  const posted = schedule.filter((p) => p.date <= today);
  const pending = schedule.filter((p) => p.date > today);
  return {
    installment: inst,
    postedPeriods: posted.length,
    postedAmount: posted.reduce((a, p) => a + p.amount, 0),
    remainingAmount: pending.reduce((a, p) => a + p.amount, 0),
    nextDate: pending.length ? pending[0].date : null,
    finished: pending.length === 0,
  };
}

const sumBetween = (items, startExclusive, endInclusive) =>
  items.reduce((acc, it) => (it.date > startExclusive && it.date <= endInclusive ? acc + it.amount : acc), 0);

/**
 * 計算一張卡在 today 的完整狀態。
 * records = { transactions, payments, installments, overrides }，皆已篩選為此卡的紀錄。
 */
export function buildSnapshot(card, records, today) {
  const sd = card.statementDay;
  const installmentCharges = records.installments
    .flatMap((inst) => installmentSchedule(inst))
    .filter((p) => p.date <= today);
  const charges = records.transactions
    .filter((t) => t.date <= today)
    .map((t) => ({ date: t.date, amount: t.amount }))
    .concat(installmentCharges);
  const pays = records.payments.filter((p) => p.date <= today).map((p) => ({ date: p.date, amount: p.amount }));
  const overrideMap = new Map(
    records.overrides.filter((o) => o.closingDate < today).map((o) => [o.closingDate, o]),
  );

  const anchors = [...charges.map((c) => c.date), ...pays.map((p) => p.date), ...overrideMap.keys()];
  const firstDay = anchors.length ? anchors.reduce((a, b) => (a < b ? a : b)) : today;
  let closing = closingOnOrAfter(firstDay, sd);
  let prevClosing = previousClosing(closing, sd);

  const statements = [];
  let prevBalance = 0;
  let unpaidMin = 0;
  while (closing < today) {
    const credits = sumBetween(pays, prevClosing, closing);
    const newCharges = sumBetween(charges, prevClosing, closing);
    let balance = prevBalance - credits + newCharges;

    const override = overrideMap.get(closing);
    if (override && override.balance !== null && override.balance !== undefined) balance = override.balance;

    let minPayment;
    if (override && override.minPayment !== null && override.minPayment !== undefined) {
      minPayment = override.minPayment;
    } else if (balance > 0) {
      const overLimit = card.creditLimit ? Math.max(balance - card.creditLimit, 0) : 0;
      const fullAmount = sumBetween(installmentCharges, prevClosing, closing) + overLimit;
      const base = minimumPayment(balance, card.minRate, card.minFloor, fullAmount);
      minPayment = Math.min(balance, base + unpaidMin);
    } else {
      minPayment = 0;
    }

    const following = nextClosing(closing, sd);
    const paid = sumBetween(pays, closing, following);
    statements.push({
      closingDate: closing,
      dueDate: dueDateFor(closing, card.dueDay),
      periodStart: addDays(prevClosing, 1),
      previousBalance: prevBalance,
      credits,
      newCharges,
      balance,
      minPayment,
      paid,
      overridden: Boolean(override),
      remaining: Math.max(balance - paid, 0),
      minRemaining: Math.max(minPayment - paid, 0),
    });
    unpaidMin = balance > 0 ? Math.max(minPayment - paid, 0) : 0;
    prevBalance = balance;
    prevClosing = closing;
    closing = following;
  }

  const unbilledCharges = sumBetween(charges, prevClosing, today);
  const unbilledPayments = sumBetween(pays, prevClosing, today);
  const currentBalance = prevBalance - unbilledPayments + unbilledCharges;
  const installments = records.installments.map((i) => installmentProgress(i, today));
  const remainingInstallments = installments.reduce((a, p) => a + p.remainingAmount, 0);
  const totalDebt = currentBalance + remainingInstallments;

  return {
    card,
    today,
    statements,
    latest: statements.length ? statements[statements.length - 1] : null,
    unbilledCharges,
    unbilledPayments,
    unbilledSince: addDays(prevClosing, 1),
    currentBalance,
    installments,
    remainingInstallments,
    totalDebt,
    availableCredit: card.creditLimit - totalDebt,
    nextClosingDate: closing,
    nextDueDate: dueDateFor(closing, card.dueDay),
  };
}

/** 從整份資料中取出某張卡的紀錄並計算狀態。 */
export function snapshotFor(data, card, today) {
  const mine = (r) => r.cardId === card.id;
  return buildSnapshot(
    card,
    {
      transactions: data.transactions.filter(mine),
      payments: data.payments.filter(mine),
      installments: data.installments.filter(mine),
      overrides: data.overrides.filter(mine),
    },
    today,
  );
}

/**
 * 未來 days 天內的提醒事項，依急迫程度排序。
 * kind: 'overdue' 逾期｜'due' 待繳｜'minpaid' 已繳最低但未繳清｜'closing' 即將結帳
 */
export function upcomingEvents(snapshots, today, days = 7) {
  const horizon = addDays(today, days);
  const events = [];
  for (const snap of snapshots) {
    const s = snap.latest;
    if (s) {
      const status = statementStatus(s, today);
      if (status === Status.OVERDUE) {
        events.push({ kind: 'overdue', rank: 0, date: s.dueDate, snap, statement: s });
      } else if (status === Status.PENDING && s.dueDate <= horizon) {
        events.push({ kind: 'due', rank: 1, date: s.dueDate, snap, statement: s });
      } else if (status === Status.MIN_PAID && s.dueDate >= today && s.dueDate <= horizon) {
        events.push({ kind: 'minpaid', rank: 1, date: s.dueDate, snap, statement: s });
      }
    }
    if (snap.nextClosingDate <= horizon) {
      events.push({ kind: 'closing', rank: 2, date: snap.nextClosingDate, snap, statement: null });
    }
  }
  return events.sort((a, b) => a.rank - b.rank || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
