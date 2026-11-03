"""結帳日與繳款截止日的日期計算。

信用卡的結帳日、繳款日通常以「每月幾號」表示。若當月沒有那一天
（例如 31 號遇到 2 月），則以當月最後一天計算。

一個帳單週期為「上一個結帳日的隔天」到「本次結帳日」（含）。
"""

from __future__ import annotations

import calendar
from datetime import date


def clamp_day(year: int, month: int, day: int) -> date:
    """回傳 year/month 的第 day 天；超過當月天數時取當月最後一天。"""
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(day, last))


def shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    """把 (year, month) 往前或往後移動 delta 個月。"""
    y, m0 = divmod(year * 12 + (month - 1) + delta, 12)
    return y, m0 + 1


def add_months(d: date, months: int, day: int | None = None) -> date:
    """把日期往後移動數個月，日期以 day（預設為原本的日）為準並自動夾到月底。"""
    y, m = shift_month(d.year, d.month, months)
    return clamp_day(y, m, d.day if day is None else day)


def closing_on_or_after(d: date, statement_day: int) -> date:
    """d 當天或之後的第一個結帳日（也就是包含 d 的帳單週期的結帳日）。"""
    closing = clamp_day(d.year, d.month, statement_day)
    if closing >= d:
        return closing
    y, m = shift_month(d.year, d.month, 1)
    return clamp_day(y, m, statement_day)


def previous_closing(closing: date, statement_day: int) -> date:
    """上一期的結帳日。"""
    y, m = shift_month(closing.year, closing.month, -1)
    return clamp_day(y, m, statement_day)


def next_closing(closing: date, statement_day: int) -> date:
    """下一期的結帳日。"""
    y, m = shift_month(closing.year, closing.month, 1)
    return clamp_day(y, m, statement_day)


def due_date_for(closing: date, due_day: int) -> date:
    """結帳日之後第一個「每月 due_day 號」即為該期繳款截止日。"""
    due = clamp_day(closing.year, closing.month, due_day)
    if due > closing:
        return due
    y, m = shift_month(closing.year, closing.month, 1)
    return clamp_day(y, m, due_day)


def parse_date(text: str) -> date:
    """解析 ``YYYY-MM-DD`` 或 ``YYYY/MM/DD``，另支援 ``today``／``今天``。"""
    raw = text.strip()
    if raw.lower() == "today" or raw == "今天":
        return date.today()
    try:
        return date.fromisoformat(raw.replace("/", "-"))
    except ValueError:
        pass
    parts = raw.replace("/", "-").split("-")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        try:
            return date(int(parts[0]), int(parts[1]), int(parts[2]))
        except ValueError:
            pass
    raise ValueError(f"無效的日期：{text}（請使用 YYYY-MM-DD 格式）")


def describe_days(target: date, today: date) -> str:
    """把日期差轉成「今天／明天／3 天後／2 天前」這類描述。"""
    diff = (target - today).days
    if diff == 0:
        return "今天"
    if diff == 1:
        return "明天"
    if diff == -1:
        return "昨天"
    if diff > 0:
        return f"{diff} 天後"
    return f"{-diff} 天前"
