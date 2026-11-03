"""金額處理。

內部一律以「分」(整數) 儲存與計算，避免浮點數誤差；
1 元 = 100 分。顯示時再轉回「元」。
"""

from __future__ import annotations

from decimal import ROUND_CEILING, Decimal, InvalidOperation

UNIT = 100  # 1 元 = 100 分


def parse_amount(text: str | int | Decimal) -> int:
    """把使用者輸入的金額字串轉成「分」。

    支援千分位逗號與 NT$ / $ 前綴，例如 ``"1,234"``、``"NT$99.5"``、``"-300"``。
    """
    raw = str(text).strip().replace(",", "").replace("，", "")
    sign = 1
    if raw.startswith("-"):
        sign, raw = -1, raw[1:]
    elif raw.startswith("+"):
        raw = raw[1:]
    for prefix in ("NT$", "nt$", "$"):
        if raw.startswith(prefix):
            raw = raw[len(prefix):]
            break
    try:
        value = Decimal(raw)
    except InvalidOperation:
        raise ValueError(f"無效的金額：{text}") from None
    if not value.is_finite() or value < 0:
        raise ValueError(f"無效的金額：{text}")
    cents = value * UNIT
    if cents != cents.to_integral_value():
        raise ValueError(f"金額最多只能到小數點後兩位：{text}")
    return sign * int(cents)


def format_amount(cents: int) -> str:
    """把「分」格式化成 ``$1,234`` 或 ``$1,234.50``。"""
    sign = "-" if cents < 0 else ""
    dollars, rem = divmod(abs(cents), UNIT)
    if rem:
        return f"{sign}${dollars:,}.{rem:02d}"
    return f"{sign}${dollars:,}"


def ceil_to_unit(cents: Decimal | int) -> int:
    """無條件進位到整數元（回傳仍是「分」）。"""
    whole = (Decimal(cents) / UNIT).to_integral_value(rounding=ROUND_CEILING)
    return int(whole) * UNIT
