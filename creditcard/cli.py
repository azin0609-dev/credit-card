"""命令列介面（ccm）。"""

from __future__ import annotations

import argparse
import dataclasses
import sys
import unicodedata
from collections.abc import Callable, Sequence
from datetime import date, timedelta
from typing import Any

from . import __version__
from .billing import CardSnapshot, Statement, StatementStatus, installment_progress
from .dates import closing_on_or_after, describe_days, due_date_for, parse_date
from .db import Database, default_db_path
from .models import Card, Installment, Payment, StatementOverride, Transaction
from .money import UNIT, format_amount, parse_amount

Handler = Callable[[Database, argparse.Namespace, date], int | None]


class CLIError(Exception):
    """可預期的使用者錯誤，會以友善訊息顯示。"""


# --------------------------------------------------------------------------
# 參數轉換
# --------------------------------------------------------------------------
def _arg_type(converter: Callable[[str], Any]) -> Callable[[str], Any]:
    def convert(text: str) -> Any:
        try:
            return converter(text)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(str(exc)) from None

    convert.__name__ = converter.__name__
    return convert


def _non_negative_amount(text: str) -> int:
    value = parse_amount(text)
    if value < 0:
        raise ValueError(f"金額不可為負數：{text}")
    return value


def _positive_amount(text: str) -> int:
    value = parse_amount(text)
    if value <= 0:
        raise ValueError(f"金額必須大於 0：{text}")
    return value


def _day_of_month(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise ValueError(f"請輸入 1 到 31 的整數：{text}") from None
    if not 1 <= value <= 31:
        raise ValueError(f"請輸入 1 到 31 的整數：{text}")
    return value


def _rate(text: str) -> float:
    try:
        value = float(text.strip().rstrip("%"))
    except ValueError:
        raise ValueError(f"無效的比例：{text}") from None
    if not 0 <= value <= 100:
        raise ValueError(f"比例必須介於 0 到 100 之間：{text}")
    return value


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise ValueError(f"請輸入正整數：{text}") from None
    if value < 1:
        raise ValueError(f"請輸入正整數：{text}")
    return value


def _last4(text: str) -> str:
    text = text.strip()
    if not (text.isdigit() and len(text) == 4):
        raise ValueError(f"卡號末四碼必須是 4 位數字：{text}")
    return text


amount_arg = _arg_type(parse_amount)
non_negative_amount_arg = _arg_type(_non_negative_amount)
positive_amount_arg = _arg_type(_positive_amount)
date_arg = _arg_type(parse_date)
day_arg = _arg_type(_day_of_month)
rate_arg = _arg_type(_rate)
positive_int_arg = _arg_type(_positive_int)
last4_arg = _arg_type(_last4)


# --------------------------------------------------------------------------
# 輸出工具
# --------------------------------------------------------------------------
def display_width(text: str) -> int:
    """終端機顯示寬度：中文等全形字元佔 2 格。"""
    width = 0
    for ch in text:
        if unicodedata.combining(ch):
            continue
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width


def pad(text: str, width: int, align: str = "l") -> str:
    gap = max(width - display_width(text), 0)
    return " " * gap + text if align == "r" else text + " " * gap


def render_table(headers: Sequence[str], rows: Sequence[Sequence[str]], align: str = "") -> str:
    align = align.ljust(len(headers), "l")
    widths = [display_width(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], display_width(cell))

    def line(cells: Sequence[str]) -> str:
        return "  ".join(pad(c, widths[i], align[i]) for i, c in enumerate(cells)).rstrip()

    separator = "  ".join("-" * w for w in widths)
    return "\n".join([line(headers), separator, *(line(r) for r in rows)])


def kv_lines(pairs: Sequence[tuple[str, str]], indent: int = 2) -> str:
    width = max(display_width(k) for k, _ in pairs)
    return "\n".join(f"{' ' * indent}{pad(k, width)}  {v}" for k, v in pairs)


def money(cents: int) -> str:
    return format_amount(cents)


def status_text(stmt: Statement, today: date, historical: bool = False) -> str:
    """帳單狀態文字。historical=True 用於非最新一期的帳單，不顯示倒數／逾期天數。"""
    status = stmt.status(today)
    if historical:
        return "逾期未繳" if status is StatementStatus.OVERDUE else status.value
    if status is StatementStatus.PENDING:
        days = (stmt.due_date - today).days
        return "待繳（今天截止）" if days == 0 else f"待繳（剩 {days} 天）"
    if status is StatementStatus.OVERDUE:
        return f"逾期 {(today - stmt.due_date).days} 天"
    if status is StatementStatus.MIN_PAID and today <= stmt.due_date:
        return "已繳最低（建議繳清）"
    return status.value


def require_card(db: Database, ref: str) -> Card:
    card = db.find_card(ref)
    if card is None:
        raise CLIError(f"找不到卡片「{ref}」，可用 `ccm card list` 查看所有卡片")
    return card


def card_names(db: Database) -> dict[int, str]:
    return {c.id: c.name for c in db.list_cards() if c.id is not None}


# --------------------------------------------------------------------------
# card 指令
# --------------------------------------------------------------------------
def cmd_card_add(db: Database, args: argparse.Namespace, today: date) -> None:
    card = db.add_card(
        Card(
            name=args.name.strip(),
            statement_day=args.statement_day,
            due_day=args.due_day,
            bank=args.bank,
            last4=args.last4 or "",
            credit_limit=args.limit,
            min_payment_rate=args.min_rate,
            min_payment_floor=args.min_floor,
            note=args.note,
        )
    )
    closing = closing_on_or_after(today, card.statement_day)
    due = due_date_for(closing, card.due_day)
    print(
        f"已新增卡片 #{card.id}「{card.name}」：每月 {card.statement_day} 日結帳、"
        f"{card.due_day} 日繳款截止。"
    )
    print(f"下次結帳日 {closing}（{describe_days(closing, today)}），該期繳款截止日 {due}。")
    print(
        "提示：若手上已有尚未繳清的帳單，可用\n"
        f"  ccm stmt set \"{card.name}\" <結帳日> --balance <應繳總額> --min <最低應繳>\n"
        "輸入，程式就會從該期開始追蹤。"
    )


def cmd_card_list(db: Database, args: argparse.Namespace, today: date) -> None:
    cards = db.list_cards()
    if not cards:
        print("尚未新增任何卡片，請使用 `ccm card add` 新增。")
        return
    rows = [
        [
            str(c.id),
            c.name,
            c.bank or "-",
            c.last4 or "-",
            f"{c.statement_day} 日",
            f"{c.due_day} 日",
            money(c.credit_limit) if c.credit_limit else "-",
            f"{c.min_payment_rate:g}%／下限 {money(c.min_payment_floor)}",
        ]
        for c in cards
    ]
    print(
        render_table(
            ["ID", "名稱", "銀行", "末四碼", "結帳日", "繳款日", "信用額度", "最低應繳規則"],
            rows,
            "rlllrrrl",
        )
    )


def cmd_card_show(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    snap = db.snapshot(card, today)

    title = card.label + (f"｜{card.bank}" if card.bank else "")
    print(title)
    print(f"  每月 {card.statement_day} 日結帳，{card.due_day} 日繳款截止")
    limit = money(card.credit_limit) if card.credit_limit else "未設定"
    print(
        f"  信用額度 {limit}，最低應繳 {card.min_payment_rate:g}%"
        f"（下限 {money(card.min_payment_floor)}）"
    )
    if card.note:
        print(f"  備註：{card.note}")
    print()

    latest = snap.latest
    if latest is None:
        print("尚無已結帳的帳單。")
    else:
        flag = "（手動輸入）" if latest.overridden else "（試算）"
        print(f"最近一期帳單：{latest.closing_date} 結帳{flag}")
        print(
            kv_lines(
                [
                    ("本期應繳總額", money(latest.balance)),
                    ("最低應繳金額", money(latest.min_payment)),
                    ("已繳金額", money(latest.paid)),
                    ("尚未繳清", money(latest.remaining)),
                    (
                        "繳款截止日",
                        f"{latest.due_date}（{describe_days(latest.due_date, today)}）",
                    ),
                    ("狀態", status_text(latest, today)),
                ]
            )
        )
    print()
    print("欠款概況")
    pairs = [
        ("未出帳消費", money(snap.unbilled_charges)),
        ("目前帳上欠款", money(snap.current_balance)),
        ("未到期分期", money(snap.remaining_installments)),
        ("總欠款", money(snap.total_debt)),
    ]
    if card.credit_limit:
        pairs.append(("可用額度", money(snap.available_credit)))
    print(kv_lines(pairs))
    if snap.next_closing_date and snap.next_due_date:
        print()
        print(
            f"下次結帳日 {snap.next_closing_date}（{describe_days(snap.next_closing_date, today)}），"
            f"該期繳款截止日 {snap.next_due_date}"
        )

    period_start = latest.closing_date + timedelta(days=1) if latest else None
    unbilled = db.list_transactions(card.id, start=period_start, end=today)
    if unbilled:
        print()
        since = f"（{period_start} 起）" if period_start else ""
        print(f"未出帳消費明細{since}")
        print(
            render_table(
                ["ID", "日期", "金額", "類別", "說明"],
                [
                    [str(t.id), str(t.date), money(t.amount), t.category or "-", t.description]
                    for t in unbilled
                ],
                "rlrll",
            )
        )

    active = [p for p in snap.installments if not p.finished]
    if active:
        print()
        print("進行中的分期")
        print(
            render_table(
                ["ID", "說明", "總額", "進度", "剩餘金額", "下期入帳"],
                [
                    [
                        str(p.installment.id),
                        p.installment.description or "-",
                        money(p.installment.total_amount),
                        f"{p.posted_periods}/{p.installment.periods}",
                        money(p.remaining_amount),
                        str(p.next_date),
                    ]
                    for p in active
                ],
                "rlrrrl",
            )
        )


def cmd_card_edit(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    changes: dict[str, Any] = {}
    mapping = {
        "name": "name",
        "statement_day": "statement_day",
        "due_day": "due_day",
        "bank": "bank",
        "last4": "last4",
        "limit": "credit_limit",
        "min_rate": "min_payment_rate",
        "min_floor": "min_payment_floor",
        "note": "note",
    }
    for arg_name, field_name in mapping.items():
        value = getattr(args, arg_name)
        if value is not None:
            changes[field_name] = value.strip() if isinstance(value, str) else value
    if not changes:
        raise CLIError("沒有指定要修改的欄位，請用 `ccm card edit -h` 查看可用選項")
    updated = dataclasses.replace(card, **changes)
    db.update_card(updated)
    print(f"已更新卡片 #{updated.id}「{updated.name}」。")
    if "statement_day" in changes and changes["statement_day"] != card.statement_day:
        stale = [
            o
            for o in db.list_overrides(updated.id or 0)
            if closing_on_or_after(o.closing_date, updated.statement_day) != o.closing_date
        ]
        if stale:
            dates = "、".join(str(o.closing_date) for o in stale)
            print(f"注意：手動輸入的帳單（{dates}）與新的結帳日不一致，將不會被套用。")


def cmd_card_remove(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    if not args.yes:
        try:
            answer = input(f"確定要刪除「{card.name}」以及所有相關紀錄嗎？(y/N) ")
        except EOFError:
            answer = ""
        if answer.strip().lower() not in ("y", "yes"):
            print("已取消。")
            return
    db.delete_card(card.id or 0)
    print(f"已刪除卡片「{card.name}」。")


# --------------------------------------------------------------------------
# txn 指令
# --------------------------------------------------------------------------
def cmd_txn_add(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    amount = -abs(args.amount) if args.refund else args.amount
    if amount == 0:
        raise CLIError("消費金額不可為 0")
    txn_date = args.date or today
    txn = db.add_transaction(
        Transaction(
            card_id=card.id or 0,
            date=txn_date,
            amount=amount,
            description=args.description or "",
            category=args.category or "",
        )
    )
    closing = closing_on_or_after(txn_date, card.statement_day)
    kind = "退款" if amount < 0 else "消費"
    print(
        f"已記錄{kind} #{txn.id}：{card.name} {txn.date} {money(txn.amount)}"
        f"{' ' + txn.description if txn.description else ''}"
    )
    if closing < today:
        print(f"此筆列入 {closing} 結帳的帳單（已結帳）。")
    else:
        print(f"此筆列入 {closing} 結帳的帳單（{describe_days(closing, today)}結帳）。")
    if txn_date > today:
        print("注意：日期在未來，到該日才會計入欠款。")


def cmd_txn_list(db: Database, args: argparse.Namespace, today: date) -> None:
    card_id = require_card(db, args.card).id if args.card else None
    txns = db.list_transactions(card_id, start=args.start, end=args.end)
    if args.limit:
        txns = txns[-args.limit :]
    if not txns:
        print("沒有符合條件的消費紀錄。")
        return
    names = card_names(db)
    rows = [
        [
            str(t.id),
            str(t.date),
            names.get(t.card_id, "?"),
            money(t.amount),
            t.category or "-",
            t.description,
        ]
        for t in txns
    ]
    print(render_table(["ID", "日期", "卡片", "金額", "類別", "說明"], rows, "rllrll"))
    print(f"共 {len(txns)} 筆，合計 {money(sum(t.amount for t in txns))}")


def cmd_txn_remove(db: Database, args: argparse.Namespace, today: date) -> None:
    if not db.delete_transaction(args.id):
        raise CLIError(f"找不到消費紀錄 #{args.id}")
    print(f"已刪除消費紀錄 #{args.id}。")


# --------------------------------------------------------------------------
# pay 指令
# --------------------------------------------------------------------------
def cmd_pay_add(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    if args.full or args.min:
        if args.amount is not None:
            raise CLIError("金額與 --full／--min 只能擇一")
        latest = db.snapshot(card, today).latest
        if latest is None:
            raise CLIError("這張卡還沒有已結帳的帳單，請直接輸入繳款金額")
        amount = latest.remaining if args.full else latest.min_remaining
        if amount <= 0:
            what = "全額" if args.full else "最低應繳"
            raise CLIError(f"最近一期帳單（{latest.closing_date} 結帳）的{what}已經繳足了")
    elif args.amount is None:
        raise CLIError("請輸入繳款金額，或使用 --full（繳清）／--min（繳最低）")
    else:
        amount = args.amount

    pay_date = args.date or today
    payment = db.add_payment(
        Payment(card_id=card.id or 0, date=pay_date, amount=amount, note=args.note or "")
    )
    print(f"已記錄繳款 #{payment.id}：{card.name} {payment.date} {money(payment.amount)}")
    if pay_date > today:
        print("注意：日期在未來，到該日才會計入。")
        return
    latest = db.snapshot(card, today).latest
    if latest is not None:
        print(
            f"最近一期帳單（{latest.closing_date} 結帳）：已繳 {money(latest.paid)}／"
            f"應繳 {money(latest.balance)}，狀態：{status_text(latest, today)}"
        )


def cmd_pay_list(db: Database, args: argparse.Namespace, today: date) -> None:
    card_id = require_card(db, args.card).id if args.card else None
    payments = db.list_payments(card_id, start=args.start, end=args.end)
    if args.limit:
        payments = payments[-args.limit :]
    if not payments:
        print("沒有符合條件的繳款紀錄。")
        return
    names = card_names(db)
    rows = [
        [str(p.id), str(p.date), names.get(p.card_id, "?"), money(p.amount), p.note]
        for p in payments
    ]
    print(render_table(["ID", "日期", "卡片", "金額", "備註"], rows, "rllrl"))
    print(f"共 {len(payments)} 筆，合計 {money(sum(p.amount for p in payments))}")


def cmd_pay_remove(db: Database, args: argparse.Namespace, today: date) -> None:
    if not db.delete_payment(args.id):
        raise CLIError(f"找不到繳款紀錄 #{args.id}")
    print(f"已刪除繳款紀錄 #{args.id}。")


# --------------------------------------------------------------------------
# inst 指令（分期）
# --------------------------------------------------------------------------
def cmd_inst_add(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    inst = db.add_installment(
        Installment(
            card_id=card.id or 0,
            start_date=args.start_date or today,
            total_amount=args.total,
            periods=args.periods,
            description=args.description or "",
        )
    )
    schedule = inst.schedule()
    first, rest = schedule[0][1], schedule[-1][1]
    per = money(rest) if first == rest else f"{money(rest)}（首期 {money(first)}）"
    print(
        f"已新增分期 #{inst.id}：{card.name} {money(inst.total_amount)} 分 {inst.periods} 期，"
        f"每期 {per}"
    )
    print(f"首期 {schedule[0][0]} 入帳，末期 {schedule[-1][0]} 入帳。")


def cmd_inst_list(db: Database, args: argparse.Namespace, today: date) -> None:
    card_id = require_card(db, args.card).id if args.card else None
    names = card_names(db)
    progress = [installment_progress(i, today) for i in db.list_installments(card_id)]
    if not args.all:
        progress = [p for p in progress if not p.finished]
    if not progress:
        print("沒有進行中的分期。" if not args.all else "沒有分期紀錄。")
        return
    rows = [
        [
            str(p.installment.id),
            names.get(p.installment.card_id, "?"),
            p.installment.description or "-",
            money(p.installment.total_amount),
            f"{p.posted_periods}/{p.installment.periods}",
            money(p.remaining_amount),
            str(p.next_date) if p.next_date else "已完成",
        ]
        for p in progress
    ]
    print(render_table(["ID", "卡片", "說明", "總額", "進度", "剩餘金額", "下期入帳"], rows, "rllrrrl"))
    print(f"未到期分期合計 {money(sum(p.remaining_amount for p in progress))}")


def cmd_inst_remove(db: Database, args: argparse.Namespace, today: date) -> None:
    if not db.delete_installment(args.id):
        raise CLIError(f"找不到分期 #{args.id}")
    print(f"已刪除分期 #{args.id}。")


# --------------------------------------------------------------------------
# stmt 指令（帳單）
# --------------------------------------------------------------------------
def cmd_stmt_list(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    snap = db.snapshot(card, today)
    statements = snap.statements[-args.limit :] if args.limit else snap.statements
    if not statements:
        print(f"「{card.name}」尚無已結帳的帳單。")
    else:
        rows = [
            [
                str(s.closing_date),
                str(s.due_date),
                money(s.previous_balance),
                money(s.credits),
                money(s.new_charges),
                money(s.balance) + ("*" if s.overridden else ""),
                money(s.min_payment),
                money(s.paid),
                status_text(s, today, historical=s is not snap.latest),
            ]
            for s in statements
        ]
        print(f"{card.label} 帳單紀錄")
        print(
            render_table(
                ["結帳日", "繳款截止", "上期應繳", "期間繳款", "本期新增", "本期應繳", "最低應繳", "已繳", "狀態"],
                rows,
                "llrrrrrrl",
            )
        )
        if any(s.overridden for s in statements):
            print("* 為手動輸入的銀行帳單資料")
    print(
        f"未出帳：消費 {money(snap.unbilled_charges)}，下次結帳日 {snap.next_closing_date}"
        f"（{describe_days(snap.next_closing_date, today) if snap.next_closing_date else '-'}）"
    )


def _validate_closing(card: Card, closing: date, today: date) -> None:
    expected = closing_on_or_after(closing, card.statement_day)
    if expected != closing:
        raise CLIError(
            f"{closing} 不是「{card.name}」的結帳日（每月 {card.statement_day} 日），"
            f"最接近的結帳日是 {expected}"
        )
    if closing >= today:
        raise CLIError(f"{closing} 這期尚未結帳，無法輸入帳單金額")


def cmd_stmt_set(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    _validate_closing(card, args.closing_date, today)
    if args.balance is None and args.min is None:
        raise CLIError("請至少指定 --balance（應繳總額）或 --min（最低應繳）")
    existing = db.get_override(card.id or 0, args.closing_date)
    balance = args.balance if args.balance is not None else (existing.balance if existing else None)
    min_payment = args.min if args.min is not None else (existing.min_payment if existing else None)
    if balance is not None and min_payment is not None and min_payment > max(balance, 0):
        raise CLIError("最低應繳金額不可大於應繳總額")
    db.set_override(
        StatementOverride(
            card_id=card.id or 0,
            closing_date=args.closing_date,
            balance=balance,
            min_payment=min_payment,
        )
    )
    snap = db.snapshot(card, today)
    stmt = next(s for s in snap.statements if s.closing_date == args.closing_date)
    print(
        f"已設定「{card.name}」{stmt.closing_date} 帳單：應繳 {money(stmt.balance)}，"
        f"最低應繳 {money(stmt.min_payment)}，繳款截止日 {stmt.due_date}。"
    )
    print(f"狀態：{status_text(stmt, today)}")


def cmd_stmt_unset(db: Database, args: argparse.Namespace, today: date) -> None:
    card = require_card(db, args.card)
    if not db.delete_override(card.id or 0, args.closing_date):
        raise CLIError(f"「{card.name}」沒有 {args.closing_date} 的手動帳單資料")
    print(f"已移除「{card.name}」{args.closing_date} 的手動帳單資料，改回程式試算。")


# --------------------------------------------------------------------------
# 總覽與提醒
# --------------------------------------------------------------------------
def _snapshots(db: Database, today: date) -> list[CardSnapshot]:
    return [db.snapshot(card, today) for card in db.list_cards()]


def cmd_summary(db: Database, args: argparse.Namespace, today: date) -> None:
    snaps = _snapshots(db, today)
    if not snaps:
        print("尚未新增任何卡片，請先使用 `ccm card add` 新增，例如：")
        print("  ccm card add 我的卡 --statement-day 5 --due-day 20 --limit 100000")
        return

    print(f"信用卡總覽（{today}）")
    rows = []
    for snap in snaps:
        s = snap.latest
        rows.append(
            [
                snap.card.name,
                money(s.balance) if s else "-",
                money(s.min_payment) if s else "-",
                money(s.paid) if s else "-",
                str(s.due_date) if s else "-",
                status_text(s, today) if s else "尚未結帳",
                money(snap.unbilled_charges),
                money(snap.total_debt),
                money(snap.available_credit) if snap.card.credit_limit else "-",
                str(snap.next_closing_date),
            ]
        )
    print(
        render_table(
            ["卡片", "本期應繳", "最低應繳", "已繳", "繳款截止", "狀態", "未出帳", "總欠款", "可用額度", "下次結帳"],
            rows,
            "lrrrllrrrl",
        )
    )

    latest = [s.latest for s in snaps if s.latest]
    print()
    print(
        kv_lines(
            [
                ("本期尚需繳清", money(sum(s.remaining for s in latest))),
                ("其中最低應繳尚差", money(sum(s.min_remaining for s in latest))),
                ("總欠款", money(sum(s.total_debt for s in snaps))),
            ],
            indent=0,
        )
    )
    overdue = [s for s in snaps if s.latest and s.latest.status(today) is StatementStatus.OVERDUE]
    for snap in overdue:
        assert snap.latest is not None
        print(
            f"⚠ {snap.card.name} 已逾期（截止日 {snap.latest.due_date}），"
            f"最低應繳尚差 {money(snap.latest.min_remaining)}"
        )


def cmd_upcoming(db: Database, args: argparse.Namespace, today: date) -> None:
    horizon = today + timedelta(days=args.days)
    events: list[tuple[int, date, str]] = []
    for snap in _snapshots(db, today):
        name = snap.card.name
        s = snap.latest
        if s is not None:
            status = s.status(today)
            if status is StatementStatus.OVERDUE:
                events.append(
                    (
                        0,
                        s.due_date,
                        f"[逾期]  {name}：{s.due_date} 已截止（{describe_days(s.due_date, today)}），"
                        f"最低應繳尚差 {money(s.min_remaining)}，全額尚差 {money(s.remaining)}",
                    )
                )
            elif status is StatementStatus.PENDING and s.due_date <= horizon:
                events.append(
                    (
                        1,
                        s.due_date,
                        f"[繳款]  {name}：{s.due_date} 截止（{describe_days(s.due_date, today)}），"
                        f"最低 {money(s.min_remaining)}／全額 {money(s.remaining)}",
                    )
                )
            elif status is StatementStatus.MIN_PAID and today <= s.due_date <= horizon:
                events.append(
                    (
                        1,
                        s.due_date,
                        f"[繳款]  {name}：已繳最低，{s.due_date} 前繳清剩餘 {money(s.remaining)}"
                        "可避免循環利息",
                    )
                )
        closing = snap.next_closing_date
        if closing is not None and closing <= horizon:
            events.append(
                (
                    2,
                    closing,
                    f"[結帳]  {name}：{closing} 結帳（{describe_days(closing, today)}），"
                    f"目前未出帳消費 {money(snap.unbilled_charges)}",
                )
            )
    if not events:
        print(f"未來 {args.days} 天內沒有需要繳款或結帳的卡片。")
        return
    print(f"未來 {args.days} 天內的提醒（{today} ~ {horizon}）")
    for _, _, text in sorted(events, key=lambda e: (e[0], e[1])):
        print(text)


# --------------------------------------------------------------------------
# 參數解析
# --------------------------------------------------------------------------
def _group(
    sub: argparse._SubParsersAction[argparse.ArgumentParser], name: str, help_text: str
) -> argparse._SubParsersAction[argparse.ArgumentParser]:
    parser = sub.add_parser(name, help=help_text, description=help_text)
    parser.set_defaults(handler=lambda db, args, today: parser.print_help())
    return parser.add_subparsers(metavar="動作")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ccm",
        description="信用卡管理工具：追蹤結帳日、繳款截止日、最低應繳金額與欠款。"
        "不帶任何指令時顯示總覽。",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument(
        "--db",
        help="資料庫檔案路徑（預設為環境變數 CREDIT_CARD_DB，或 ~/.credit-card/cards.db）",
    )
    parser.add_argument(
        "--today",
        type=date_arg,
        help="把指定日期當作「今天」來計算（YYYY-MM-DD），可用於試算",
    )
    parser.set_defaults(handler=cmd_summary)
    sub = parser.add_subparsers(metavar="指令")

    # ---- card
    card = _group(sub, "card", "管理信用卡（新增、列出、查看、修改、刪除）")
    p = card.add_parser("add", help="新增信用卡")
    p.add_argument("name", help="卡片名稱，例如「國泰CUBE」")
    p.add_argument("-s", "--statement-day", type=day_arg, required=True, help="每月結帳日（1-31）")
    p.add_argument("-d", "--due-day", type=day_arg, required=True, help="每月繳款截止日（1-31）")
    p.add_argument("--bank", default="", help="發卡銀行")
    p.add_argument("--last4", type=last4_arg, help="卡號末四碼")
    p.add_argument("--limit", type=non_negative_amount_arg, default=0, help="信用額度")
    p.add_argument(
        "--min-rate", type=rate_arg, default=10.0, help="最低應繳比例（%%），預設 10"
    )
    p.add_argument(
        "--min-floor",
        type=non_negative_amount_arg,
        default=1000 * UNIT,
        help="最低應繳下限金額，預設 1000；應繳總額低於此金額時須全額繳清",
    )
    p.add_argument("--note", default="", help="備註")
    p.set_defaults(handler=cmd_card_add)

    p = card.add_parser("list", help="列出所有信用卡")
    p.set_defaults(handler=cmd_card_list)

    p = card.add_parser("show", help="查看單張卡片的帳單、欠款與分期明細")
    p.add_argument("card", help="卡片名稱或 ID")
    p.set_defaults(handler=cmd_card_show)

    p = card.add_parser("edit", help="修改卡片設定")
    p.add_argument("card", help="卡片名稱或 ID")
    p.add_argument("--name", help="新名稱")
    p.add_argument("-s", "--statement-day", type=day_arg, help="每月結帳日（1-31）")
    p.add_argument("-d", "--due-day", type=day_arg, help="每月繳款截止日（1-31）")
    p.add_argument("--bank", help="發卡銀行")
    p.add_argument("--last4", type=last4_arg, help="卡號末四碼")
    p.add_argument("--limit", type=non_negative_amount_arg, help="信用額度")
    p.add_argument("--min-rate", type=rate_arg, help="最低應繳比例（%%）")
    p.add_argument("--min-floor", type=non_negative_amount_arg, help="最低應繳下限金額")
    p.add_argument("--note", help="備註")
    p.set_defaults(handler=cmd_card_edit)

    p = card.add_parser("remove", help="刪除卡片（連同所有消費、繳款、分期紀錄）")
    p.add_argument("card", help="卡片名稱或 ID")
    p.add_argument("-y", "--yes", action="store_true", help="不詢問直接刪除")
    p.set_defaults(handler=cmd_card_remove)

    # ---- txn
    txn = _group(sub, "txn", "記錄消費／退款")
    p = txn.add_parser("add", help="新增一筆消費（退款請加 --refund 或輸入負數）")
    p.add_argument("card", help="卡片名稱或 ID")
    p.add_argument("amount", type=amount_arg, help="金額")
    p.add_argument("description", nargs="?", help="說明")
    p.add_argument("--date", type=date_arg, help="消費日期（預設今天）")
    p.add_argument("-c", "--category", help="類別，例如 餐飲、交通")
    p.add_argument("--refund", action="store_true", help="這是一筆退款（金額會記為負數）")
    p.set_defaults(handler=cmd_txn_add)

    p = txn.add_parser("list", help="列出消費紀錄")
    p.add_argument("--card", help="只顯示這張卡")
    p.add_argument("--from", dest="start", type=date_arg, help="起始日期")
    p.add_argument("--to", dest="end", type=date_arg, help="結束日期")
    p.add_argument("-n", "--limit", type=positive_int_arg, default=50, help="最多顯示幾筆（最新的），預設 50")
    p.set_defaults(handler=cmd_txn_list)

    p = txn.add_parser("remove", help="刪除一筆消費")
    p.add_argument("id", type=positive_int_arg, help="消費紀錄 ID")
    p.set_defaults(handler=cmd_txn_remove)

    # ---- pay
    pay = _group(sub, "pay", "記錄繳款")
    p = pay.add_parser("add", help="新增一筆繳款")
    p.add_argument("card", help="卡片名稱或 ID")
    p.add_argument("amount", nargs="?", type=positive_amount_arg, help="繳款金額")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--full", action="store_true", help="繳清最近一期帳單剩餘金額")
    mode.add_argument("--min", action="store_true", help="繳足最近一期帳單的最低應繳金額")
    p.add_argument("--date", type=date_arg, help="繳款日期（預設今天）")
    p.add_argument("--note", help="備註")
    p.set_defaults(handler=cmd_pay_add)

    p = pay.add_parser("list", help="列出繳款紀錄")
    p.add_argument("--card", help="只顯示這張卡")
    p.add_argument("--from", dest="start", type=date_arg, help="起始日期")
    p.add_argument("--to", dest="end", type=date_arg, help="結束日期")
    p.add_argument("-n", "--limit", type=positive_int_arg, default=50, help="最多顯示幾筆（最新的），預設 50")
    p.set_defaults(handler=cmd_pay_list)

    p = pay.add_parser("remove", help="刪除一筆繳款")
    p.add_argument("id", type=positive_int_arg, help="繳款紀錄 ID")
    p.set_defaults(handler=cmd_pay_remove)

    # ---- inst
    inst = _group(sub, "inst", "管理分期付款")
    p = inst.add_parser("add", help="新增分期（每月自動入帳一期）")
    p.add_argument("card", help="卡片名稱或 ID")
    p.add_argument("total", type=positive_amount_arg, help="分期總金額")
    p.add_argument("periods", type=positive_int_arg, help="期數")
    p.add_argument("description", nargs="?", help="說明")
    p.add_argument("--start-date", type=date_arg, help="第一期入帳日（預設今天）")
    p.set_defaults(handler=cmd_inst_add)

    p = inst.add_parser("list", help="列出分期")
    p.add_argument("--card", help="只顯示這張卡")
    p.add_argument("--all", action="store_true", help="包含已結束的分期")
    p.set_defaults(handler=cmd_inst_list)

    p = inst.add_parser("remove", help="刪除分期")
    p.add_argument("id", type=positive_int_arg, help="分期 ID")
    p.set_defaults(handler=cmd_inst_remove)

    # ---- stmt
    stmt = _group(sub, "stmt", "查看帳單／輸入銀行實際帳單金額")
    p = stmt.add_parser("list", help="列出歷期帳單")
    p.add_argument("card", help="卡片名稱或 ID")
    p.add_argument("-n", "--limit", type=positive_int_arg, default=12, help="顯示最近幾期，預設 12")
    p.set_defaults(handler=cmd_stmt_list)

    p = stmt.add_parser("set", help="以銀行帳單上的實際金額覆蓋試算結果")
    p.add_argument("card", help="卡片名稱或 ID")
    p.add_argument("closing_date", type=date_arg, help="該期結帳日（YYYY-MM-DD）")
    p.add_argument("--balance", type=amount_arg, help="本期應繳總額")
    p.add_argument("--min", type=non_negative_amount_arg, help="最低應繳金額")
    p.set_defaults(handler=cmd_stmt_set)

    p = stmt.add_parser("unset", help="移除手動輸入的帳單金額，改回試算")
    p.add_argument("card", help="卡片名稱或 ID")
    p.add_argument("closing_date", type=date_arg, help="該期結帳日（YYYY-MM-DD）")
    p.set_defaults(handler=cmd_stmt_unset)

    # ---- summary / upcoming
    p = sub.add_parser("summary", help="所有卡片的帳單與欠款總覽（預設指令）")
    p.set_defaults(handler=cmd_summary)

    p = sub.add_parser("upcoming", help="即將到期的繳款與結帳提醒")
    p.add_argument("--days", type=positive_int_arg, default=7, help="往後看幾天，預設 7")
    p.set_defaults(handler=cmd_upcoming)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    today: date = args.today or date.today()
    handler: Handler = args.handler
    try:
        with Database(args.db or default_db_path()) as db:
            return handler(db, args, today) or 0
    except (CLIError, ValueError) as exc:
        print(f"錯誤：{exc}", file=sys.stderr)
        return 1
