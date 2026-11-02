import unittest
from datetime import date

from creditcard.dates import (
    add_months,
    clamp_day,
    closing_on_or_after,
    describe_days,
    due_date_for,
    next_closing,
    parse_date,
    previous_closing,
)
from creditcard.money import ceil_to_unit, format_amount, parse_amount


class DateTests(unittest.TestCase):
    def test_clamp_day_to_month_end(self):
        self.assertEqual(clamp_day(2026, 2, 31), date(2026, 2, 28))
        self.assertEqual(clamp_day(2028, 2, 31), date(2028, 2, 29))
        self.assertEqual(clamp_day(2026, 4, 31), date(2026, 4, 30))

    def test_add_months_keeps_original_day(self):
        jan31 = date(2026, 1, 31)
        self.assertEqual(add_months(jan31, 1), date(2026, 2, 28))
        self.assertEqual(add_months(jan31, 2), date(2026, 3, 31))
        self.assertEqual(add_months(date(2026, 11, 10), 3), date(2027, 2, 10))

    def test_closing_on_or_after(self):
        self.assertEqual(closing_on_or_after(date(2026, 11, 2), 25), date(2026, 11, 25))
        self.assertEqual(closing_on_or_after(date(2026, 11, 25), 25), date(2026, 11, 25))
        self.assertEqual(closing_on_or_after(date(2026, 11, 26), 25), date(2026, 12, 25))
        self.assertEqual(closing_on_or_after(date(2026, 12, 26), 25), date(2027, 1, 25))
        # 31 號結帳遇到 2 月
        self.assertEqual(closing_on_or_after(date(2026, 2, 1), 31), date(2026, 2, 28))

    def test_previous_and_next_closing_with_month_end(self):
        feb = date(2026, 2, 28)
        self.assertEqual(next_closing(feb, 31), date(2026, 3, 31))
        self.assertEqual(previous_closing(feb, 31), date(2026, 1, 31))
        self.assertEqual(previous_closing(date(2026, 1, 5), 5), date(2025, 12, 5))

    def test_due_date_same_month(self):
        self.assertEqual(due_date_for(date(2026, 11, 5), 20), date(2026, 11, 20))

    def test_due_date_next_month(self):
        self.assertEqual(due_date_for(date(2026, 10, 25), 9), date(2026, 11, 9))
        self.assertEqual(due_date_for(date(2026, 12, 15), 1), date(2027, 1, 1))
        # 繳款日不會與結帳日同一天
        self.assertEqual(due_date_for(date(2026, 11, 5), 5), date(2026, 12, 5))

    def test_parse_date(self):
        self.assertEqual(parse_date("2026-11-02"), date(2026, 11, 2))
        self.assertEqual(parse_date("2026/1/5"), date(2026, 1, 5))
        with self.assertRaises(ValueError):
            parse_date("2026-02-30")
        with self.assertRaises(ValueError):
            parse_date("昨天")

    def test_describe_days(self):
        today = date(2026, 11, 2)
        self.assertEqual(describe_days(today, today), "今天")
        self.assertEqual(describe_days(date(2026, 11, 3), today), "明天")
        self.assertEqual(describe_days(date(2026, 11, 9), today), "7 天後")
        self.assertEqual(describe_days(date(2026, 11, 1), today), "昨天")
        self.assertEqual(describe_days(date(2026, 10, 20), today), "13 天前")


class MoneyTests(unittest.TestCase):
    def test_parse_amount(self):
        self.assertEqual(parse_amount("1,234"), 123400)
        self.assertEqual(parse_amount("NT$99.5"), 9950)
        self.assertEqual(parse_amount("$0.01"), 1)
        self.assertEqual(parse_amount("-300"), -30000)
        self.assertEqual(parse_amount(" 500 "), 50000)

    def test_parse_amount_rejects_bad_input(self):
        for bad in ["abc", "", "1.234", "NaN", "inf", "--5"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                parse_amount(bad)

    def test_format_amount(self):
        self.assertEqual(format_amount(123400), "$1,234")
        self.assertEqual(format_amount(9950), "$99.50")
        self.assertEqual(format_amount(-50000), "-$500")
        self.assertEqual(format_amount(0), "$0")

    def test_ceil_to_unit(self):
        self.assertEqual(ceil_to_unit(123401), 123500)
        self.assertEqual(ceil_to_unit(123400), 123400)


if __name__ == "__main__":
    unittest.main()
