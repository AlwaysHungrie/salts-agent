"""A sheet spec: the tables, charts and checks of a sheet to add to a workbook.

The agent writes one spec. `build` lays it out (where every cell will sit in the exported sheet) and evaluates every
formula against the workbook, so preview images, the text summary, the checks and the exported xlsx all read the
same numbers.
"""

import re
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from . import expr
from .errors import ToolFailure
from .workbook import Workbook

Value = str | float | int | None

FORMATS = {
    "text": "General",
    "int": "#,##0",
    "num1": "#,##0.0",
    "num2": "#,##0.00",
    "pct": "0.0%",
    "pct2": "0.00%",
    # Indian grouping: 1,23,45,678
    "inr": '[>=10000000]"₹ "##\\,##\\,##\\,##0;[>=100000]"₹ "##\\,##\\,##0;"₹ "#,##0',
    "inr_cr": '"₹ "0.00" Cr"',
    "usd": '"$"#,##0',
    "usd2": '"$"#,##0.00',
}
CHART_ROWS = 18


class Chart(BaseModel):
    type: Literal["bar", "column", "pie", "line"] = Field(
        description="bar = horizontal bars (long labels), column = vertical bars, pie = shares of a whole, line = trend"
    )
    title: str | None = Field(None, description="Defaults to the section title")
    label_column: int = Field(1, ge=1, description="1-based table column holding the category labels")
    value_columns: list[int] = Field(description="1-based table columns to plot, e.g. [3]", min_length=1)
    rows: list[int] | None = Field(
        None,
        description="Consecutive 1-based data rows to plot, e.g. [1, 2, 3]; default every row before the first total",
    )


class Row(BaseModel):
    cells: list[Value]
    style: Literal["normal", "total", "highlight"] = "normal"


class Section(BaseModel):
    title: str = Field(description="Numbered as the user asked, e.g. '1. Plot Area'")
    columns: list[str] = Field(min_length=1, description="Column headers, e.g. ['Item', 'Sq. mt.', 'Sq. ft.']")
    rows: list[Row | list[Value]] = Field(
        min_length=1,
        description=(
            "Each row: a list of cells, or {cells, style} with style total/highlight. A cell is text, a number, or a "
            "formula starting with '=' (Feasibility!C4*10.764, SUM('C A Details'!C10:C28), [r1c2]+[r2c2], "
            "SUM_ABOVE())"
        ),
    )
    formats: list[str | None] | None = Field(
        None,
        description=(
            "Number format per column: int, num1, num2, pct, pct2, inr (Indian ₹ grouping), inr_cr, usd, usd2, text, "
            "or an Excel format string"
        ),
    )
    chart: Chart | None = None
    note: str | None = Field(None, description="One short line under the table")

    @field_validator("rows")
    @classmethod
    def _rows(cls, rows):
        return [r if isinstance(r, Row) else Row(cells=r) for r in rows]

    @model_validator(mode="after")
    def _shape(self):
        width = len(self.columns)
        for i, row in enumerate(self.rows, 1):
            if len(row.cells) > width:
                raise ValueError(f"section {self.title!r} row {i} has {len(row.cells)} cells for {width} columns")
            row.cells = row.cells + [None] * (width - len(row.cells))
        if self.formats is not None and len(self.formats) > width:
            raise ValueError(f"section {self.title!r} has more formats than columns")
        if self.chart:
            for c in [self.chart.label_column, *self.chart.value_columns]:
                if c > width:
                    raise ValueError(f"section {self.title!r} chart refers to column {c}, the table has {width}")
            rows = self.chart.rows
            if rows is not None:
                if not rows or rows != list(range(rows[0], rows[-1] + 1)) or rows[0] < 1 or rows[-1] > len(self.rows):
                    raise ValueError(
                        f"section {self.title!r} chart rows must be consecutive rows of the table (1-{len(self.rows)})"
                    )
            elif all(r.style == "total" for r in self.rows):
                raise ValueError(f"section {self.title!r} chart has no rows to plot")
        return self


class Check(BaseModel):
    label: str = Field(description="What must hold, in words, e.g. 'Investment groups add up to the model total'")
    left: str = Field(description="Formula, e.g. '=SUM([s4r1c2],[s4r2c2])' or '=Feasibility!C93'")
    right: str = Field(description="Formula the left side must equal")
    tolerance: float = Field(0.01, ge=0)


class SheetSpec(BaseModel):
    sheet_name: str = Field("Dashboard", description="Name of the new sheet (max 31 characters)")
    title: str
    subtitle: str | None = None
    sections: list[Section] = Field(min_length=1)
    checks: list[Check] = Field(default_factory=list)

    @field_validator("sheet_name")
    @classmethod
    def _sheet_name(cls, v):
        v = v.strip()
        if not v or len(v) > 31 or re.search(r"[\[\]:*?/\\]", v):
            raise ValueError("sheet_name must be 1-31 characters without [ ] : * ? / \\")
        return v


# ---------------------------------------------------------------------- layout + evaluation

FIRST_COL = 2  # tables start in column B
TITLE_ROW = 2


@dataclass
class SectionLayout:
    section: Section
    title_row: int
    header_row: int
    first_row: int  # first data row
    note_row: int | None
    chart_anchor: str | None
    values: list[list[object]] = field(default_factory=list)
    excel: list[list[object]] = field(default_factory=list)

    def address(self, r: int, c: int) -> str:
        return expr.address(FIRST_COL + c - 1, self.first_row + r - 1)

    @property
    def last_row(self) -> int:
        return self.first_row + len(self.section.rows) - 1


@dataclass
class CheckResult:
    check: Check
    left: object
    right: object
    ok: bool
    left_excel: str
    right_excel: str


@dataclass
class Built:
    spec: SheetSpec
    sections: list[SectionLayout]
    checks: list[CheckResult]
    last_row: int

    @property
    def all_ok(self) -> bool:
        return all(c.ok for c in self.checks)


def chart_rows(section: Section) -> list[int]:
    """The rows a chart plots: the ones it names, else every row before the first total row."""
    if section.chart and section.chart.rows:
        return section.chart.rows
    rows = []
    for i, row in enumerate(section.rows, 1):
        if row.style == "total":
            break
        rows.append(i)
    return rows or [i for i, r in enumerate(section.rows, 1) if r.style != "total"][:1]


def excel_format(fmt: str | None) -> str | None:
    if fmt is None:
        return None
    return FORMATS.get(fmt, fmt)


def build(spec: SheetSpec, wb: Workbook) -> Built:
    if spec.sheet_name.lower() in (s.lower() for s in wb.sheets):
        raise ToolFailure(
            "sheet_exists", f"the workbook already has a sheet named {spec.sheet_name!r}; pick another sheet_name"
        )
    layouts: list[SectionLayout] = []
    row = TITLE_ROW + (3 if spec.subtitle else 2)
    for section in spec.sections:
        header = row + 1
        first = header + 1
        end = first + len(section.rows) - 1
        note = end + 1 if section.note else None
        anchor = expr.address(FIRST_COL + len(section.columns) + 1, row) if section.chart else None
        layouts.append(SectionLayout(section, row, header, first, note, anchor))
        bottom = max(note or end, row + CHART_ROWS if section.chart else 0)
        row = bottom + 3

    state: dict[tuple[int, int, int], object] = {}
    visiting: set[tuple[int, int, int]] = set()
    parsed: dict[str, object] = {}

    def node(formula: str):
        if formula not in parsed:
            parsed[formula] = expr.parse(formula)
        return parsed[formula]

    def ref_values(text: str) -> list[list[object]]:
        sheet, _, rng = text.rpartition("!")
        sheet = sheet[1:-1].replace("''", "'") if sheet.startswith("'") else sheet
        real = wb.sheet(sheet)
        rng = rng.replace("$", "").upper()
        if ":" not in rng:
            return [[wb.value(real, rng)]]
        from openpyxl.utils import range_boundaries

        c1, r1, c2, r2 = range_boundaries(rng)
        return [[wb.value(real, expr.address(c, r)) for c in range(c1, c2 + 1)] for r in range(r1, r2 + 1)]

    def cell_value(s: int, r: int, c: int) -> object:
        if not (1 <= s <= len(layouts)):
            raise ToolFailure("bad_formula", f"[s{s}r{r}c{c}]: there is no section {s}")
        sec = layouts[s - 1].section
        if not (1 <= r <= len(sec.rows) and 1 <= c <= len(sec.columns)):
            raise ToolFailure(
                "bad_formula",
                f"[s{s}r{r}c{c}]: section {s} ({sec.title!r}) has {len(sec.rows)} rows and {len(sec.columns)} columns",
            )
        key = (s, r, c)
        if key in state:
            return state[key]
        if key in visiting:
            raise ToolFailure("circular_reference", f"cell [s{s}r{r}c{c}] depends on itself")
        visiting.add(key)
        raw = sec.rows[r - 1].cells[c - 1]
        if isinstance(raw, str) and raw.startswith("="):
            env = expr.Env(
                ref=ref_values,
                sec=lambda ss, rr, cc: cell_value(ss or s, rr, cc),
                sum_above=lambda: _sum_above(s, r, c),
            )
            value = expr.evaluate(node(raw), env)
            if isinstance(value, list):
                value = expr.XlError("#VALUE!")
        else:
            value = raw
        visiting.discard(key)
        state[key] = value
        return value

    def above_rows(s: int, r: int) -> list[int]:
        sec = layouts[s - 1].section
        return [i for i in range(1, r) if sec.rows[i - 1].style != "total"]

    def _sum_above(s: int, r: int, c: int) -> object:
        total = 0.0
        for i in above_rows(s, r):
            v = cell_value(s, i, c)
            if isinstance(v, expr.XlError):
                return v
            if isinstance(v, int | float) and not isinstance(v, bool):
                total += v
        return total

    def sheet_name(name: str) -> str:
        return wb.sheet(name)

    for si, lay in enumerate(layouts, 1):
        for ri, row_spec in enumerate(lay.section.rows, 1):
            values, excel = [], []
            for ci, raw in enumerate(row_spec.cells, 1):
                values.append(cell_value(si, ri, ci))
                if isinstance(raw, str) and raw.startswith("="):

                    def sum_text(si=si, ri=ri, ci=ci) -> str:
                        rows = above_rows(si, ri)
                        if not rows:
                            return "0"
                        addrs = [layouts[si - 1].address(i, ci) for i in rows]
                        if rows == list(range(rows[0], rows[-1] + 1)):
                            return f"SUM({addrs[0]}:{addrs[-1]})"
                        return f"SUM({','.join(addrs)})"

                    excel.append(
                        expr.to_excel(
                            raw,
                            lambda s, r, c, si=si: _sec_address(layouts, s or si, r, c),
                            sum_text,
                            sheet_name,
                        )
                    )
                else:
                    excel.append(raw)
            lay.values.append(values)
            lay.excel.append(excel)

    results = []
    for check in spec.checks:

        def no_sum_above() -> object:
            raise ToolFailure("bad_formula", "SUM_ABOVE() only works inside a table, not in a check")

        def check_sec(s, r, c):
            if s is None:
                raise ToolFailure("bad_formula", f"in checks, name the section: [s1r{r}c{c}] instead of [r{r}c{c}]")
            return cell_value(s, r, c)

        env = expr.Env(ref=ref_values, sec=check_sec, sum_above=no_sum_above)
        left = expr.evaluate(node(check.left), env)
        right = expr.evaluate(node(check.right), env)
        ok = _close(left, right, check.tolerance)

        def check_address(s, r, c):
            if s is None:
                raise ToolFailure("bad_formula", f"in checks, name the section: [s1r{r}c{c}]")
            return f"{expr.quote_sheet(spec.sheet_name)}!{_sec_address(layouts, s, r, c)}"

        results.append(
            CheckResult(
                check,
                left,
                right,
                ok,
                expr.to_excel(check.left, check_address, lambda: "0", sheet_name),
                expr.to_excel(check.right, check_address, lambda: "0", sheet_name),
            )
        )
    last = max((max(lay.note_row or lay.last_row, lay.title_row + (CHART_ROWS if lay.section.chart else 0))
                for lay in layouts), default=TITLE_ROW)  # fmt: skip
    return Built(spec, layouts, results, last)


def _sec_address(layouts: list[SectionLayout], s: int, r: int, c: int) -> str:
    if not (1 <= s <= len(layouts)):
        raise ToolFailure("bad_formula", f"there is no section {s}")
    return layouts[s - 1].address(r, c)


def _close(a: object, b: object, tol: float) -> bool:
    if isinstance(a, expr.XlError) or isinstance(b, expr.XlError):
        return False
    if isinstance(a, int | float) and isinstance(b, int | float):
        return abs(float(a) - float(b)) <= tol
    return str(a if a is not None else "").strip().lower() == str(b if b is not None else "").strip().lower()
