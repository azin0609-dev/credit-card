// 信用卡管理 App 的畫面與操作。資料只存在這支手機（localStorage）。

import {
  Status,
  amountToInput,
  closingOnOrAfter,
  daysBetween,
  describeDays,
  dueDateFor,
  formatAmount as money,
  isValidDate,
  lastClosedBefore,
  parseAmount,
  parts,
  previousClosing,
  snapshotFor,
  statementStatus,
  todayString,
  upcomingEvents,
} from './billing.js';
import { buildIcs, googleCalendarUrl } from './calendar.js';
import { cardColorName, cardStyle, dinoSvg, footprintSvg, moodForTone } from './dino.js';
import * as store from './store.js';

const APP_VERSION = '1.2.0';
const CATEGORIES = ['餐飲', '交通', '購物', '生活', '娛樂', '醫療', '旅遊', '其他'];
const BACKUP_REMIND_DAYS = 30;
const UI_PREFS_KEY = 'credit-card-ui-v1';
const DRAFTS_KEY = 'credit-card-drafts-v1';
const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const appEl = document.getElementById('app');
const navEl = document.getElementById('nav');
const toastEl = document.getElementById('toast');

const canStore = store.storageAvailable();
const loaded = store.load();
let data = loaded.data;
const loadError = loaded.error;
const corruptedRaw = loaded.corrupted ?? null;

// ---------------------------------------------------------------- 小工具
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const today = () => todayString();
const cardById = (id) => data.cards.find((c) => c.id === id);
const snapshots = () => data.cards.map((c) => snapshotFor(data, c, today()));
const cardLabel = (c) => (c.last4 ? `${c.name} *${c.last4}` : c.name);

function shortDate(s) {
  const [y, m, d] = parts(s);
  return y === parts(today())[0] ? `${m}/${d}` : `${y}/${m}/${d}`;
}

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writePrefs(patch) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    /* 無法儲存偏好設定不影響使用 */
  }
}

// ---------------------------------------------------------------- 表單草稿
// 填到一半跳去別的頁面（或切到別的 App）再回來，內容會自動恢復；儲存成功後才清除。
let submittingDraftKey = null;

function readDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeDrafts(drafts) {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* 無法儲存草稿不影響使用 */
  }
}

function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'submit' || el.type === 'button' || el.hasAttribute('data-nav-stmt')) continue;
    values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return values;
}

function saveDraft(form) {
  const key = form.dataset.draft;
  if (!key) return;
  const drafts = readDrafts();
  drafts[key] = { savedAt: Date.now(), values: formValues(form) };
  writeDrafts(drafts);
}

function clearDraft(key) {
  const drafts = readDrafts();
  if (key in drafts) {
    delete drafts[key];
    writeDrafts(drafts);
  }
}

/** 把草稿填回表單；有恢復內容時在表單上方顯示提示。 */
function restoreDraft(form) {
  const key = form.dataset.draft;
  const draft = readDrafts()[key];
  if (!draft?.values) return;
  if (Date.now() - (draft.savedAt || 0) > DRAFT_TTL_MS) {
    clearDraft(key);
    return;
  }
  // 從某張卡片頁點進來「記一筆」時，只恢復同一張卡的草稿
  const lockedCard = form.dataset.draftCard;
  if (lockedCard && draft.values.cardId && draft.values.cardId !== lockedCard) return;
  const initial = formValues(form);
  const differs = Object.entries(draft.values).some(([k, v]) => k in initial && initial[k] !== v);
  if (!differs) return;
  for (const el of form.elements) {
    if (!el.name || !(el.name in draft.values) || el.hasAttribute('data-nav-stmt')) continue;
    const v = draft.values[el.name];
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (el.tagName === 'SELECT') {
      if ([...el.options].some((o) => o.value === v)) el.value = v;
    } else el.value = v;
  }
  form.insertAdjacentHTML(
    'afterbegin',
    `<div class="draft-note" role="status"><span>已恢復你上次還沒儲存的內容</span>
      <button type="button" class="link" data-action="discard-draft" data-key="${esc(key)}">清除重填</button></div>`,
  );
}

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let toastTimer;
function toast(message, tone = 'ok') {
  toastEl.textContent = message;
  toastEl.className = `toast ${tone}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, tone === 'error' ? 5000 : 3000);
}

let persistenceRequested = false;
function persist() {
  if (corruptedRaw) throw new Error('資料讀取失敗，為了不覆蓋原始資料，目前無法儲存。');
  if (!canStore) return; // 無痕模式：只存在記憶體
  store.save(data);
  if (!persistenceRequested && navigator.storage?.persist) {
    persistenceRequested = true;
    navigator.storage.persist().catch(() => {});
  }
}

/** 修改資料並儲存；失敗時還原。 */
function commit(mutate, message, nextHash) {
  const before = JSON.stringify(data);
  try {
    mutate(data);
    persist();
  } catch (err) {
    data = JSON.parse(before);
    toast(err.message, 'error');
    return false;
  }
  if (submittingDraftKey) clearDraft(submittingDraftKey);
  if (message) toast(message);
  if (nextHash && location.hash !== nextHash) location.hash = nextHash;
  else render();
  return true;
}

function downloadFile(name, type, text) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------- 狀態顯示
const TONE = {
  [Status.NO_PAYMENT]: 'muted',
  [Status.PAID]: 'ok',
  [Status.MIN_PAID]: 'info',
  [Status.PENDING]: 'warn',
  [Status.OVERDUE]: 'danger',
};

function statusInfo(stmt, t, historical = false) {
  const st = statementStatus(stmt, t);
  if (historical) return { text: st === Status.OVERDUE ? '逾期未繳' : st, tone: TONE[st] };
  if (st === Status.PENDING) {
    const d = daysBetween(t, stmt.dueDate);
    return { text: d === 0 ? '今天截止' : `待繳・剩 ${d} 天`, tone: d <= 3 ? 'danger' : 'warn' };
  }
  if (st === Status.OVERDUE) return { text: `逾期 ${daysBetween(stmt.dueDate, t)} 天`, tone: 'danger' };
  return { text: st, tone: TONE[st] };
}

const chip = ({ text, tone }) => `<span class="chip ${tone}">${esc(text)}</span>`;

function header(title, { back = null, sub = '' } = {}) {
  return `
    <header class="page-head">
      ${
        back
          ? `<a class="back" href="${back}" aria-label="返回"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></a>`
          : ''
      }
      <div>
        <h1>${esc(title)}</h1>
        ${sub ? `<p class="sub">${sub}</p>` : ''}
      </div>
    </header>`;
}

function kv(rows) {
  return `<dl class="kv">${rows
    .map(([k, v, cls = '']) => `<div class="${cls}"><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join('')}</dl>`;
}

function banners() {
  const list = [];
  if (!canStore) {
    list.push(
      `<div class="banner danger">無法使用瀏覽器儲存空間（可能是無痕模式），關閉頁面後資料會消失。請改用一般模式開啟。</div>`,
    );
  } else if (loadError && !corruptedRaw) {
    list.push(`<div class="banner danger">${esc(loadError)}</div>`);
  }
  return list.join('');
}

// ---------------------------------------------------------------- 總覽
function eventText(ev, t) {
  const name = esc(ev.snap.card.name);
  const s = ev.statement;
  switch (ev.kind) {
    case 'overdue':
      return {
        tone: 'danger',
        title: `${name} 已逾期 ${daysBetween(s.dueDate, t)} 天`,
        sub: `最低應繳尚差 ${money(s.minRemaining)}，全額尚差 ${money(s.remaining)}`,
      };
    case 'due':
      return {
        tone: daysBetween(t, s.dueDate) <= 3 ? 'danger' : 'warn',
        title: `${name} ${shortDate(s.dueDate)} 繳款截止（${describeDays(s.dueDate, t)}）`,
        sub: `最低 ${money(s.minRemaining)}・全額 ${money(s.remaining)}`,
      };
    case 'minpaid':
      return {
        tone: 'info',
        title: `${name} 已繳最低應繳`,
        sub: `${shortDate(s.dueDate)} 前繳清剩餘 ${money(s.remaining)} 可避免循環利息`,
      };
    default:
      return {
        tone: 'muted',
        title: `${name} ${shortDate(ev.date)} 結帳（${describeDays(ev.date, t)}）`,
        sub: `目前未出帳消費 ${money(ev.snap.unbilledCharges)}`,
      };
  }
}

const TONE_COLOR = { danger: 'coral', warn: 'butter', info: 'sky' };

function alertList(events, t) {
  return events
    .map((ev) => {
      const { tone, title, sub } = eventText(ev, t);
      const color = TONE_COLOR[tone] ?? cardColorName(ev.snap.card);
      const mood = tone === 'muted' ? 'calm' : moodForTone(tone);
      return `<a class="alert ${tone}" href="#/card/${ev.snap.card.id}">
        <span class="avatar">${dinoSvg({ color, mood, head: true })}</span>
        <span class="alert-text"><strong>${title}</strong><span>${sub}</span></span></a>`;
    })
    .join('');
}

/** 首頁小恐龍要說的話：挑最需要注意的一件事。 */
function helperMessage(snaps, t) {
  const withStatus = snaps
    .filter((s) => s.latest)
    .map((s) => ({ snap: s, s: s.latest, status: statementStatus(s.latest, t) }));
  const name = (x) => esc(x.snap.card.name);

  const overdue = withStatus.filter((x) => x.status === Status.OVERDUE);
  if (overdue.length) {
    return {
      tone: 'danger',
      color: 'coral',
      mood: 'alarmed',
      title: overdue.length === 1 ? `${name(overdue[0])} 逾期了！` : `有 ${overdue.length} 張卡逾期了！`,
      sub: '快去繳最低應繳金額，避免影響信用喔',
    };
  }
  const pending = withStatus
    .filter((x) => x.status === Status.PENDING)
    .sort((a, b) => (a.s.dueDate < b.s.dueDate ? -1 : 1));
  if (pending.length) {
    const x = pending[0];
    const d = daysBetween(t, x.s.dueDate);
    const more = pending.length > 1 ? `，另有 ${pending.length - 1} 張待繳` : '';
    if (d <= 7) {
      return {
        tone: 'warn',
        color: 'butter',
        mood: 'worried',
        title: d === 0 ? `${name(x)} 今天要繳款！` : `${name(x)} 還有 ${d} 天要繳款`,
        sub: `最低 ${money(x.s.minRemaining)}・全額 ${money(x.s.remaining)}${more}`,
      };
    }
    return {
      tone: 'info',
      color: 'mint',
      mood: 'calm',
      title: `下一筆：${name(x)} ${shortDate(x.s.dueDate)} 截止`,
      sub: `還有 ${d} 天・全額 ${money(x.s.remaining)}${more}`,
    };
  }
  const minPaid = withStatus.find((x) => x.status === Status.MIN_PAID && t <= x.s.dueDate);
  if (minPaid) {
    return {
      tone: 'info',
      color: 'sky',
      mood: 'calm',
      title: '最低應繳都繳了',
      sub: `${shortDate(minPaid.s.dueDate)} 前繳清剩餘 ${money(minPaid.s.remaining)} 可以避免循環利息`,
    };
  }
  return {
    tone: 'ok',
    color: 'mint',
    mood: 'happy',
    title: '目前沒有待繳的帳單',
    sub: '好棒！記得每次刷卡都來記一筆喔',
  };
}

function installHint() {
  if (isStandalone() || readPrefs().hideInstallHint) return '';
  const how = isIOS()
    ? '用 Safari 開啟本頁，點網址列的「≡」或「⋯」→「分享」→「加入主畫面」（舊版 iOS 直接點下方「分享」按鈕）。'
    : '點瀏覽器選單（⋮）→「安裝應用程式」或「加到主畫面」。';
  return `<div class="banner info">
    <div><strong>建議加到手機主畫面</strong><br>${how}加到主畫面後開啟更快，資料也較不會被瀏覽器清除。</div>
    <button class="link" data-action="hide-install-hint">知道了</button>
  </div>`;
}

function backupHint() {
  if (!data.cards.length) return '';
  const last = data.lastBackupAt;
  const stale = !last || daysBetween(last.slice(0, 10), today()) >= BACKUP_REMIND_DAYS;
  if (!stale) return '';
  return `<a class="banner warn" href="#/settings">
    <div><strong>${last ? `已經 ${daysBetween(last.slice(0, 10), today())} 天沒有備份` : '還沒有備份過資料'}</strong><br>
    資料只存在這支手機，換手機或清除瀏覽器資料就會不見。點這裡匯出備份檔。</div></a>`;
}

function viewHome() {
  const t = today();
  if (!data.cards.length) {
    return `${banners()}
      <section class="hero">
        <div class="hero-art">${footprintSvg()}${footprintSvg()}${dinoSvg({ color: 'mint', mood: 'happy', holding: true })}</div>
        <h1>我的信用卡</h1>
        <p>記錄每張卡的結帳日、繳款截止日、最低應繳金額與欠款，到期前提醒你繳費。</p>
        <p class="muted small">資料只存在這支手機，不會上傳到任何地方。家人各自在自己的手機使用，資料互不相通。</p>
        <a class="btn primary block" href="#/card/new">新增第一張卡</a>
        <button class="btn block" data-action="pick-import">從備份檔還原</button>
      </section>
      ${installHint()}`;
  }

  const snaps = snapshots();
  const events = upcomingEvents(snaps, t, 7).filter(
    (e) => e.kind !== 'closing' || daysBetween(t, e.date) <= 3,
  );
  const latest = snaps.map((s) => s.latest).filter(Boolean);
  const needFull = latest.reduce((a, s) => a + s.remaining, 0);
  const needMin = latest.reduce((a, s) => a + s.minRemaining, 0);
  const totalDebt = snaps.reduce((a, s) => a + s.totalDebt, 0);

  const tiles = snaps
    .map((snap) => {
      const s = snap.latest;
      const c = snap.card;
      const body = s
        ? `<div class="tile-main">
            <div><small>本期應繳</small><strong class="num">${money(s.balance)}</strong></div>
            <div><small>最低應繳</small><span class="num">${money(s.minPayment)}</span></div>
            <div><small>繳款截止</small><span>${shortDate(s.dueDate)}</span></div>
          </div>`
        : `<p class="tile-empty">尚無已結帳的帳單・${shortDate(snap.nextClosingDate)} 結帳</p>`;
      const foot = [
        `未出帳 <span class="num">${money(snap.unbilledCharges)}</span>`,
        `總欠款 <span class="num">${money(snap.totalDebt)}</span>`,
      ];
      if (c.creditLimit) foot.push(`可用 <span class="num">${money(snap.availableCredit)}</span>`);
      const info = s ? statusInfo(s, t) : { text: '尚未結帳', tone: 'muted' };
      return `<a class="tile" href="#/card/${c.id}" style="${cardStyle(c)}">
          <div class="tile-head">
            <span class="avatar">${dinoSvg({ color: cardColorName(c), mood: moodForTone(info.tone), head: true })}</span>
            <span class="tile-title">
              <span class="tile-name">${esc(cardLabel(c))}</span>
              <span class="tile-sub">每月 ${c.statementDay} 日結帳・${c.dueDay} 日截止</span>
            </span>
            ${chip(info)}
          </div>
          ${body}
          <div class="tile-foot">${foot.join('<span class="dot">・</span>')}</div>
        </a>`;
    })
    .join('');

  const helper = helperMessage(snaps, t);
  return `${banners()}
    ${header('我的信用卡', { sub: `${t}（${'日一二三四五六'[new Date().getDay()]}）` })}
    <section class="helper">
      <div class="helper-dino">${dinoSvg({ color: helper.color, mood: helper.mood })}</div>
      <div class="bubble ${helper.tone}" role="status"><strong>${helper.title}</strong><span>${helper.sub}</span></div>
    </section>
    ${events.length ? `<section class="alerts">${alertList(events, t)}</section>` : ''}
    <section class="stats">
      <div><small>本期尚需繳清</small><strong class="num">${money(needFull)}</strong></div>
      <div><small>最低應繳尚差</small><strong class="num">${money(needMin)}</strong></div>
      <div><small>總欠款</small><strong class="num">${money(totalDebt)}</strong></div>
    </section>
    <section class="tiles">${tiles}</section>
    <a class="btn block" href="#/card/new">＋ 新增卡片</a>
    ${backupHint()}
    ${installHint()}`;
}

// ---------------------------------------------------------------- 卡片詳情
function recordRow({ date, amount, title, sub = '', kind, id }) {
  return `<li class="row">
      <div class="row-main">
        <span class="row-title">${title}</span>
        <span class="row-sub">${shortDate(date)}${sub ? `・${sub}` : ''}</span>
      </div>
      <span class="num ${amount < 0 ? 'credit' : ''}">${money(amount)}</span>
      <button class="icon-btn" data-action="delete" data-kind="${kind}" data-id="${id}" aria-label="刪除">✕</button>
    </li>`;
}

function viewCard(id) {
  const card = cardById(id);
  if (!card) return viewNotFound('找不到這張卡片');
  const t = today();
  const snap = snapshotFor(data, card, t);
  const s = snap.latest;

  const sub = [card.bank, `每月 ${card.statementDay} 日結帳・${card.dueDay} 日繳款截止`]
    .filter(Boolean)
    .map(esc)
    .join('<br>');

  let statementPanel;
  if (s) {
    const actions = [];
    if (s.minRemaining > 0 && s.minRemaining < s.remaining) {
      actions.push(
        `<button class="btn" data-action="quick-pay" data-card="${id}" data-amount="${s.minRemaining}" data-label="最低應繳">繳最低 ${money(s.minRemaining)}</button>`,
      );
    }
    if (s.remaining > 0) {
      actions.push(
        `<button class="btn primary" data-action="quick-pay" data-card="${id}" data-amount="${s.remaining}" data-label="全額">繳清 ${money(s.remaining)}</button>`,
        `<a class="btn" href="#/add?type=payment&card=${id}">其他金額</a>`,
      );
    }
    const info = statusInfo(s, t);
    statementPanel = `
      <section class="panel statement" style="${cardStyle(card)}">
        <div class="peek">${dinoSvg({ color: cardColorName(card), mood: moodForTone(info.tone) })}</div>
        <div class="panel-head"><h2>本期帳單</h2>${chip(info)}</div>
        <p class="muted small">${s.closingDate} 結帳（${s.overridden ? '銀行帳單金額' : '程式試算'}）・繳款截止 ${s.dueDate}（${describeDays(s.dueDate, t)}）</p>
        <div class="big-grid">
          <div><small>本期應繳</small><strong class="num">${money(s.balance)}</strong></div>
          <div><small>最低應繳</small><strong class="num">${money(s.minPayment)}</strong></div>
          <div><small>已繳</small><span class="num">${money(s.paid)}</span></div>
          <div><small>尚未繳清</small><span class="num">${money(s.remaining)}</span></div>
        </div>
        ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
        <a class="link small" href="#/stmt/${id}/${s.closingDate}">${s.overridden ? '修改' : '輸入'}銀行帳單上的實際金額</a>
      </section>`;
  } else {
    statementPanel = `
      <section class="panel statement" style="${cardStyle(card)}">
        <div class="peek">${dinoSvg({ color: cardColorName(card), mood: 'calm' })}</div>
        <div class="panel-head"><h2>本期帳單</h2></div>
        <p class="muted">還沒有已結帳的帳單。下次結帳日 ${snap.nextClosingDate}（${describeDays(snap.nextClosingDate, t)}）。</p>
        <a class="btn block" href="#/stmt/${id}/${lastClosedBefore(t, card.statementDay)}">已經收到銀行帳單？輸入帳單金額</a>
        <p class="hint">只有銀行已經寄來、還沒繳的帳單才需要輸入。結帳日之後的新消費請用「記一筆」，會自動算到下一期。</p>
      </section>`;
  }

  const debtRows = [
    ['未出帳消費', `<span class="num">${money(snap.unbilledCharges)}</span>`],
    ['目前帳上欠款', `<span class="num">${money(snap.currentBalance)}</span>`],
    ['未到期分期', `<span class="num">${money(snap.remainingInstallments)}</span>`],
    ['總欠款', `<strong class="num">${money(snap.totalDebt)}</strong>`, 'em'],
  ];
  if (card.creditLimit) {
    debtRows.push([
      '可用額度',
      `<span class="num">${money(snap.availableCredit)}</span> <span class="muted">／${money(card.creditLimit)}</span>`,
    ]);
  }

  const mine = (r) => r.cardId === id;
  const txns = data.transactions.filter(mine).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const unbilled = txns.filter((x) => x.date >= snap.unbilledSince && x.date <= t);
  const txnRow = (x) =>
    recordRow({
      date: x.date,
      amount: x.amount,
      title: esc(x.description || (x.amount < 0 ? '退款' : '消費')),
      sub: esc(x.category),
      kind: 'transactions',
      id: x.id,
    });

  const activeInst = snap.installments.filter((p) => !p.finished);
  const payments = data.payments
    .filter(mine)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
    .slice(0, 20);
  const history = snap.statements.slice(-12).reverse();

  return `${banners()}
    ${header(cardLabel(card), { back: '#/', sub })}
    ${statementPanel}
    <section class="panel">
      <h2>欠款概況</h2>
      ${kv(debtRows)}
      <p class="muted small">下次結帳 ${snap.nextClosingDate}（${describeDays(snap.nextClosingDate, t)}），該期繳款截止 ${snap.nextDueDate}</p>
    </section>
    <div class="actions">
      <a class="btn primary" href="#/add?type=txn&card=${id}">＋ 記一筆消費</a>
      <a class="btn" href="#/add?type=installment&card=${id}">＋ 分期</a>
    </div>
    <section class="panel">
      <h2>未出帳消費 <span class="muted small">${shortDate(snap.unbilledSince)} 起</span></h2>
      ${unbilled.length ? `<ul class="rows">${unbilled.map(txnRow).join('')}</ul>` : '<p class="muted small">目前沒有未出帳消費。</p>'}
    </section>
    ${
      activeInst.length
        ? `<section class="panel"><h2>進行中的分期</h2><ul class="rows">${activeInst
            .map(
              (p) => `<li class="row">
                <div class="row-main">
                  <span class="row-title">${esc(p.installment.description || '分期')}</span>
                  <span class="row-sub">${money(p.installment.totalAmount)}・已入帳 ${p.postedPeriods}/${p.installment.periods} 期・下期 ${shortDate(p.nextDate)}</span>
                </div>
                <span class="num">${money(p.remainingAmount)}</span>
                <button class="icon-btn" data-action="delete" data-kind="installments" data-id="${p.installment.id}" aria-label="刪除">✕</button>
              </li>`,
            )
            .join('')}</ul></section>`
        : ''
    }
    ${
      history.length
        ? `<section class="panel"><h2>歷期帳單</h2><ul class="rows">${history
            .map(
              (h, i) => `<li><a class="row" href="#/stmt/${id}/${h.closingDate}">
                <div class="row-main">
                  <span class="row-title">${h.closingDate} 結帳${h.overridden ? ' <span class="tag">帳單</span>' : ''}</span>
                  <span class="row-sub">應繳 ${money(h.balance)}・最低 ${money(h.minPayment)}・已繳 ${money(h.paid)}</span>
                </div>
                ${chip(statusInfo(h, t, i !== 0))}
              </a></li>`,
            )
            .join('')}</ul></section>`
        : ''
    }
    ${
      payments.length
        ? `<section class="panel"><h2>繳款紀錄</h2><ul class="rows">${payments
            .map((p) =>
              recordRow({
                date: p.date,
                amount: p.amount,
                title: esc(p.note || '繳款'),
                kind: 'payments',
                id: p.id,
              }),
            )
            .join('')}</ul></section>`
        : ''
    }
    ${
      txns.length
        ? `<details class="panel"><summary>全部消費紀錄（${txns.length} 筆）</summary>
            <ul class="rows">${txns.slice(0, 300).map(txnRow).join('')}</ul></details>`
        : ''
    }
    ${card.note ? `<section class="panel"><h2>備註</h2><p>${esc(card.note)}</p></section>` : ''}
    <div class="actions">
      <a class="btn" href="#/edit/${id}">編輯卡片</a>
      <button class="btn danger-text" data-action="delete-card" data-id="${id}">刪除卡片</button>
    </div>`;
}

// ---------------------------------------------------------------- 卡片表單
function dayOptions(selected) {
  return Array.from(
    { length: 31 },
    (_, i) => `<option value="${i + 1}" ${selected === i + 1 ? 'selected' : ''}>${i + 1} 日</option>`,
  ).join('');
}

function schedulePreview(statementDay, dueDay) {
  const t = today();
  const closing = closingOnOrAfter(t, statementDay);
  const due = dueDateFor(closing, dueDay);
  const gap = daysBetween(closing, due);
  return `下次結帳 ${closing}，該期繳款截止 ${due}（結帳後 ${gap} 天）`;
}

function viewCardForm(id = null) {
  const card = id ? cardById(id) : null;
  if (id && !card) return viewNotFound('找不到這張卡片');
  const c = card ?? {
    name: '',
    bank: '',
    last4: '',
    creditLimit: 0,
    statementDay: 5,
    dueDay: 20,
    minRate: 10,
    minFloor: 1000 * 100,
    note: '',
  };
  return `
    ${header(card ? '編輯卡片' : '新增卡片', { back: card ? `#/card/${id}` : '#/' })}
    <form class="form" data-form="card" data-draft="${card ? `card:edit:${id}` : 'card:new'}" ${card ? `data-id="${id}"` : ''} novalidate>
      <label>卡片名稱<input name="name" required maxlength="40" value="${esc(c.name)}" placeholder="例如：國泰 CUBE"></label>
      <div class="two">
        <label>發卡銀行<input name="bank" maxlength="40" value="${esc(c.bank)}" placeholder="選填"></label>
        <label>卡號末四碼<input name="last4" inputmode="numeric" maxlength="4" value="${esc(c.last4)}" placeholder="選填"></label>
      </div>
      <div class="two">
        <label>每月結帳日<select name="statementDay" data-preview>${dayOptions(c.statementDay)}</select></label>
        <label>每月繳款截止日<select name="dueDay" data-preview>${dayOptions(c.dueDay)}</select></label>
      </div>
      <p class="hint" id="schedule-preview">${schedulePreview(c.statementDay, c.dueDay)}</p>
      <label>信用額度<input name="creditLimit" inputmode="decimal" value="${c.creditLimit ? amountToInput(c.creditLimit) : ''}" placeholder="選填，例如 100000"></label>
      <details class="sub-details">
        <summary>最低應繳計算方式（一般不用改）</summary>
        <div class="two">
          <label>一般消費比例 %<input name="minRate" inputmode="decimal" value="${esc(c.minRate)}"></label>
          <label>最低應繳下限<input name="minFloor" inputmode="decimal" value="${amountToInput(c.minFloor)}"></label>
        </div>
        <p class="hint">最低應繳 = 一般消費 × 比例 + 分期當期金額 + 超過額度部分 + 前期未繳足的最低應繳；不足下限以下限計，應繳總額低於下限則須全額繳清。實際以銀行帳單為準。</p>
      </details>
      <label>備註<textarea name="note" rows="2" maxlength="200" placeholder="選填，例如 回饋規則、自動扣繳帳戶">${esc(c.note)}</textarea></label>
      <button class="btn primary block" type="submit">${card ? '儲存' : '新增卡片'}</button>
    </form>`;
}

// ---------------------------------------------------------------- 記一筆
const RECORD_TYPES = [
  ['txn', '消費'],
  ['refund', '退款'],
  ['payment', '繳款'],
  ['installment', '分期'],
];

function viewAdd(query) {
  if (!data.cards.length) {
    return `${header('記一筆')}
      <section class="panel"><p>請先新增一張信用卡。</p><a class="btn primary block" href="#/card/new">新增卡片</a></section>`;
  }
  const type = RECORD_TYPES.some(([k]) => k === query.get('type')) ? query.get('type') : 'txn';
  const explicitCard = Number(query.get('card')) || null;
  const draftCard = Number(readDrafts()[`record:${type}`]?.values?.cardId) || null;
  const cardId = explicitCard || draftCard || readPrefs().lastCardId || data.cards[0].id;
  const selected = cardById(cardId) ?? data.cards[0];
  const t = today();

  const tabs = RECORD_TYPES.map(
    ([k, label]) =>
      `<a class="seg ${k === type ? 'active' : ''}" href="#/add?type=${k}&card=${selected.id}" ${
        k === type ? 'aria-current="page"' : ''
      }>${label}</a>`,
  ).join('');

  const cardSelect = `<label>信用卡<select name="cardId" data-card-switch>${data.cards
    .map((c) => `<option value="${c.id}" ${c.id === selected.id ? 'selected' : ''}>${esc(cardLabel(c))}</option>`)
    .join('')}</select></label>`;

  let fields = '';
  if (type === 'txn' || type === 'refund') {
    const used = new Set(data.transactions.map((x) => x.category).filter(Boolean));
    const cats = [...new Set([...CATEGORIES, ...used])];
    fields = `
      <label>${type === 'refund' ? '退款金額' : '消費金額'}<input name="amount" inputmode="decimal" required autocomplete="off" placeholder="0"></label>
      <label>日期<input name="date" type="date" value="${t}" required></label>
      <p class="hint cycle-hint" data-cycle-hint></p>
      <label>說明<input name="description" maxlength="60" placeholder="${type === 'refund' ? '例如：退貨' : '例如：晚餐'}"></label>
      ${
        type === 'txn'
          ? `<label>類別<input name="category" list="categories" maxlength="20" placeholder="選填"></label>
             <datalist id="categories">${cats.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`
          : ''
      }`;
  } else if (type === 'payment') {
    const s = snapshotFor(data, selected, t).latest;
    const quick = [];
    if (s && s.minRemaining > 0) quick.push(`<button type="button" class="pill" data-fill="${amountToInput(s.minRemaining)}">最低 ${money(s.minRemaining)}</button>`);
    if (s && s.remaining > 0) quick.push(`<button type="button" class="pill" data-fill="${amountToInput(s.remaining)}">全額 ${money(s.remaining)}</button>`);
    fields = `
      <label>繳款金額<input name="amount" inputmode="decimal" required autocomplete="off" placeholder="0"></label>
      ${quick.length ? `<div class="pills">${quick.join('')}</div>` : ''}
      <label>繳款日期<input name="date" type="date" value="${t}" required></label>
      <label>備註<input name="note" maxlength="60" placeholder="選填，例如：自動扣繳"></label>`;
  } else {
    fields = `
      <label>分期總金額<input name="amount" inputmode="decimal" required autocomplete="off" placeholder="0"></label>
      <label>期數<input name="periods" inputmode="numeric" required placeholder="例如 12"></label>
      <label>第一期入帳日<input name="date" type="date" value="${t}" required></label>
      <p class="hint cycle-hint" data-cycle-hint></p>
      <label>說明<input name="description" maxlength="60" placeholder="例如：手機"></label>
      <p class="hint">每期取整數元，餘數併入第一期；之後每月同一天自動入帳一期。分期當期金額會全額計入最低應繳。</p>`;
  }

  return `
    ${header('記一筆')}
    <nav class="segmented" aria-label="類型">${tabs}</nav>
    <form class="form" data-form="record" data-type="${type}" data-draft="record:${type}" ${
      explicitCard ? `data-draft-card="${explicitCard}"` : ''
    } novalidate>
      ${cardSelect}
      ${fields}
      <button class="btn primary block" type="submit">儲存</button>
    </form>`;
}

// ---------------------------------------------------------------- 帳單金額
function viewStatementForm(cardId, closing) {
  const card = cardById(cardId);
  if (!card) return viewNotFound('找不到這張卡片');
  const t = today();
  if (!isValidDate(closing) || closingOnOrAfter(closing, card.statementDay) !== closing || closing >= t) {
    return viewNotFound('這不是一個已結帳的結帳日');
  }
  const override = data.overrides.find((o) => o.cardId === cardId && o.closingDate === closing);
  // 試算值（不含這期的手動金額）
  const computedData = {
    ...data,
    overrides: data.overrides.filter((o) => !(o.cardId === cardId && o.closingDate === closing)),
  };
  const computed = snapshotFor(computedData, card, t).statements.find((x) => x.closingDate === closing);

  const recent = [];
  let c = lastClosedBefore(t, card.statementDay);
  for (let i = 0; i < 12; i += 1) {
    recent.push(c);
    c = previousClosing(c, card.statementDay);
  }
  if (!recent.includes(closing)) recent.push(closing);

  return `
    ${header('銀行帳單金額', { back: `#/card/${cardId}`, sub: esc(cardLabel(card)) })}
    <form class="form" data-form="statement" data-card="${cardId}" data-draft="stmt:${cardId}:${closing}" novalidate>
      <label>結帳日<select name="closing" data-nav-stmt="${cardId}">${recent
        .map((d) => `<option value="${d}" ${d === closing ? 'selected' : ''}>${d}（繳款截止 ${dueDateFor(d, card.dueDay)}）</option>`)
        .join('')}</select></label>
      <label>本期應繳總額<input name="balance" inputmode="decimal" autocomplete="off" value="${override && override.balance !== null ? amountToInput(override.balance) : ''}" placeholder="試算：${computed ? money(computed.balance) : '$0'}"></label>
      <label>最低應繳金額<input name="minPayment" inputmode="decimal" autocomplete="off" value="${override && override.minPayment !== null ? amountToInput(override.minPayment) : ''}" placeholder="試算：${computed ? money(computed.minPayment) : '$0'}"></label>
      <p class="hint">照銀行帳單填寫；留白的欄位會使用程式試算的數字。之後各期會以這期的金額為基礎接續計算。<br>
      這裡只填<strong>銀行已經寄來的帳單</strong>。結帳日之後的新消費請到「記一筆」記錄，不要填在這裡。</p>
      <button class="btn primary block" type="submit">儲存</button>
      ${override ? `<button class="btn block" type="button" data-action="clear-override" data-card="${cardId}" data-closing="${closing}">改回程式試算</button>` : ''}
    </form>`;
}

// ---------------------------------------------------------------- 提醒
function viewReminders() {
  const t = today();
  const snaps = snapshots();
  const events = upcomingEvents(snaps, t, 30);
  const prefs = readPrefs();
  const alarmDays = prefs.alarmDays ?? 3;
  const googleLinks = data.cards
    .map(
      (c) =>
        `<li class="row"><div class="row-main"><span class="row-title">${esc(cardLabel(c))}</span>
          <span class="row-sub">每月 ${c.dueDay} 日繳款截止</span></div>
          <a class="btn small" href="${esc(googleCalendarUrl(c, t, 'due'))}" target="_blank" rel="noopener">加到 Google 日曆</a></li>`,
    )
    .join('');

  return `${banners()}
    ${header('提醒', { sub: '未來 30 天' })}
    ${
      !data.cards.length
        ? '<section class="panel"><p class="muted">還沒有卡片。</p></section>'
        : events.length
          ? `<section class="alerts">${alertList(events, t)}</section>`
          : '<section class="panel"><p class="muted">未來 30 天沒有需要繳款或結帳的卡片。</p></section>'
    }
    <section class="panel">
      <h2>加到手機行事曆</h2>
      <p class="small">這個 App 沒辦法在背景主動通知你。把每張卡的繳款截止日加到手機行事曆，行事曆就會在截止前提醒你；提醒響了再打開 App 看本期要繳多少。</p>
      ${
        data.cards.length
          ? `<form class="form compact" data-form="ics">
              <label>提前提醒<select name="alarmDays">${[1, 2, 3, 5, 7]
                .map((d) => `<option value="${d}" ${d === alarmDays ? 'selected' : ''}>截止前 ${d} 天早上 9 點</option>`)
                .join('')}</select></label>
              <label class="check"><input type="checkbox" name="includeClosing" ${prefs.includeClosing ? 'checked' : ''}> 也加入每月結帳日</label>
              <button class="btn primary block" type="submit">下載行事曆檔（所有卡片）</button>
            </form>
            <p class="hint">${
              isIOS()
                ? 'iPhone：下載後選「加入行事曆」。如果在主畫面 App 裡沒有反應，請用 Safari 開啟本網站再按一次。'
                : 'Android：下載後用手機的行事曆 App 開啟匯入；用 Google 日曆的話，建議直接點下方「加到 Google 日曆」。'
            }截止日當天早上 9 點也會提醒。新增卡片或改了繳款日後，記得重新加入。</p>
            <h3>或逐張加到 Google 日曆</h3>
            <ul class="rows">${googleLinks}</ul>`
          : ''
      }
    </section>`;
}

// ---------------------------------------------------------------- 設定
function viewSettings() {
  const counts = [
    ['卡片', data.cards.length],
    ['消費紀錄', data.transactions.length],
    ['繳款紀錄', data.payments.length],
    ['分期', data.installments.length],
  ];
  const last = data.lastBackupAt ? new Date(data.lastBackupAt).toLocaleString('zh-TW') : '從未備份';
  return `${banners()}
    ${header('設定')}
    <section class="panel">
      <h2>備份與還原</h2>
      <p class="small">資料只存在這支手機的瀏覽器裡。換手機、清除瀏覽器資料或刪除 App 前，請先匯出備份檔（可存到雲端硬碟或傳給自己），在新手機上再匯入。</p>
      ${kv([['上次備份', esc(last)]])}
      <div class="actions">
        <button class="btn primary" data-action="export">匯出備份檔</button>
        <button class="btn" data-action="pick-import">匯入備份檔</button>
      </div>
    </section>
    <section class="panel">
      <h2>加到主畫面</h2>
      <p class="small"><strong>iPhone：</strong>用 Safari 開啟本網站 → 點網址列的「≡」或「⋯」→「分享」→「加入主畫面」（舊版 iOS 直接點下方「分享」按鈕）。<br>
      <strong>Android：</strong>用 Chrome 開啟 → 右上角選單 ⋮ →「安裝應用程式」或「加到主畫面」。</p>
      <p class="small muted">每個人在自己的手機上安裝、各自記錄，資料不會互相看到。</p>
    </section>
    <section class="panel">
      <h2>資料</h2>
      ${kv(counts.map(([k, v]) => [k, `${v}`]))}
      <button class="btn danger-text block" data-action="clear-all">清除這支手機上的所有資料</button>
    </section>
    <section class="panel">
      <details>
        <summary>計算規則</summary>
        <ul class="small rules">
          <li>帳單週期：上一個結帳日隔天到本次結帳日（含）；結帳日當天仍算進行中，隔天才出帳。</li>
          <li>繳款截止日：結帳日之後第一個「每月繳款日」；遇到小月以月底計算。</li>
          <li>本期應繳 = 上期應繳 − 期間繳款 + 本期新增消費（含分期入帳、退款）。</li>
          <li>最低應繳 = 一般消費 × 比例（預設 10%，無條件進位到元）+ 分期當期金額 + 超過額度部分 + 前期未繳足的最低應繳；不足下限（預設 $1,000）以下限計，應繳總額低於下限須全額繳清。</li>
          <li>不計算循環利息與違約金。各銀行規則不同，收到帳單後建議在卡片頁「輸入銀行帳單上的實際金額」。</li>
        </ul>
      </details>
      <p class="muted small">版本 ${APP_VERSION}</p>
    </section>`;
}

function viewNotFound(message) {
  return `${header('找不到頁面', { back: '#/' })}
    <section class="panel"><p>${esc(message)}</p><a class="btn block" href="#/">回到總覽</a></section>`;
}

function viewCorrupted() {
  return `${header('資料讀取失敗')}
    <section class="panel">
      <p>${esc(loadError)}</p>
      <p class="small">為了避免覆蓋，App 目前不會儲存任何變更。你可以先下載原始資料保留，再從備份檔還原，或清除後重新開始。</p>
      <div class="actions">
        <button class="btn" data-action="download-raw">下載原始資料</button>
        <button class="btn" data-action="pick-import">從備份檔還原</button>
        <button class="btn danger-text" data-action="reset-corrupted">清除並重新開始</button>
      </div>
    </section>`;
}

// ---------------------------------------------------------------- 路由
let lastPath = null;

function render() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, queryString = ''] = hash.split('?');
  const query = new URLSearchParams(queryString);
  const segs = path.split('/').filter(Boolean).map(decodeURIComponent);

  let html;
  let tab = 'home';
  if (corruptedRaw) {
    html = viewCorrupted();
  } else {
    switch (segs[0]) {
      case undefined:
        html = viewHome();
        break;
      case 'card':
        html = segs[1] === 'new' ? viewCardForm() : viewCard(Number(segs[1]));
        break;
      case 'edit':
        html = viewCardForm(Number(segs[1]));
        break;
      case 'add':
        tab = 'add';
        html = viewAdd(query);
        break;
      case 'stmt':
        html = viewStatementForm(Number(segs[1]), segs[2]);
        break;
      case 'reminders':
        tab = 'reminders';
        html = viewReminders();
        break;
      case 'settings':
        tab = 'settings';
        html = viewSettings();
        break;
      default:
        html = viewNotFound('找不到這個頁面');
    }
  }
  appEl.innerHTML = html;
  for (const form of appEl.querySelectorAll('form[data-draft]')) restoreDraft(form);
  for (const form of appEl.querySelectorAll('form')) {
    updateSchedulePreview(form);
    updateCycleHint(form);
  }
  for (const a of navEl.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (path !== lastPath) {
    window.scrollTo(0, 0);
    lastPath = path;
  }
}

// ---------------------------------------------------------------- 表單處理
function requireAmount(text, label) {
  if (!String(text ?? '').trim()) throw new Error(`請輸入${label}`);
  return parseAmount(text);
}

function optionalAmount(text) {
  return String(text ?? '').trim() ? parseAmount(text) : null;
}

const forms = {
  card(fd, form) {
    const id = form.dataset.id ? Number(form.dataset.id) : null;
    const name = String(fd.get('name')).trim();
    if (!name) throw new Error('請輸入卡片名稱');
    if (data.cards.some((c) => c.name === name && c.id !== id)) throw new Error(`已經有名為「${name}」的卡片`);
    const last4 = String(fd.get('last4')).trim();
    if (last4 && !/^\d{4}$/.test(last4)) throw new Error('卡號末四碼必須是 4 位數字');
    const creditLimit = optionalAmount(fd.get('creditLimit')) ?? 0;
    if (creditLimit < 0) throw new Error('信用額度不可為負數');
    const minRate = Number(String(fd.get('minRate')).replace('%', '').trim());
    if (!Number.isFinite(minRate) || minRate < 0 || minRate > 100) throw new Error('最低應繳比例必須介於 0 到 100');
    const minFloor = optionalAmount(fd.get('minFloor')) ?? 0;
    if (minFloor < 0) throw new Error('最低應繳下限不可為負數');
    const fields = {
      name,
      bank: String(fd.get('bank')).trim(),
      last4,
      creditLimit,
      statementDay: Number(fd.get('statementDay')),
      dueDay: Number(fd.get('dueDay')),
      minRate,
      minFloor,
      note: String(fd.get('note')).trim(),
    };

    if (id) {
      const card = cardById(id);
      const hasRecords = [data.transactions, data.payments, data.installments, data.overrides].some((list) =>
        list.some((r) => r.cardId === id),
      );
      if (
        fields.statementDay !== card.statementDay &&
        hasRecords &&
        !window.confirm('變更結帳日後，過去的帳單會依新的結帳日重新計算；已輸入的銀行帳單金額若對不上新的結帳日將不會套用。確定要變更嗎？')
      ) {
        return;
      }
      commit((d) => Object.assign(d.cards.find((c) => c.id === id), fields), '已更新卡片', `#/card/${id}`);
    } else {
      const newId = data.nextId;
      commit((d) => d.cards.push({ id: store.nextId(d), ...fields }), `已新增「${name}」`, `#/card/${newId}`);
    }
  },

  record(fd, form) {
    const type = form.dataset.type;
    const cardId = Number(fd.get('cardId'));
    const card = cardById(cardId);
    if (!card) throw new Error('請選擇信用卡');
    const date = String(fd.get('date'));
    if (!isValidDate(date)) throw new Error('請選擇有效的日期');
    writePrefs({ lastCardId: cardId });
    const t = today();
    const future = date > t ? '（日期在未來，到該日才會計入）' : '';

    if (type === 'txn' || type === 'refund') {
      let amount = requireAmount(fd.get('amount'), '金額');
      if (amount === 0) throw new Error('金額不可為 0');
      if (type === 'refund') amount = -Math.abs(amount);
      const closing = closingOnOrAfter(date, card.statementDay);
      commit(
        (d) =>
          d.transactions.push({
            id: store.nextId(d),
            cardId,
            date,
            amount,
            description: String(fd.get('description') ?? '').trim(),
            category: String(fd.get('category') ?? '').trim(),
          }),
        `已記錄${amount < 0 ? '退款' : '消費'} ${money(amount)}，列入 ${shortDate(closing)} 結帳的帳單${future}`,
        `#/card/${cardId}`,
      );
    } else if (type === 'payment') {
      const amount = requireAmount(fd.get('amount'), '繳款金額');
      if (amount <= 0) throw new Error('繳款金額必須大於 0');
      commit(
        (d) => d.payments.push({ id: store.nextId(d), cardId, date, amount, note: String(fd.get('note') ?? '').trim() }),
        `已記錄繳款 ${money(amount)}${future}`,
        `#/card/${cardId}`,
      );
    } else if (type === 'installment') {
      const totalAmount = requireAmount(fd.get('amount'), '分期總金額');
      if (totalAmount <= 0) throw new Error('分期總金額必須大於 0');
      const periods = Number(String(fd.get('periods')).trim());
      if (!Number.isInteger(periods) || periods < 1 || periods > 360) throw new Error('期數必須是 1 到 360 的整數');
      commit(
        (d) =>
          d.installments.push({
            id: store.nextId(d),
            cardId,
            startDate: date,
            totalAmount,
            periods,
            description: String(fd.get('description') ?? '').trim(),
          }),
        `已新增分期 ${money(totalAmount)}，分 ${periods} 期`,
        `#/card/${cardId}`,
      );
    }
  },

  statement(fd, form) {
    const cardId = Number(form.dataset.card);
    const closing = String(fd.get('closing'));
    const balance = optionalAmount(fd.get('balance'));
    const minPayment = optionalAmount(fd.get('minPayment'));
    if (balance === null && minPayment === null) throw new Error('請至少輸入一項金額，或按「改回程式試算」');
    if (minPayment !== null && minPayment < 0) throw new Error('最低應繳不可為負數');
    if (balance !== null && minPayment !== null && minPayment > Math.max(balance, 0)) {
      throw new Error('最低應繳金額不可大於應繳總額');
    }
    commit(
      (d) => {
        d.overrides = d.overrides.filter((o) => !(o.cardId === cardId && o.closingDate === closing));
        d.overrides.push({ cardId, closingDate: closing, balance, minPayment });
      },
      '已儲存帳單金額',
      `#/card/${cardId}`,
    );
  },

  ics(fd) {
    const alarmDays = Number(fd.get('alarmDays')) || 3;
    const includeClosing = fd.get('includeClosing') === 'on';
    writePrefs({ alarmDays, includeClosing });
    const text = buildIcs(data.cards, { today: today(), includeClosing, alarmDaysBefore: alarmDays });
    if (isIOS()) {
      // iOS 直接開啟 text/calendar 會跳出「加入行事曆」畫面
      const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
      window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      downloadFile('credit-card-reminders.ics', 'text/calendar', text);
    }
    toast('已產生行事曆檔');
  },
};

// ---------------------------------------------------------------- 按鈕動作
async function exportBackup() {
  const text = store.serializeBackup(data);
  const name = `credit-card-backup-${today()}.json`;
  const markDone = () =>
    commit((d) => {
      d.lastBackupAt = new Date().toISOString();
    }, '已匯出備份檔');
  const file = typeof File === 'function' ? new File([text], name, { type: 'application/json' }) : null;
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  if (touch && file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '信用卡資料備份' });
      markDone();
    } catch (err) {
      if (err?.name !== 'AbortError') {
        downloadFile(name, 'application/json', text);
        markDone();
      }
    }
    return;
  }
  downloadFile(name, 'application/json', text);
  markDone();
}

function pickImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const imported = store.parseBackup(await file.text());
      const summary = `卡片 ${imported.cards.length} 張、消費 ${imported.transactions.length} 筆、繳款 ${imported.payments.length} 筆、分期 ${imported.installments.length} 筆`;
      const replace = data.cards.length
        ? '這會用備份檔取代目前手機上的所有資料。'
        : '';
      if (!window.confirm(`匯入備份檔（${summary}）？${replace}`)) return;
      if (corruptedRaw) {
        localStorage.setItem(store.STORAGE_KEY, JSON.stringify(imported));
        window.location.reload();
        return;
      }
      data = imported;
      persist();
      toast('已匯入備份');
      location.hash = '#/';
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  input.click();
}

const RECORD_NAMES = { transactions: '這筆消費', payments: '這筆繳款', installments: '這筆分期（含已入帳的各期）' };

const actions = {
  'quick-pay'(el) {
    const cardId = Number(el.dataset.card);
    const amount = Number(el.dataset.amount);
    const t = today();
    if (!window.confirm(`記錄今天（${t}）繳款 ${money(amount)}（${el.dataset.label}）？`)) return;
    commit((d) => d.payments.push({ id: store.nextId(d), cardId, date: t, amount, note: '' }), `已記錄繳款 ${money(amount)}`);
  },
  delete(el) {
    const kind = el.dataset.kind;
    const id = Number(el.dataset.id);
    if (!window.confirm(`確定要刪除${RECORD_NAMES[kind]}嗎？`)) return;
    commit((d) => {
      d[kind] = d[kind].filter((r) => r.id !== id);
    }, '已刪除');
  },
  'delete-card'(el) {
    const id = Number(el.dataset.id);
    const card = cardById(id);
    if (!window.confirm(`確定要刪除「${card.name}」以及它的所有消費、繳款、分期紀錄嗎？此動作無法復原。`)) return;
    commit(
      (d) => {
        d.cards = d.cards.filter((c) => c.id !== id);
        for (const k of ['transactions', 'payments', 'installments', 'overrides']) {
          d[k] = d[k].filter((r) => r.cardId !== id);
        }
      },
      `已刪除「${card.name}」`,
      '#/',
    );
  },
  'clear-override'(el) {
    const cardId = Number(el.dataset.card);
    const closing = el.dataset.closing;
    commit(
      (d) => {
        d.overrides = d.overrides.filter((o) => !(o.cardId === cardId && o.closingDate === closing));
      },
      '已改回程式試算',
      `#/card/${cardId}`,
    );
  },
  export: exportBackup,
  'pick-import': pickImport,
  'clear-all'() {
    if (!window.confirm('確定要清除這支手機上的所有信用卡資料嗎？建議先匯出備份。')) return;
    if (!window.confirm('再確認一次：清除後無法復原。')) return;
    commit((d) => Object.assign(d, store.emptyData()), '已清除所有資料', '#/');
    writeDrafts({});
  },
  'discard-draft'(el) {
    clearDraft(el.dataset.key);
    render();
  },
  'hide-install-hint'() {
    writePrefs({ hideInstallHint: true });
    render();
  },
  'download-raw'() {
    downloadFile(`credit-card-raw-${today()}.txt`, 'text/plain', corruptedRaw);
  },
  'reset-corrupted'() {
    if (!window.confirm('確定要清除無法讀取的資料並重新開始嗎？')) return;
    localStorage.removeItem(store.STORAGE_KEY);
    window.location.reload();
  },
};

document.addEventListener('click', (event) => {
  const fill = event.target.closest('[data-fill]');
  if (fill) {
    const input = fill.closest('form')?.querySelector('input[name="amount"]');
    if (input) input.value = fill.dataset.fill;
    return;
  }
  const el = event.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  event.preventDefault();
  Promise.resolve()
    .then(() => actions[el.dataset.action](el))
    .catch((err) => toast(err.message, 'error'));
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form || !forms[form.dataset.form]) return;
  event.preventDefault();
  submittingDraftKey = form.dataset.draft || null;
  try {
    forms[form.dataset.form](new FormData(form), form);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    submittingDraftKey = null;
  }
});

function updateSchedulePreview(form) {
  const preview = form.querySelector('#schedule-preview');
  if (preview && form.statementDay && form.dueDay) {
    preview.textContent = schedulePreview(Number(form.statementDay.value), Number(form.dueDay.value));
  }
}

/** 「記一筆」日期下方即時顯示：這筆會算進哪一期帳單。 */
function updateCycleHint(form) {
  const hint = form.querySelector('[data-cycle-hint]');
  if (!hint) return;
  const card = cardById(Number(form.cardId?.value));
  const date = form.date?.value;
  if (!card || !isValidDate(date)) {
    hint.textContent = '';
    return;
  }
  const t = today();
  const closing = closingOnOrAfter(date, card.statementDay);
  const due = dueDateFor(closing, card.dueDay);
  const what = form.dataset.type === 'installment' ? '第一期' : '這筆';
  let text;
  if (closing < t) {
    text = `⚠ ${what}會算進已經結帳的 ${shortDate(closing)} 帳單（${shortDate(due)} 截止）。如果是結帳日之後才消費，請確認日期。`;
  } else {
    text = `${what}會算在 ${shortDate(closing)} 結帳的帳單，${shortDate(due)} 繳款截止。`;
  }
  if (date === closing) {
    text += '結帳日當天的消費，銀行常會算到下一期；如果帳單上沒有這筆，請把日期改成隔天。';
  }
  hint.textContent = text;
  hint.classList.toggle('warn', closing < t || date === closing);
}

function onFormEdit(event) {
  const form = event.target.closest?.('form');
  if (!form) return;
  if (form.dataset.draft) saveDraft(form);
  if (event.target.name === 'date' || event.target.name === 'cardId') updateCycleHint(form);
}

document.addEventListener('input', onFormEdit);

document.addEventListener('change', (event) => {
  onFormEdit(event);
  const el = event.target;
  const form = el.closest('form');
  if (el.matches('[data-preview]')) {
    updateSchedulePreview(form);
  } else if (el.matches('[data-card-switch]')) {
    if (form.dataset.type === 'payment') {
      // 繳款畫面需要依卡片更新「最低／全額」快捷按鈕
      location.hash = `#/add?type=payment&card=${el.value}`;
    } else {
      for (const a of appEl.querySelectorAll('.segmented a')) {
        a.setAttribute('href', a.getAttribute('href').replace(/card=\d+/, `card=${el.value}`));
      }
    }
  } else if (el.matches('[data-nav-stmt]')) {
    location.hash = `#/stmt/${el.dataset.navStmt}/${el.value}`;
  }
});

// 切到別的 App 前也存一次（保險）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    for (const form of appEl.querySelectorAll('form[data-draft]')) saveDraft(form);
  }
});

window.addEventListener('hashchange', render);
// App 從背景回來時（可能已經跨日）重新整理畫面
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') render();
});

render();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
