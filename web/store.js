// 資料儲存：全部存在這支手機瀏覽器的 localStorage，不會上傳到任何伺服器。
// 備份檔就是同一份 JSON，可匯出後在新手機匯入。

import { isValidDate } from './billing.js';

export const STORAGE_KEY = 'credit-card-data-v1';
export const DATA_VERSION = 1;

export function emptyData() {
  return {
    version: DATA_VERSION,
    nextId: 1,
    cards: [],
    transactions: [],
    payments: [],
    installments: [],
    overrides: [],
    lastBackupAt: null,
  };
}

// ---------------------------------------------------------------- 驗證
class InvalidData extends Error {}

const fail = (msg) => {
  throw new InvalidData(msg);
};
const isInt = (v) => Number.isSafeInteger(v);
const str = (v, field) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail(`${field} 必須是文字`);
  return v.slice(0, 200);
};
const int = (v, field, { min = -Infinity, max = Infinity } = {}) => {
  if (!isInt(v) || v < min || v > max) fail(`${field} 不是有效的數值：${v}`);
  return v;
};
const day = (v, field) => int(v, field, { min: 1, max: 31 });
const dateField = (v, field) => {
  if (!isValidDate(v)) fail(`${field} 不是有效的日期：${v}`);
  return v;
};

function normalizeCard(c) {
  const name = str(c.name, '卡片名稱').trim();
  if (!name) fail('卡片名稱不可為空白');
  const last4 = str(c.last4, '末四碼');
  if (last4 && !/^\d{4}$/.test(last4)) fail(`末四碼必須是 4 位數字：${last4}`);
  const minRate = Number(c.minRate);
  if (!Number.isFinite(minRate) || minRate < 0 || minRate > 100) fail(`最低應繳比例無效：${c.minRate}`);
  return {
    id: int(c.id, '卡片 ID', { min: 1 }),
    name,
    bank: str(c.bank, '銀行'),
    last4,
    creditLimit: int(c.creditLimit ?? 0, '信用額度', { min: 0 }),
    statementDay: day(c.statementDay, '結帳日'),
    dueDay: day(c.dueDay, '繳款截止日'),
    minRate,
    minFloor: int(c.minFloor ?? 100000, '最低應繳下限', { min: 0 }),
    note: str(c.note, '備註'),
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') fail('檔案內容不是有效的備份資料');
  if (raw.version !== DATA_VERSION) fail(`不支援的資料版本：${raw.version}`);
  const arr = (v, field) => {
    if (!Array.isArray(v)) fail(`缺少 ${field} 資料`);
    return v;
  };
  const cards = arr(raw.cards, 'cards').map(normalizeCard);
  const cardIds = new Set(cards.map((c) => c.id));
  if (cardIds.size !== cards.length) fail('卡片 ID 重複');
  const cardId = (v) => {
    if (!cardIds.has(v)) fail(`紀錄指向不存在的卡片：${v}`);
    return v;
  };
  const data = {
    version: DATA_VERSION,
    nextId: 1,
    cards,
    transactions: arr(raw.transactions, 'transactions').map((t) => ({
      id: int(t.id, '消費 ID', { min: 1 }),
      cardId: cardId(t.cardId),
      date: dateField(t.date, '消費日期'),
      amount: int(t.amount, '消費金額'),
      description: str(t.description, '說明'),
      category: str(t.category, '類別'),
    })),
    payments: arr(raw.payments, 'payments').map((p) => ({
      id: int(p.id, '繳款 ID', { min: 1 }),
      cardId: cardId(p.cardId),
      date: dateField(p.date, '繳款日期'),
      amount: int(p.amount, '繳款金額', { min: 1 }),
      note: str(p.note, '備註'),
    })),
    installments: arr(raw.installments, 'installments').map((i) => ({
      id: int(i.id, '分期 ID', { min: 1 }),
      cardId: cardId(i.cardId),
      startDate: dateField(i.startDate, '分期首期日期'),
      totalAmount: int(i.totalAmount, '分期總額', { min: 1 }),
      periods: int(i.periods, '分期期數', { min: 1, max: 360 }),
      description: str(i.description, '說明'),
    })),
    overrides: arr(raw.overrides, 'overrides').map((o) => ({
      cardId: cardId(o.cardId),
      closingDate: dateField(o.closingDate, '結帳日'),
      balance: o.balance === null || o.balance === undefined ? null : int(o.balance, '應繳總額'),
      minPayment:
        o.minPayment === null || o.minPayment === undefined ? null : int(o.minPayment, '最低應繳', { min: 0 }),
    })),
    lastBackupAt: typeof raw.lastBackupAt === 'string' ? raw.lastBackupAt : null,
  };
  const allIds = [
    ...cards.map((c) => c.id),
    ...data.transactions.map((t) => t.id),
    ...data.payments.map((p) => p.id),
    ...data.installments.map((i) => i.id),
  ];
  data.nextId = Math.max(int(raw.nextId ?? 1, 'nextId', { min: 1 }), ...allIds.map((id) => id + 1), 1);
  return data;
}

/** 解析匯入的備份檔文字；格式錯誤時丟出含中文說明的 Error。 */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('檔案不是有效的 JSON 備份檔');
  }
  try {
    return normalize(raw);
  } catch (err) {
    if (err instanceof InvalidData) throw new Error(`備份檔內容有誤：${err.message}`);
    throw err;
  }
}

export function serializeBackup(data) {
  return JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2);
}

// ---------------------------------------------------------------- 讀寫
export function storageAvailable() {
  try {
    const probe = '__ccm_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** 讀取資料。回傳 { data, error }；資料損毀時 error 會說明原因，並保留原始內容不覆寫。 */
export function load() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { data: emptyData(), error: '無法讀取瀏覽器儲存空間（可能是無痕模式）。' };
  }
  if (!raw) return { data: emptyData(), error: null };
  try {
    return { data: normalize(JSON.parse(raw)), error: null };
  } catch (err) {
    return { data: emptyData(), error: `資料讀取失敗：${err.message}`, corrupted: raw };
  }
}

export function save(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function nextId(data) {
  const id = data.nextId;
  data.nextId += 1;
  return id;
}
