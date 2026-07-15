"""reconcile.py — Daily payment reconciliation script.

Compares settlement file against bank statement, identifies
discrepancies, and produces a reconciliation report.
"""
from __future__ import annotations

import csv
import sys
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path


@dataclass
class SettlementRecord:
    merchant_id: str
    gross: Decimal
    fee: Decimal
    net: Decimal
    tx_count: int


@dataclass
class BankRecord:
    merchant_id: str
    credited_amount: Decimal
    value_date: str


@dataclass
class Discrepancy:
    merchant_id: str
    expected_net: Decimal
    actual_credited: Decimal
    delta: Decimal


@dataclass
class ReconciliationResult:
    matched: int = 0
    discrepancies: list[Discrepancy] = field(default_factory=list)
    missing_in_bank: list[str] = field(default_factory=list)
    missing_in_settlement: list[str] = field(default_factory=list)


def load_settlement(path: Path) -> dict[str, SettlementRecord]:
    records: dict[str, SettlementRecord] = {}
    with path.open(newline='') as f:
        for row in csv.DictReader(f):
            records[row['merchant_id']] = SettlementRecord(
                merchant_id=row['merchant_id'],
                gross=Decimal(row['gross']),
                fee=Decimal(row['fee']),
                net=Decimal(row['net']),
                tx_count=int(row['tx_count']),
            )
    return records


def load_bank_statement(path: Path) -> dict[str, BankRecord]:
    records: dict[str, BankRecord] = {}
    with path.open(newline='') as f:
        for row in csv.DictReader(f):
            records[row['merchant_id']] = BankRecord(
                merchant_id=row['merchant_id'],
                credited_amount=Decimal(row['credited_amount']),
                value_date=row['value_date'],
            )
    return records


def reconcile(
    settlement: dict[str, SettlementRecord],
    bank: dict[str, BankRecord],
    tolerance: Decimal = Decimal('0.01'),
) -> ReconciliationResult:
    result = ReconciliationResult()

    for merchant_id, settle_rec in settlement.items():
        if merchant_id not in bank:
            result.missing_in_bank.append(merchant_id)
            continue

        delta = abs(settle_rec.net - bank[merchant_id].credited_amount)
        if delta <= tolerance:
            result.matched += 1
        else:
            result.discrepancies.append(Discrepancy(
                merchant_id=merchant_id,
                expected_net=settle_rec.net,
                actual_credited=bank[merchant_id].credited_amount,
                delta=delta,
            ))

    for merchant_id in bank:
        if merchant_id not in settlement:
            result.missing_in_settlement.append(merchant_id)

    return result


def write_report(result: ReconciliationResult, out: Path) -> None:
    with out.open('w') as f:
        f.write(f'Matched:           {result.matched}\n')
        f.write(f'Discrepancies:     {len(result.discrepancies)}\n')
        f.write(f'Missing in bank:   {len(result.missing_in_bank)}\n')
        f.write(f'Missing in settle: {len(result.missing_in_settlement)}\n\n')
        if result.discrepancies:
            f.write('DISCREPANCIES:\n')
            for d in result.discrepancies:
                f.write(f'  {d.merchant_id}: expected {d.expected_net}, got {d.actual_credited}, delta {d.delta}\n')


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(f'Usage: {argv[0]} <settlement.csv> <bank_statement.csv> [report.txt]')
        return 1

    settle_path = Path(argv[1])
    bank_path = Path(argv[2])
    report_path = Path(argv[3]) if len(argv) > 3 else Path('reconciliation_report.txt')

    settlement = load_settlement(settle_path)
    bank = load_bank_statement(bank_path)
    result = reconcile(settlement, bank)
    write_report(result, report_path)

    print(f'Reconciliation complete. Report: {report_path}')
    return 0 if not result.discrepancies else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
