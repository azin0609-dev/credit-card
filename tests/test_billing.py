import unittest
from datetime import date

from creditcard.billing import StatementStatus, build_snapshot, minimum_payment
from creditcard.models import Card, Installment, Payment, StatementOverride, Transaction

D = 100  # 1 元


def card(**kwargs) -> Card:
    defaults = dict(name="測試卡", statement_day=25, due_day=9, credit_limit=100_000 * D, id=1)
    defaults.update(kwargs)
    return Card(**defaults)


def txn(day: date, amount: int) -> Transaction:
    return Transaction(card_id=1, date=day, amount=amount * D)


def pay(day: date, amount: int) -> Payment:
    return Payment(card_id=1, date=day, amount=amount * D)


def snapshot(c=None, txns=(), pays=(), insts=(), overrides=(), today=date(2026, 11, 2)):
    return build_snapshot(c or card(), list(txns), list(pays), list(insts), list(overrides), today)


class MinimumPaymentTests(unittest.TestCase):
    def test_rate_applies_above_floor(self):
        self.assertEqual(minimum_payment(20_000 * D, 10, 1000 * D), 2000 * D)

    def test_floor_applies(self):
        self.assertEqual(minimum_payment(5000 * D, 10, 1000 * D), 1000 * D)

    def test_small_balance_must_be_paid_in_full(self):
        self.assertEqual(minimum_payment(800 * D, 10, 1000 * D), 800 * D)

    def test_rounds_up_to_whole_dollar(self):
        self.assertEqual(minimum_payment(12_345 * D, 10, 1000 * D), 1235 * D)

    def test_zero_or_credit_balance(self):
        self.assertEqual(minimum_payment(0, 10, 1000 * D), 0)
        self.assertEqual(minimum_payment(-500 * D, 10, 1000 * D), 0)

    def test_full_amount_part_is_paid_in_full(self):
        # 一般消費 20,000 × 10% + 分期當期 3,000 全額
        self.assertEqual(minimum_payment(23_000 * D, 10, 1000 * D, 3000 * D), 5000 * D)
        # 全額部分不會超過應繳總額
        self.assertEqual(minimum_payment(2000 * D, 10, 1000 * D, 9000 * D), 2000 * D)


class SnapshotTests(unittest.TestCase):
    def test_no_records(self):
        snap = snapshot()
        self.assertEqual(snap.statements, [])
        self.assertIsNone(snap.latest)
        self.assertEqual(snap.total_debt, 0)
        self.assertEqual(snap.next_closing_date, date(2026, 11, 25))
        self.assertEqual(snap.next_due_date, date(2026, 12, 9))

    def test_cycle_boundaries(self):
        # 10/25 結帳：10/25 當天的消費算本期，10/26 的算下一期
        snap = snapshot(txns=[txn(date(2026, 10, 25), 1000), txn(date(2026, 10, 26), 500)])
        self.assertEqual(len(snap.statements), 1)
        stmt = snap.latest
        self.assertEqual(stmt.closing_date, date(2026, 10, 25))
        self.assertEqual(stmt.period_start, date(2026, 9, 26))
        self.assertEqual(stmt.due_date, date(2026, 11, 9))
        self.assertEqual(stmt.balance, 1000 * D)
        self.assertEqual(snap.unbilled_charges, 500 * D)
        self.assertEqual(snap.current_balance, 1500 * D)

    def test_closing_day_itself_is_still_open(self):
        snap = snapshot(txns=[txn(date(2026, 10, 20), 1000)], today=date(2026, 10, 25))
        self.assertEqual(snap.statements, [])
        self.assertEqual(snap.next_closing_date, date(2026, 10, 25))
        self.assertEqual(snap.unbilled_charges, 1000 * D)

    def test_statuses(self):
        txns = [txn(date(2026, 10, 10), 20_000)]
        pending = snapshot(txns=txns).latest
        self.assertEqual(pending.min_payment, 2000 * D)
        self.assertEqual(pending.status(date(2026, 11, 2)), StatementStatus.PENDING)
        self.assertEqual(pending.status(date(2026, 11, 10)), StatementStatus.OVERDUE)

        min_paid = snapshot(txns=txns, pays=[pay(date(2026, 11, 1), 2000)]).latest
        self.assertEqual(min_paid.status(date(2026, 11, 2)), StatementStatus.MIN_PAID)
        self.assertEqual(min_paid.remaining, 18_000 * D)
        self.assertEqual(min_paid.min_remaining, 0)

        paid = snapshot(txns=txns, pays=[pay(date(2026, 11, 1), 20_000)]).latest
        self.assertEqual(paid.status(date(2026, 11, 2)), StatementStatus.PAID)

        empty = snapshot(txns=[txn(date(2026, 10, 10), 100), txn(date(2026, 10, 11), -100)]).latest
        self.assertEqual(empty.status(date(2026, 11, 2)), StatementStatus.NO_PAYMENT)

    def test_carry_over_and_unpaid_minimum_accumulates(self):
        snap = snapshot(
            txns=[txn(date(2026, 8, 10), 5000), txn(date(2026, 9, 10), 5000)],
            pays=[pay(date(2026, 9, 1), 500)],  # 8/25 那期最低應繳 1000 只繳了 500
        )
        aug, sep, octo = snap.statements
        self.assertEqual(aug.balance, 5000 * D)
        self.assertEqual(aug.min_payment, 1000 * D)
        self.assertEqual(aug.paid, 500 * D)
        self.assertEqual(sep.previous_balance, 5000 * D)
        self.assertEqual(sep.credits, 500 * D)
        self.assertEqual(sep.balance, 9500 * D)
        # 9500×10% = 950 → 下限 1000，加上前期未繳足的 500
        self.assertEqual(sep.min_payment, 1500 * D)
        # 9/25 那期完全沒繳：10% 下限 1000 + 前期未繳 1500
        self.assertEqual(octo.balance, 9500 * D)
        self.assertEqual(octo.min_payment, 2500 * D)

    def test_override_replaces_computed_values_and_carries_forward(self):
        overrides = [
            StatementOverride(
                card_id=1, closing_date=date(2026, 9, 25), balance=12_345 * D, min_payment=1235 * D
            )
        ]
        snap = snapshot(
            txns=[txn(date(2026, 10, 1), 1000)],
            pays=[pay(date(2026, 10, 5), 12_345)],
            overrides=overrides,
        )
        sep, octo = snap.statements
        self.assertTrue(sep.overridden)
        self.assertEqual(sep.balance, 12_345 * D)
        self.assertEqual(sep.min_payment, 1235 * D)
        self.assertEqual(sep.status(date(2026, 11, 2)), StatementStatus.PAID)
        self.assertEqual(octo.previous_balance, 12_345 * D)
        self.assertEqual(octo.balance, 1000 * D)
        self.assertFalse(octo.overridden)

    def test_override_balance_only_recomputes_minimum(self):
        overrides = [StatementOverride(card_id=1, closing_date=date(2026, 10, 25), balance=30_000 * D)]
        stmt = snapshot(overrides=overrides).latest
        self.assertEqual(stmt.balance, 30_000 * D)
        self.assertEqual(stmt.min_payment, 3000 * D)

    def test_overpayment_gives_credit_balance(self):
        snap = snapshot(
            txns=[txn(date(2026, 10, 10), 1000), txn(date(2026, 10, 28), 300)],
            pays=[pay(date(2026, 10, 30), 1500)],
        )
        self.assertEqual(snap.latest.status(date(2026, 11, 2)), StatementStatus.PAID)
        self.assertEqual(snap.current_balance, -200 * D)

    def test_future_records_are_ignored(self):
        snap = snapshot(txns=[txn(date(2026, 12, 1), 1000)], pays=[pay(date(2026, 12, 1), 50)])
        self.assertEqual(snap.current_balance, 0)
        self.assertEqual(snap.statements, [])

    def test_installments(self):
        inst = Installment(
            card_id=1, start_date=date(2026, 8, 10), total_amount=10_000 * D, periods=3, id=1
        )
        self.assertEqual(
            inst.schedule(),
            [
                (date(2026, 8, 10), 3334 * D),
                (date(2026, 9, 10), 3333 * D),
                (date(2026, 10, 10), 3333 * D),
            ],
        )
        snap = snapshot(insts=[inst], today=date(2026, 9, 30))
        self.assertEqual([s.new_charges for s in snap.statements], [3334 * D, 3333 * D])
        self.assertEqual(snap.remaining_installments, 3333 * D)
        self.assertEqual(snap.total_debt, 10_000 * D)
        self.assertEqual(snap.available_credit, 90_000 * D)
        progress = snap.installments[0]
        self.assertEqual(progress.posted_periods, 2)
        self.assertEqual(progress.next_date, date(2026, 10, 10))
        self.assertFalse(progress.finished)

    def test_installment_period_counts_fully_toward_minimum(self):
        inst = Installment(
            card_id=1, start_date=date(2026, 10, 10), total_amount=36_000 * D, periods=12, id=1
        )
        stmt = snapshot(txns=[txn(date(2026, 10, 1), 20_000)], insts=[inst]).latest
        self.assertEqual(stmt.balance, 23_000 * D)
        # 20,000 × 10% + 分期 3,000
        self.assertEqual(stmt.min_payment, 5000 * D)

    def test_amount_over_credit_limit_counts_fully_toward_minimum(self):
        c = card(credit_limit=10_000 * D)
        stmt = snapshot(c, txns=[txn(date(2026, 10, 1), 12_000)]).latest
        # 超額 2,000 全額 + 其餘 10,000 × 10%
        self.assertEqual(stmt.min_payment, 3000 * D)

    def test_month_end_statement_day(self):
        c = card(statement_day=31, due_day=15)
        snap = snapshot(c, txns=[txn(date(2026, 2, 10), 1000)], today=date(2026, 3, 5))
        stmt = snap.latest
        self.assertEqual(stmt.closing_date, date(2026, 2, 28))
        self.assertEqual(stmt.due_date, date(2026, 3, 15))
        self.assertEqual(snap.next_closing_date, date(2026, 3, 31))


class ModelValidationTests(unittest.TestCase):
    def test_card_validation(self):
        with self.assertRaises(ValueError):
            card(statement_day=0)
        with self.assertRaises(ValueError):
            card(due_day=32)
        with self.assertRaises(ValueError):
            card(last4="12a4")
        with self.assertRaises(ValueError):
            card(name="  ")

    def test_payment_and_installment_validation(self):
        with self.assertRaises(ValueError):
            Payment(card_id=1, date=date(2026, 1, 1), amount=0)
        with self.assertRaises(ValueError):
            Installment(card_id=1, start_date=date(2026, 1, 1), total_amount=100, periods=0)


if __name__ == "__main__":
    unittest.main()
