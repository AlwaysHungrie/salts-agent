"""One opened workbook: every cell's value and formula, labels for the numbers, recalculation.

Values come from the values Excel cached in the file. A workbook saved without them (written by a script, say)
is recalculated once with the `formulas` package, which also answers what-if questions.
"""

import datetime as dt
import logging
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

import openpyxl
from openpyxl.utils import column_index_from_string, get_column_letter, range_boundaries

from .errors import ToolFailure

log = logging.getLogger("analyst_mcp")

REF = re.compile(r"^(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)$")


@dataclass
class Cell:
    sheet: str
    coord: str
    row: int
    col: int
    value: object
    formula: str | None


@dataclass
class Fact:
    """A number (or formula result) with the words around it that say what it is."""

    cell: Cell
    label: str
    header: str
    unit: str


@dataclass
class Workbook:
    id: str
    name: str
    path: Path
    sheets: list[str]
    cells: dict[tuple[str, str], Cell]
    recalculated: bool = False
    has_drawings: bool = False
    _model: object = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # ------------------------------------------------------------------ lookup

    def sheet(self, name: str) -> str:
        """The sheet's real name, matched without regard to case."""
        for s in self.sheets:
            if s.lower() == name.strip().lower():
                return s
        raise ToolFailure("sheet_not_found", f"no sheet {name!r}; sheets are: {', '.join(self.sheets)}")

    def parse_ref(self, ref: str, default_sheet: str | None = None) -> tuple[str, str]:
        m = REF.match(ref.strip())
        if not m:
            raise ToolFailure("bad_reference", f"{ref!r} is not a cell reference like Sheet!C4 or 'Sheet name'!C4")
        name = (m.group(1) or "").replace("''", "'") or m.group(2) or default_sheet
        if not name:
            raise ToolFailure("bad_reference", f"{ref!r} needs a sheet name, like Feasibility!C4")
        return self.sheet(name), f"{m.group(3).upper()}{m.group(4)}"

    def value(self, sheet: str, coord: str) -> object:
        cell = self.cells.get((sheet, coord))
        return None if cell is None else cell.value

    def cell(self, sheet: str, coord: str) -> Cell | None:
        return self.cells.get((sheet, coord))

    def sheet_cells(self, sheet: str) -> list[Cell]:
        return sorted((c for (s, _), c in self.cells.items() if s == sheet), key=lambda c: (c.row, c.col))

    # ------------------------------------------------------------------ labels

    def fact(self, cell: Cell) -> Fact:
        return Fact(cell=cell, label=self._row_label(cell), header=self._col_header(cell), unit=self._unit(cell))

    def _text(self, sheet: str, row: int, col: int) -> str | None:
        c = self.cells.get((sheet, f"{get_column_letter(col)}{row}"))
        if c is not None and isinstance(c.value, str) and c.value.strip():
            return " ".join(c.value.split())
        return None

    def _row_label(self, cell: Cell) -> str:
        fallback = ""
        for col in range(cell.col - 1, 0, -1):
            text = self._text(cell.sheet, cell.row, col)
            if text is None:
                continue
            # Dotted leaders and code letters ("...Q") that forms put after a label are noise.
            text = re.sub(r"\s*(?:…|\.{2,})\s*[A-Z]?\d*\s*$", "", text).strip()
            if len(text) > 2:
                return text
            fallback = fallback or text
        return fallback

    def _col_header(self, cell: Cell) -> str:
        """The text at the top of an unbroken run of cells above this one, if there is one."""
        for row in range(cell.row - 1, 0, -1):
            above = self.cells.get((cell.sheet, f"{get_column_letter(cell.col)}{row}"))
            if above is None or above.value is None:
                return ""
            if isinstance(above.value, str):
                return " ".join(above.value.split())
        return ""

    def _unit(self, cell: Cell) -> str:
        text = self._text(cell.sheet, cell.row, cell.col + 1)
        return text if text and len(text) <= 15 else ""

    # ------------------------------------------------------------------ what-if

    def _key(self, sheet: str, coord: str) -> str:
        return f"'[{self.path.name}]{sheet.upper()}'!{coord}"

    def model(self):
        """The compiled `formulas` model, built on first use (a few seconds to tens of seconds)."""
        with self._lock:
            if self._model is None:
                import formulas

                try:
                    self._model = formulas.ExcelModel().loads(str(self.path)).finish()
                except Exception as e:
                    log.error("formulas compile failed: %s", type(e).__name__)
                    message = f"could not build a calculation model: {type(e).__name__}"
                    raise ToolFailure("recalc_failed", message) from e
            return self._model

    def calculate(self, changes: dict[tuple[str, str], object], outputs: list[tuple[str, str]]) -> dict:
        model = self.model()
        try:
            solution = model.calculate(
                inputs={self._key(s, c): v for (s, c), v in changes.items()},
                outputs=[self._key(s, c) for s, c in outputs],
            )
        except Exception as e:
            raise ToolFailure("recalc_failed", f"recalculation failed: {type(e).__name__}: {str(e)[:200]}") from e
        result = {}
        for s, c in outputs:
            got = solution.get(self._key(s, c))
            if got is None:
                result[(s, c)] = changes.get((s, c), self.value(s, c))
            else:
                result[(s, c)] = _plain(got)
        return result

    def recalculate_all(self) -> None:
        """Fill in formula results the file did not carry."""
        solution = self.model().calculate()
        upper = {s.upper(): s for s in self.sheets}
        prefix = re.compile(r"^'\[[^\]]+\]([^']+)'!([A-Z]+\d+)$")
        for key, got in solution.items():
            m = prefix.match(key)
            if not m or m.group(1) not in upper:
                continue
            cell = self.cells.get((upper[m.group(1)], m.group(2)))
            if cell is not None and cell.formula is not None:
                cell.value = _plain(got)
        self.recalculated = True


def _plain(got) -> object:
    value = getattr(got, "value", got)
    try:
        value = value[0][0]
    except (TypeError, IndexError, KeyError):
        pass
    if hasattr(value, "item"):
        value = value.item()
    text = str(value)
    if text.startswith("#"):
        return text
    if value == "" or (isinstance(value, str) and text.lower() == "empty"):
        return None
    return value


def load(wid: str, name: str, path: Path) -> Workbook:
    try:
        wf = openpyxl.load_workbook(path)
        wv = openpyxl.load_workbook(path, data_only=True)
    except Exception as e:
        raise ToolFailure("unreadable_workbook", f"could not read the workbook: {type(e).__name__}") from e
    cells: dict[tuple[str, str], Cell] = {}
    missing = False
    drawings = False
    for ws in wf.worksheets:
        vs = wv[ws.title]
        drawings = drawings or bool(getattr(ws, "_charts", None) or getattr(ws, "_images", None))
        for row in ws.iter_rows():
            for c in row:
                if c.value is None:
                    continue
                formula = c.value if isinstance(c.value, str) and c.value.startswith("=") else None
                if formula is None and hasattr(c.value, "text"):  # ArrayFormula
                    formula = str(c.value.text)
                value = vs[c.coordinate].value if formula else c.value
                if formula and value is None:
                    missing = True
                if isinstance(value, dt.datetime | dt.date):
                    value = value.isoformat()
                cells[(ws.title, c.coordinate)] = Cell(ws.title, c.coordinate, c.row, c.column, value, formula)
    book = Workbook(id=wid, name=name, path=path, sheets=list(wf.sheetnames), cells=cells, has_drawings=drawings)
    if missing:
        log.info("workbook %s has formulas without cached values; recalculating", wid)
        book.recalculate_all()
    return book


# ---------------------------------------------------------------------- text helpers for tool output


def show(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e15:
            return f"{int(value):,}"
        return f"{value:,.4f}".rstrip("0").rstrip(".")
    if isinstance(value, int):
        return f"{value:,}"
    return " ".join(str(value).split())


def in_range(cell: Cell, bounds: tuple[int, int, int, int] | None) -> bool:
    if bounds is None:
        return True
    min_col, min_row, max_col, max_row = bounds
    return min_col <= cell.col <= max_col and min_row <= cell.row <= max_row


def bounds_of(range_text: str | None) -> tuple[int, int, int, int] | None:
    if not range_text:
        return None
    try:
        b = range_boundaries(range_text.replace("$", "").upper())
    except ValueError as e:
        raise ToolFailure("bad_range", f"{range_text!r} is not a range like A1:F40") from e
    min_col, min_row, max_col, max_row = b
    return (min_col or 1, min_row or 1, max_col or 10**6, max_row or 10**6)


def column_index(letters: str) -> int:
    return column_index_from_string(letters)
