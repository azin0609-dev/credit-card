"""SQLite 資料存取層。"""

from __future__ import annotations

import os
import sqlite3
from datetime import date
from pathlib import Path

from .billing import CardSnapshot, build_snapshot
from .models import Card, Installment, Payment, StatementOverride, Transaction

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    bank TEXT NOT NULL DEFAULT '',
    last4 TEXT NOT NULL DEFAULT '',
    credit_limit INTEGER NOT NULL DEFAULT 0,
    statement_day INTEGER NOT NULL CHECK (statement_day BETWEEN 1 AND 31),
    due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    min_payment_rate REAL NOT NULL DEFAULT 10,
    min_payment_floor INTEGER NOT NULL DEFAULT 100000,
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_transactions_card_date ON transactions(card_id, date);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_payments_card_date ON payments(card_id, date);

CREATE TABLE IF NOT EXISTS installments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    start_date TEXT NOT NULL,
    total_amount INTEGER NOT NULL CHECK (total_amount > 0),
    periods INTEGER NOT NULL CHECK (periods >= 1),
    description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS statement_overrides (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    closing_date TEXT NOT NULL,
    balance INTEGER,
    min_payment INTEGER,
    PRIMARY KEY (card_id, closing_date)
);
"""


def default_db_path() -> Path:
    env = os.environ.get("CREDIT_CARD_DB")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".credit-card" / "cards.db"


def _d(value: str) -> date:
    return date.fromisoformat(value)


class Database:
    def __init__(self, path: str | os.PathLike[str]):
        path_str = str(path)
        if path_str != ":memory:":
            Path(path_str).expanduser().parent.mkdir(parents=True, exist_ok=True)
            path_str = str(Path(path_str).expanduser())
        self.conn = sqlite3.connect(path_str)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._migrate()

    def _migrate(self) -> None:
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError("資料庫版本比程式新，請更新程式後再使用。")
        with self.conn:
            self.conn.executescript(SCHEMA)
            self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ cards
    @staticmethod
    def _card(row: sqlite3.Row) -> Card:
        return Card(
            id=row["id"],
            name=row["name"],
            bank=row["bank"],
            last4=row["last4"],
            credit_limit=row["credit_limit"],
            statement_day=row["statement_day"],
            due_day=row["due_day"],
            min_payment_rate=row["min_payment_rate"],
            min_payment_floor=row["min_payment_floor"],
            note=row["note"],
        )

    def add_card(self, card: Card) -> Card:
        try:
            with self.conn:
                cur = self.conn.execute(
                    """INSERT INTO cards (name, bank, last4, credit_limit, statement_day,
                       due_day, min_payment_rate, min_payment_floor, note)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        card.name,
                        card.bank,
                        card.last4,
                        card.credit_limit,
                        card.statement_day,
                        card.due_day,
                        card.min_payment_rate,
                        card.min_payment_floor,
                        card.note,
                    ),
                )
        except sqlite3.IntegrityError:
            raise ValueError(f"已經有名為「{card.name}」的卡片") from None
        card.id = cur.lastrowid
        return card

    def update_card(self, card: Card) -> None:
        try:
            with self.conn:
                self.conn.execute(
                    """UPDATE cards SET name = ?, bank = ?, last4 = ?, credit_limit = ?,
                       statement_day = ?, due_day = ?, min_payment_rate = ?,
                       min_payment_floor = ?, note = ? WHERE id = ?""",
                    (
                        card.name,
                        card.bank,
                        card.last4,
                        card.credit_limit,
                        card.statement_day,
                        card.due_day,
                        card.min_payment_rate,
                        card.min_payment_floor,
                        card.note,
                        card.id,
                    ),
                )
        except sqlite3.IntegrityError:
            raise ValueError(f"已經有名為「{card.name}」的卡片") from None

    def get_card(self, card_id: int) -> Card | None:
        row = self.conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
        return self._card(row) if row else None

    def find_card(self, ref: str) -> Card | None:
        """以卡片名稱（優先）或 ID 尋找卡片；名稱不分大小寫。"""
        ref = ref.strip()
        row = self.conn.execute("SELECT * FROM cards WHERE name = ?", (ref,)).fetchone()
        if row is None:
            row = self.conn.execute(
                "SELECT * FROM cards WHERE lower(name) = lower(?)", (ref,)
            ).fetchone()
        if row is None and ref.isdigit():
            row = self.conn.execute("SELECT * FROM cards WHERE id = ?", (int(ref),)).fetchone()
        return self._card(row) if row else None

    def list_cards(self) -> list[Card]:
        rows = self.conn.execute("SELECT * FROM cards ORDER BY id").fetchall()
        return [self._card(r) for r in rows]

    def delete_card(self, card_id: int) -> bool:
        with self.conn:
            cur = self.conn.execute("DELETE FROM cards WHERE id = ?", (card_id,))
        return cur.rowcount > 0

    # ----------------------------------------------------------- transactions
    @staticmethod
    def _txn(row: sqlite3.Row) -> Transaction:
        return Transaction(
            id=row["id"],
            card_id=row["card_id"],
            date=_d(row["date"]),
            amount=row["amount"],
            description=row["description"],
            category=row["category"],
        )

    def add_transaction(self, txn: Transaction) -> Transaction:
        with self.conn:
            cur = self.conn.execute(
                """INSERT INTO transactions (card_id, date, amount, description, category)
                   VALUES (?, ?, ?, ?, ?)""",
                (txn.card_id, txn.date.isoformat(), txn.amount, txn.description, txn.category),
            )
        txn.id = cur.lastrowid
        return txn

    def list_transactions(
        self,
        card_id: int | None = None,
        start: date | None = None,
        end: date | None = None,
    ) -> list[Transaction]:
        sql, params = self._range_query("transactions", card_id, start, end)
        return [self._txn(r) for r in self.conn.execute(sql, params).fetchall()]

    def delete_transaction(self, txn_id: int) -> bool:
        with self.conn:
            cur = self.conn.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))
        return cur.rowcount > 0

    # --------------------------------------------------------------- payments
    @staticmethod
    def _payment(row: sqlite3.Row) -> Payment:
        return Payment(
            id=row["id"],
            card_id=row["card_id"],
            date=_d(row["date"]),
            amount=row["amount"],
            note=row["note"],
        )

    def add_payment(self, payment: Payment) -> Payment:
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO payments (card_id, date, amount, note) VALUES (?, ?, ?, ?)",
                (payment.card_id, payment.date.isoformat(), payment.amount, payment.note),
            )
        payment.id = cur.lastrowid
        return payment

    def list_payments(
        self,
        card_id: int | None = None,
        start: date | None = None,
        end: date | None = None,
    ) -> list[Payment]:
        sql, params = self._range_query("payments", card_id, start, end)
        return [self._payment(r) for r in self.conn.execute(sql, params).fetchall()]

    def delete_payment(self, payment_id: int) -> bool:
        with self.conn:
            cur = self.conn.execute("DELETE FROM payments WHERE id = ?", (payment_id,))
        return cur.rowcount > 0

    # ----------------------------------------------------------- installments
    @staticmethod
    def _installment(row: sqlite3.Row) -> Installment:
        return Installment(
            id=row["id"],
            card_id=row["card_id"],
            start_date=_d(row["start_date"]),
            total_amount=row["total_amount"],
            periods=row["periods"],
            description=row["description"],
        )

    def add_installment(self, inst: Installment) -> Installment:
        with self.conn:
            cur = self.conn.execute(
                """INSERT INTO installments (card_id, start_date, total_amount, periods, description)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    inst.card_id,
                    inst.start_date.isoformat(),
                    inst.total_amount,
                    inst.periods,
                    inst.description,
                ),
            )
        inst.id = cur.lastrowid
        return inst

    def list_installments(self, card_id: int | None = None) -> list[Installment]:
        if card_id is None:
            rows = self.conn.execute("SELECT * FROM installments ORDER BY start_date, id")
        else:
            rows = self.conn.execute(
                "SELECT * FROM installments WHERE card_id = ? ORDER BY start_date, id",
                (card_id,),
            )
        return [self._installment(r) for r in rows.fetchall()]

    def delete_installment(self, inst_id: int) -> bool:
        with self.conn:
            cur = self.conn.execute("DELETE FROM installments WHERE id = ?", (inst_id,))
        return cur.rowcount > 0

    # ------------------------------------------------------ statement overrides
    def set_override(self, override: StatementOverride) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO statement_overrides (card_id, closing_date, balance, min_payment)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT (card_id, closing_date) DO UPDATE SET
                       balance = excluded.balance,
                       min_payment = excluded.min_payment""",
                (
                    override.card_id,
                    override.closing_date.isoformat(),
                    override.balance,
                    override.min_payment,
                ),
            )

    def get_override(self, card_id: int, closing_date: date) -> StatementOverride | None:
        row = self.conn.execute(
            "SELECT * FROM statement_overrides WHERE card_id = ? AND closing_date = ?",
            (card_id, closing_date.isoformat()),
        ).fetchone()
        if row is None:
            return None
        return StatementOverride(
            card_id=row["card_id"],
            closing_date=_d(row["closing_date"]),
            balance=row["balance"],
            min_payment=row["min_payment"],
        )

    def delete_override(self, card_id: int, closing_date: date) -> bool:
        with self.conn:
            cur = self.conn.execute(
                "DELETE FROM statement_overrides WHERE card_id = ? AND closing_date = ?",
                (card_id, closing_date.isoformat()),
            )
        return cur.rowcount > 0

    def list_overrides(self, card_id: int) -> list[StatementOverride]:
        rows = self.conn.execute(
            "SELECT * FROM statement_overrides WHERE card_id = ? ORDER BY closing_date",
            (card_id,),
        ).fetchall()
        return [
            StatementOverride(
                card_id=r["card_id"],
                closing_date=_d(r["closing_date"]),
                balance=r["balance"],
                min_payment=r["min_payment"],
            )
            for r in rows
        ]

    # ---------------------------------------------------------------- helpers
    @staticmethod
    def _range_query(
        table: str, card_id: int | None, start: date | None, end: date | None
    ) -> tuple[str, list[object]]:
        clauses: list[str] = []
        params: list[object] = []
        if card_id is not None:
            clauses.append("card_id = ?")
            params.append(card_id)
        if start is not None:
            clauses.append("date >= ?")
            params.append(start.isoformat())
        if end is not None:
            clauses.append("date <= ?")
            params.append(end.isoformat())
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        return f"SELECT * FROM {table}{where} ORDER BY date, id", params

    def snapshot(self, card: Card, today: date) -> CardSnapshot:
        assert card.id is not None
        return build_snapshot(
            card,
            self.list_transactions(card.id),
            self.list_payments(card.id),
            self.list_installments(card.id),
            self.list_overrides(card.id),
            today,
        )
