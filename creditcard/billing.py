"""帳單試算。

模型說明
--------
* 每期「本期應繳總額」= 上期應繳總額 − 本期週期內的繳款 + 本期週期內的消費（含分期入帳）。
* 「最低應繳金額」= 應繳總額 × 最低應繳比例（無條件進位到元），且不低於「最低應繳下限」；
  應繳總額低於下限時須全額繳清。若上一期的最低應繳沒有繳足，差額會累加到本期。
  各銀行規則不盡相同，建議以 ``stmt set`` 輸入銀行帳單上的實際金額覆蓋試算結果。
* 某期帳單「已繳金額」= 該期結帳日之後、下一個結帳日（含）之前的繳款。

所有計算只看「今天」（含）以前的紀錄；未來日期的分期款會列為「未到期分期」。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import Enum

from .dates import (
    closing_on_or_after,
    due_date_for,
    next_closing,
    previous_closing,
)
from .models import Card, Installment, Payment, StatementOverride, Transaction
from .money import ceil_to_unit


class StatementStatus(Enum):
    NO_PAYMENT = "免繳"
    PAID = "已繳清"
    MIN_PAID = "已繳最低"
    PENDING = "待繳"
    OVERDUE = "逾期"


def minimum_payment(balance: int, rate_percent: float, floor: int) -> int:
    """依比例與下限計算最低應繳金額。"""
    if balance <= 0:
        return 0
    if balance <= floor:
        return balance
    by_rate = ceil_to_unit(Decimal(balance) * Decimal(str(rate_percent)) / 100)
    return min(max(by_rate, floor), balance)


@dataclass
class Statement:
    """一期帳單。"""

    closing_date: date  # 結帳日
    due_date: date  # 繳款截止日
    period_start: date  # 週期起始日
    previous_balance: int  # 上期應繳總額
    credits: int  # 週期內的繳款（用來抵上期）
    new_charges: int  # 週期內新增消費（含分期、退款）
    balance: int  # 本期應繳總額
    min_payment: int  # 最低應繳金額
    paid: int  # 結帳後已繳金額
    overridden: bool = False  # 是否為手動輸入的帳單金額

    @property
    def remaining(self) -> int:
        """尚未繳清的金額。"""
        return max(self.balance - self.paid, 0)

    @property
    def min_remaining(self) -> int:
        """距離最低應繳還差多少。"""
        return max(self.min_payment - self.paid, 0)

    def status(self, today: date) -> StatementStatus:
        if self.balance <= 0:
            return StatementStatus.NO_PAYMENT
        if self.paid >= self.balance:
            return StatementStatus.PAID
        if self.paid >= self.min_payment:
            return StatementStatus.MIN_PAID
        if today > self.due_date:
            return StatementStatus.OVERDUE
        return StatementStatus.PENDING


@dataclass
class InstallmentProgress:
    installment: Installment
    posted_periods: int  # 已入帳期數
    posted_amount: int
    remaining_amount: int  # 尚未入帳的金額
    next_date: date | None  # 下一期入帳日

    @property
    def finished(self) -> bool:
        return self.next_date is None


def installment_progress(inst: Installment, today: date) -> InstallmentProgress:
    schedule = inst.schedule()
    posted = [(d, a) for d, a in schedule if d <= today]
    pending = [(d, a) for d, a in schedule if d > today]
    return InstallmentProgress(
        installment=inst,
        posted_periods=len(posted),
        posted_amount=sum(a for _, a in posted),
        remaining_amount=sum(a for _, a in pending),
        next_date=pending[0][0] if pending else None,
    )


@dataclass
class CardSnapshot:
    """某張卡在「今天」的完整狀態。"""

    card: Card
    today: date
    statements: list[Statement]
    unbilled_charges: int  # 未出帳消費
    unbilled_payments: int  # 上次結帳後的繳款
    current_balance: int  # 目前帳上欠款（已出帳未繳 + 未出帳）
    installments: list[InstallmentProgress] = field(default_factory=list)
    next_closing_date: date | None = None
    next_due_date: date | None = None

    @property
    def latest(self) -> Statement | None:
        """最近一期已結帳的帳單。"""
        return self.statements[-1] if self.statements else None

    @property
    def remaining_installments(self) -> int:
        """尚未入帳的分期金額。"""
        return sum(p.remaining_amount for p in self.installments)

    @property
    def total_debt(self) -> int:
        """總欠款 = 目前帳上欠款 + 尚未入帳的分期金額。"""
        return self.current_balance + self.remaining_installments

    @property
    def available_credit(self) -> int:
        return self.card.credit_limit - self.total_debt


def build_snapshot(
    card: Card,
    transactions: list[Transaction],
    payments: list[Payment],
    installments: list[Installment],
    overrides: list[StatementOverride],
    today: date,
) -> CardSnapshot:
    sd = card.statement_day

    charges: list[tuple[date, int]] = [(t.date, t.amount) for t in transactions]
    for inst in installments:
        charges.extend(inst.schedule())
    charges = [(d, a) for d, a in charges if d <= today]
    pays = [(p.date, p.amount) for p in payments if p.date <= today]
    override_map = {o.closing_date: o for o in overrides if o.closing_date < today}

    def total(items: list[tuple[date, int]], start_exclusive: date, end_inclusive: date) -> int:
        return sum(a for d, a in items if start_exclusive < d <= end_inclusive)

    anchors = [d for d, _ in charges] + [d for d, _ in pays] + list(override_map)
    first_day = min(anchors) if anchors else today
    closing = closing_on_or_after(first_day, sd)
    prev_closing = previous_closing(closing, sd)

    statements: list[Statement] = []
    prev_balance = 0
    unpaid_min = 0  # 上期未繳足的最低應繳
    # 結帳日當天仍屬於進行中的週期，隔天才算已出帳。
    while closing < today:
        credits = total(pays, prev_closing, closing)
        new_charges = total(charges, prev_closing, closing)
        balance = prev_balance - credits + new_charges

        override = override_map.get(closing)
        overridden = override is not None
        if override is not None and override.balance is not None:
            balance = override.balance

        if override is not None and override.min_payment is not None:
            min_pay = override.min_payment
        elif balance > 0:
            base = minimum_payment(balance, card.min_payment_rate, card.min_payment_floor)
            min_pay = min(balance, base + unpaid_min)
        else:
            min_pay = 0

        following = next_closing(closing, sd)
        paid = total(pays, closing, following)
        statements.append(
            Statement(
                closing_date=closing,
                due_date=due_date_for(closing, card.due_day),
                period_start=date.fromordinal(prev_closing.toordinal() + 1),
                previous_balance=prev_balance,
                credits=credits,
                new_charges=new_charges,
                balance=balance,
                min_payment=min_pay,
                paid=paid,
                overridden=overridden,
            )
        )
        unpaid_min = max(min_pay - paid, 0) if balance > 0 else 0
        prev_balance = balance
        prev_closing, closing = closing, following

    unbilled_charges = total(charges, prev_closing, today)
    unbilled_payments = total(pays, prev_closing, today)
    return CardSnapshot(
        card=card,
        today=today,
        statements=statements,
        unbilled_charges=unbilled_charges,
        unbilled_payments=unbilled_payments,
        current_balance=prev_balance - unbilled_payments + unbilled_charges,
        installments=[installment_progress(i, today) for i in installments],
        next_closing_date=closing,
        next_due_date=due_date_for(closing, card.due_day),
    )
