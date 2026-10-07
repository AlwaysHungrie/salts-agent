"""Read-only SQL over a workbook with DuckDB.

Two kinds of table:
  cells             every non-empty cell: sheet, cell, row, col, value, number, formula, label, header, unit
  "<sheet name>"    a sheet read as a table when it has a header row (text across the top, data below)

The database is in memory and built from the workbook; external access (files, network) is switched off before any
query runs, and only reading statements are accepted.
"""

import re
import threading

import duckdb
import pandas as pd
from openpyxl.utils import get_column_letter

from .errors import ToolFailure
from .workbook import Workbook, show

READING = re.compile(r"^\s*(select|with|from|describe|show|summarize|pivot|unpivot|values|table)\b", re.IGNORECASE)

_conns: dict[str, tuple[duckdb.DuckDBPyConnection, list[str]]] = {}
_lock = threading.Lock()


def _cells_frame(wb: Workbook) -> pd.DataFrame:
    rows = []
    for cell in wb.cells.values():
        fact = wb.fact(cell)
        number = cell.value if isinstance(cell.value, int | float) and not isinstance(cell.value, bool) else None
        rows.append(
            {
                "sheet": cell.sheet,
                "cell": cell.coord,
                "row": cell.row,
                "col": get_column_letter(cell.col),
                "value": show(cell.value),
                "number": float(number) if number is not None else None,
                "formula": cell.formula,
                "label": fact.label if number is not None else None,
                "header": fact.header if number is not None else None,
                "unit": fact.unit if number is not None else None,
            }
        )
    frame = pd.DataFrame(rows, columns=["sheet", "cell", "row", "col", "value", "number", "formula", "label",
                                        "header", "unit"])  # fmt: skip
    return frame.astype({"number": "float64"})


def _sheet_frame(wb: Workbook, sheet: str) -> pd.DataFrame | None:
    """The sheet as a table, when one row of text heads at least two columns of data below it."""
    cells = wb.sheet_cells(sheet)
    if not cells:
        return None
    by_row: dict[int, dict[int, object]] = {}
    for c in cells:
        by_row.setdefault(c.row, {})[c.col] = c.value
    rows = sorted(by_row)
    for i, r in enumerate(rows[:10]):
        head = by_row[r]
        if len(head) >= 2 and all(isinstance(v, str) for v in head.values()) and i + 1 < len(rows):
            below = rows[i + 1 :]
            if len(below) < 2:
                return None
            cols = sorted(head)
            names, seen = [], set()
            for col in cols:
                name = re.sub(r"\s+", " ", str(head[col])).strip() or get_column_letter(col)
                base, n = name, 2
                while name.lower() in seen:
                    name = f"{base} {n}"
                    n += 1
                seen.add(name.lower())
                names.append(name)
            data = [[by_row[rr].get(col) for col in cols] for rr in below]
            frame = pd.DataFrame(data, columns=names)
            for name in names:
                converted = pd.to_numeric(frame[name], errors="coerce")
                if converted.notna().sum() >= max(1, int(frame[name].notna().sum() * 0.8)):
                    frame[name] = converted
                else:
                    frame[name] = frame[name].map(lambda v: None if v is None else show(v))
            return frame
    return None


def connection(wb: Workbook) -> tuple[duckdb.DuckDBPyConnection, list[str]]:
    with _lock:
        if wb.id in _conns:
            return _conns[wb.id]
        con = duckdb.connect(":memory:")
        tables = ["cells"]
        frame = _cells_frame(wb)
        con.register("cells_frame", frame)
        con.execute("CREATE TABLE cells AS SELECT * FROM cells_frame")
        con.unregister("cells_frame")
        for sheet in wb.sheets:
            sf = _sheet_frame(wb, sheet)
            if sf is None or sheet.lower() == "cells":
                continue
            con.register("sheet_frame", sf)
            con.execute(f'CREATE TABLE "{sheet.replace(chr(34), chr(34) * 2)}" AS SELECT * FROM sheet_frame')
            con.unregister("sheet_frame")
            tables.append(sheet)
        con.execute("SET enable_external_access = false")
        con.execute("SET lock_configuration = true")
        _conns[wb.id] = (con, tables)
        return con, tables


def forget(workbook_id: str) -> None:
    with _lock:
        entry = _conns.pop(workbook_id, None)
    if entry:
        entry[0].close()


def describe(wb: Workbook) -> str:
    con, tables = connection(wb)
    lines = []
    for t in tables:
        cols = con.cursor().execute(f'DESCRIBE "{t}"').fetchall()
        count = con.cursor().execute(f'SELECT count(*) FROM "{t}"').fetchone()[0]
        lines.append(f'- "{t}" ({count} rows): ' + ", ".join(f'"{c[0]}" {c[1]}' for c in cols))
    return "\n".join(lines)


def run(wb: Workbook, sql: str, limit: int) -> tuple[list[str], list[tuple], bool]:
    text = sql.strip().rstrip(";").strip()
    if not text or ";" in text:
        raise ToolFailure("bad_sql", "send exactly one statement")
    if not READING.match(text):
        raise ToolFailure("read_only", "only reading statements run here (SELECT, WITH, DESCRIBE, SUMMARIZE, …)")
    con, _ = connection(wb)
    cur = con.cursor()
    try:
        cur.execute(text)
    except duckdb.Error as e:
        raise ToolFailure("sql_error", str(e).split("\n")[0][:400]) from e
    columns = [d[0] for d in cur.description or []]
    rows = cur.fetchmany(limit + 1)
    return columns, rows[:limit], len(rows) > limit
