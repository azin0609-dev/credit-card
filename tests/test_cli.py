import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from creditcard.cli import display_width, main, render_table


class CLITestCase(unittest.TestCase):
    today = "2026-11-02"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self._tmp.name) / "cards.db")

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self, *args: str, today: str | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        argv = ["--db", self.db_path, "--today", today or self.today, *args]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = main(argv)
            except SystemExit as exc:  # argparse 錯誤
                code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue(), err.getvalue()

    def ok(self, *args: str, today: str | None = None) -> str:
        code, out, err = self.run_cli(*args, today=today)
        self.assertEqual(code, 0, msg=f"指令失敗：{args}\n{out}{err}")
        return out


class CardCommandTests(CLITestCase):
    def test_empty_summary_shows_hint(self):
        self.assertIn("尚未新增任何卡片", self.ok())

    def test_add_and_list_cards(self):
        out = self.ok("card", "add", "國泰CUBE", "-s", "25", "-d", "9", "--last4", "1234", "--limit", "100,000")
        self.assertIn("下次結帳日 2026-11-25", out)
        self.assertIn("該期繳款截止日 2026-12-09", out)
        self.ok("card", "add", "玉山Pi", "-s", "5", "-d", "20")
        out = self.ok("card", "list")
        self.assertIn("國泰CUBE", out)
        self.assertIn("$100,000", out)
        self.assertIn("玉山Pi", out)

    def test_duplicate_card_name(self):
        self.ok("card", "add", "A", "-s", "1", "-d", "15")
        code, _, err = self.run_cli("card", "add", "A", "-s", "1", "-d", "15")
        self.assertEqual(code, 1)
        self.assertIn("已經有名為「A」的卡片", err)

    def test_invalid_day_rejected(self):
        code, _, err = self.run_cli("card", "add", "A", "-s", "32", "-d", "15")
        self.assertNotEqual(code, 0)
        self.assertIn("1 到 31", err)

    def test_edit_and_remove(self):
        self.ok("card", "add", "A", "-s", "1", "-d", "15")
        self.ok("card", "edit", "A", "--name", "B", "--limit", "5000")
        self.assertIn("$5,000", self.ok("card", "list"))
        self.ok("card", "remove", "B", "--yes")
        self.assertIn("尚未新增任何卡片", self.ok("card", "list"))

    def test_unknown_card(self):
        code, _, err = self.run_cli("card", "show", "不存在")
        self.assertEqual(code, 1)
        self.assertIn("找不到卡片", err)

    def test_card_found_by_id(self):
        self.ok("card", "add", "A", "-s", "1", "-d", "15")
        self.assertIn("每月 1 日結帳", self.ok("card", "show", "1"))


class WorkflowTests(CLITestCase):
    def setUp(self):
        super().setUp()
        self.ok("card", "add", "CUBE", "-s", "25", "-d", "9", "--limit", "100000")

    def test_statement_override_and_payment_flow(self):
        out = self.ok("stmt", "set", "CUBE", "2026-10-25", "--balance", "12345", "--min", "1235")
        self.assertIn("待繳（剩 7 天）", out)

        out = self.ok("upcoming")
        self.assertIn("[繳款]  CUBE：2026-11-09 截止（7 天後）", out)

        out = self.ok("pay", "add", "CUBE", "--min")
        self.assertIn("$1,235", out)
        self.assertIn("已繳最低", out)

        out = self.ok("pay", "add", "CUBE", "--full")
        self.assertIn("$11,110", out)
        self.assertIn("已繳清", out)

        code, _, err = self.run_cli("pay", "add", "CUBE", "--full")
        self.assertEqual(code, 1)
        self.assertIn("已經繳足", err)

    def test_override_must_match_statement_day(self):
        code, _, err = self.run_cli("stmt", "set", "CUBE", "2026-10-24", "--balance", "100")
        self.assertEqual(code, 1)
        self.assertIn("最接近的結帳日是 2026-10-25", err)

        code, _, err = self.run_cli("stmt", "set", "CUBE", "2026-11-25", "--balance", "100")
        self.assertEqual(code, 1)
        self.assertIn("尚未結帳", err)

    def test_override_partial_update_and_unset(self):
        self.ok("stmt", "set", "CUBE", "2026-10-25", "--balance", "5000", "--min", "1000")
        out = self.ok("stmt", "set", "CUBE", "2026-10-25", "--min", "800")
        self.assertIn("應繳 $5,000，最低應繳 $800", out)
        self.ok("stmt", "unset", "CUBE", "2026-10-25")
        out = self.ok("stmt", "list", "CUBE")
        self.assertIn("$0", out)
        self.assertNotIn("$5,000", out)

    def test_transactions_and_overdue(self):
        self.ok("txn", "add", "CUBE", "8000", "機票", "--date", "2026-09-20", "-c", "旅遊")
        out = self.ok("txn", "add", "CUBE", "500", "退貨", "--refund", "--date", "2026-09-22")
        self.assertIn("-$500", out)
        self.assertIn("2026-09-25 結帳的帳單（已結帳）", out)

        out = self.ok("txn", "list", "--card", "CUBE")
        self.assertIn("機票", out)
        self.assertIn("合計 $7,500", out)

        out = self.ok("stmt", "list", "CUBE")
        self.assertIn("逾期未繳", out)  # 9/25 那期（歷史帳單）
        out = self.ok("summary")
        self.assertIn("待繳（剩 7 天）", out)
        # 10/25 那期：應繳仍為 7,500；最低應繳 = 本期下限 1,000 + 前期未繳的 1,000
        self.assertIn("$7,500", out)
        self.assertIn("$2,000", out)
        out = self.ok("upcoming", today="2026-11-12")
        self.assertIn("[逾期]", out)

    def test_installment_commands(self):
        out = self.ok("inst", "add", "CUBE", "36000", "12", "iPhone", "--start-date", "2026-08-10")
        self.assertIn("每期 $3,000", out)
        out = self.ok("inst", "list")
        self.assertIn("3/12", out)
        self.assertIn("$27,000", out)
        out = self.ok("card", "show", "CUBE")
        self.assertIn("未到期分期    $27,000", out)
        self.assertIn("可用額度      $64,000", out)
        self.ok("inst", "remove", "1")
        self.assertIn("沒有進行中的分期", self.ok("inst", "list"))

    def test_remove_missing_records(self):
        for kind in ("txn", "pay", "inst"):
            code, _, err = self.run_cli(kind, "remove", "99")
            self.assertEqual(code, 1, kind)
            self.assertIn("#99", err)


class TableRenderingTests(unittest.TestCase):
    def test_display_width_counts_cjk_as_two(self):
        self.assertEqual(display_width("abc"), 3)
        self.assertEqual(display_width("國泰"), 4)
        self.assertEqual(display_width("（剩 7 天）"), 11)

    def test_render_table_aligns_columns(self):
        lines = render_table(["名稱", "金額"], [["國泰", "$1"], ["AB", "$100"]], "lr").splitlines()
        widths = {display_width(line) for line in lines}
        self.assertEqual(len(widths), 1)


if __name__ == "__main__":
    unittest.main()
