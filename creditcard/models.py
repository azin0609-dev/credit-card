"""資料模型。所有金額皆以「分」為單位的整數。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from .dates import add_months
from .money import UNIT


def _check_day(name: str, value: int) -> None:
    if not 1 <= value <= 31:
        raise ValueError(f"{name}必須介於 1 到 31 之間：{value}")


@dataclass
class Card:
    """一張信用卡的基本設定。"""

    name: str
    statement_day: int  # 每月結帳日
    due_day: int  # 每月繳款截止日
    bank: str = ""
    last4: str = ""
    credit_limit: int = 0  # 信用額度
    min_payment_rate: float = 10.0  # 最低應繳比例（%）
    min_payment_floor: int = 1000 * UNIT  # 最低應繳下限金額
    note: str = ""
    id: int | None = None

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("卡片名稱不可為空白")
        _check_day("結帳日", self.statement_day)
        _check_day("繳款截止日", self.due_day)
        if not 0 <= self.min_payment_rate <= 100:
            raise ValueError(f"最低應繳比例必須介於 0 到 100 之間：{self.min_payment_rate}")
        if self.credit_limit < 0:
            raise ValueError("信用額度不可為負數")
        if self.min_payment_floor < 0:
            raise ValueError("最低應繳下限不可為負數")
        if self.last4 and not (self.last4.isdigit() and len(self.last4) == 4):
            raise ValueError(f"卡號末四碼必須是 4 位數字：{self.last4}")

    @property
    def label(self) -> str:
        return f"{self.name} (*{self.last4})" if self.last4 else self.name


@dataclass
class Transaction:
    """一筆消費；退款／折抵請用負數。"""

    card_id: int
    date: date
    amount: int
    description: str = ""
    category: str = ""
    id: int | None = None

    def __post_init__(self) -> None:
        if self.amount == 0:
            raise ValueError("消費金額不可為 0")


@dataclass
class Payment:
    """一筆繳款。"""

    card_id: int
    date: date
    amount: int
    note: str = ""
    id: int | None = None

    def __post_init__(self) -> None:
        if self.amount <= 0:
            raise ValueError("繳款金額必須大於 0")


@dataclass
class Installment:
    """分期付款：每月自動入帳一期。"""

    card_id: int
    start_date: date  # 第一期入帳日
    total_amount: int
    periods: int
    description: str = ""
    id: int | None = None

    def __post_init__(self) -> None:
        if self.total_amount <= 0:
            raise ValueError("分期總金額必須大於 0")
        if self.periods < 1:
            raise ValueError("分期期數至少為 1")

    def schedule(self) -> list[tuple[date, int]]:
        """每一期的 (入帳日, 金額)。每期取整數元，餘數併入第一期。"""
        base = (self.total_amount // self.periods) // UNIT * UNIT
        first = self.total_amount - base * (self.periods - 1)
        return [
            (add_months(self.start_date, k), first if k == 0 else base)
            for k in range(self.periods)
        ]


@dataclass
class StatementOverride:
    """手動輸入的帳單金額（以銀行實際帳單為準），可覆蓋程式試算結果。"""

    card_id: int
    closing_date: date
    balance: int | None = None  # 本期應繳總額
    min_payment: int | None = None  # 最低應繳金額
