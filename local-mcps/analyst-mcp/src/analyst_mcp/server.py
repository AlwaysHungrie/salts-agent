import asyncio
import base64
import functools
import json
import logging
import sys
import threading
import traceback
from pathlib import Path
from typing import Annotated, Any, Literal

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp_types import (
    BlobResourceContents,
    CallToolResult,
    EmbeddedResource,
    ImageContent,
    TextContent,
    ToolAnnotations,
)
from pydantic import Field, ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import export, pyrun, render, store
from . import sql as sqldb
from .auth import BearerAuthMiddleware
from .config import get_settings
from .errors import ToolFailure
from .fmt import display
from .spec import Built, Chart, Row, Section, SectionLayout, SheetSpec, build
from .workbook import Workbook, bounds_of, in_range, load, show

log = logging.getLogger("analyst_mcp")

XLSX = store.XLSX_MIME
CSV = "text/csv"

INSTRUCTIONS = """\
Spreadsheet analyst running on the user's own computer. It opens Excel/CSV files, answers questions about them,
runs what-if scenarios, and builds new sheets (tables + charts) into a copy of the workbook.

How to work:
1. Open the file: open_workbook with the attachment's upload_id (or inbox_file for a file in the inbox folder).
   It returns a map of every number with the words around it (label, column header, unit) and its cell.
2. Find numbers with the map, find, read_sheet or query. Never guess a cell address; look it up.
3. Answer plain questions directly from the values. Use what_if for "what if X changes" questions.
4. For a new sheet, dashboard or report: write a spec with one section per thing the user asked for, numbered in
   their order. Every number in it must be a formula over workbook cells (=Feasibility!C4*10.764), never a typed
   result. Add checks that tie your totals back to the workbook's own totals. Call preview_sheet: its images are
   shown to the user. Ask if they want changes; edit the spec and preview again.
5. Only when the user is happy, export_sheet. It returns the .xlsx to the user. The original file is never changed.
Keep replies short and in plain words; the user does not need cell addresses unless they ask.
"""

mcp = MCPServer(name="analyst-mcp", instructions=INSTRUCTIONS, version="0.1.0")

_books: dict[str, tuple[float, Workbook]] = {}
_books_lock = threading.Lock()


def workbook(workbook_id: str) -> tuple[store.WorkbookFiles, Workbook]:
    files = store.get_files(get_settings(), workbook_id)
    mtime = files.original.stat().st_mtime
    with _books_lock:
        cached = _books.get(workbook_id)
        if cached and cached[0] == mtime:
            return files, cached[1]
    book = load(files.id, files.name, files.original)
    with _books_lock:
        _books[workbook_id] = (mtime, book)
    return files, book


def _error(code: str, message: str) -> CallToolResult:
    body = {"error": {"code": code, "message": message}}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))], is_error=True)


def tool_handler(name: str):
    """Runs the tool in a worker thread (recalculation and drawing are CPU-bound) and turns failures into
    {code, message} errors, never tracebacks."""

    def decorate(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            try:
                return await asyncio.to_thread(functools.partial(fn, *args, **kwargs))
            except ToolFailure as e:
                log.info("tool %s failed: %s", name, e.code)
                return _error(e.code, e.message)
            except ValidationError as e:
                problems = "; ".join(
                    f"{'.'.join(str(p) for p in err['loc']) or 'spec'}: {err['msg']}" for err in e.errors()[:8]
                )
                return _error("invalid_spec", problems)
            except Exception as e:
                frames = "\n".join(
                    f"  {f.filename}:{f.lineno} in {f.name}" for f in traceback.extract_tb(e.__traceback__)
                )
                log.error("tool %s crashed: %s\n%s", name, type(e).__name__, frames)
                return _error("internal_error", f"unexpected server error ({type(e).__name__}); see server logs")

        return wrapper

    return decorate


def _result(text: str, images: list[bytes] = (), files: list[tuple[str, str, bytes]] = ()) -> CallToolResult:
    content: list = [TextContent(type="text", text=text)]
    for png in images:
        content.append(ImageContent(type="image", data=base64.b64encode(png).decode(), mime_type="image/png"))
    for name, mime, data in files:
        content.append(
            EmbeddedResource(
                type="resource",
                resource=BlobResourceContents(
                    uri=f"file:///{name.replace(' ', '%20')}", mime_type=mime, blob=base64.b64encode(data).decode()
                ),
            )
        )
    return CallToolResult(content=content)


def _table(head: list[str], rows: list[list[str]]) -> str:
    def clean(s: str) -> str:
        return str(s).replace("|", "\\|").replace("\n", " ")

    lines = ["| " + " | ".join(clean(h) for h in head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(clean(c) for c in row) + " |" for row in rows]
    return "\n".join(lines)


# ---------------------------------------------------------------------- tools

WorkbookId = Annotated[str, Field(description="The 12-character id open_workbook returned")]


@mcp.tool(
    description="List workbooks already opened on this server, and files waiting in the inbox folder.",
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("list_workbooks")
def list_workbooks() -> CallToolResult:
    settings = get_settings()
    books = store.list_workbooks(settings)
    inbox = store.list_inbox(settings)
    parts = [
        _table(["workbook_id", "name", "opened"], [[b["workbook_id"], b["name"], b["opened_at"] or ""] for b in books])
        if books
        else "No workbooks opened yet.",
        f"Inbox folder on this computer: {settings.inbox().resolve()}",
        ("Files in the inbox: " + ", ".join(inbox)) if inbox else "The inbox is empty.",
    ]
    return _result("\n\n".join(parts))


MAP_ROWS_PER_SHEET = 120
MAP_CHARS = 20000


def _map(book: Workbook) -> str:
    out = []
    for sheet in book.sheets:
        cells = book.sheet_cells(sheet)
        if not cells:
            out.append(f'## Sheet "{sheet}" (empty)')
            continue
        last = max(c.row for c in cells)
        width = max(c.col for c in cells)
        numbers = [c for c in cells if isinstance(c.value, int | float) and not isinstance(c.value, bool)]
        formulas = sum(1 for c in cells if c.formula)
        out.append(f'## Sheet "{sheet}": {last} rows x {width} columns, {len(numbers)} numbers, {formulas} formulas')
        facts = [book.fact(c) for c in numbers]
        # A column of a table (same header, many rows) is one line, not one line per cell.
        runs: dict[tuple[int, str], list] = {}
        for f in facts:
            if f.header:
                runs.setdefault((f.cell.col, f.header), []).append(f)
        columns = {k: v for k, v in runs.items() if len(v) >= 5}
        in_column = {id(f) for v in columns.values() for f in v}
        rows = [
            [f.cell.coord, f.label, f.header, show(f.cell.value), f.unit, f.cell.formula or ""]
            for f in facts
            if id(f) not in in_column
        ]
        shown = rows[:MAP_ROWS_PER_SHEET]
        if shown:
            out.append(_table(["Cell", "Label", "Column", "Value", "Unit", "Formula"], shown))
        if len(rows) > MAP_ROWS_PER_SHEET:
            out.append(f"…{len(rows) - MAP_ROWS_PER_SHEET} more numbers on this sheet: use read_sheet or query.")
        if columns:
            lines = []
            for (_, header), run in columns.items():
                total_cell = None
                if (run[-1].cell.formula or "").upper().startswith("=SUM("):
                    total_cell, run = run[-1].cell, run[:-1]
                values = [f.cell.value for f in run]
                first, last = run[0].cell, run[-1].cell
                formula = next((f.cell.formula for f in run if f.cell.formula), "")
                lines.append(
                    f"- Column \"{header}\" {first.coord}:{last.coord}: {len(run)} numbers "
                    f"from {show(min(values))} to {show(max(values))}"
                    + (f", formulas like {formula}" if formula else "")
                    + (
                        f"; total row {total_cell.coord} = {show(total_cell.value)} [{total_cell.formula}]"
                        if total_cell
                        else f"; they add up to {show(float(sum(values)))}"
                    )
                )
            out.append("Table columns:\n" + "\n".join(lines))
    text = "\n\n".join(out)
    if len(text) > MAP_CHARS:
        text = text[:MAP_CHARS] + "\n\n[map truncated: use read_sheet, find or query for the rest]"
    return text


@mcp.tool(
    description=(
        "Open an Excel (.xlsx/.xlsm) or CSV file and get a map of every number in it: its cell, the label in its row, "
        "its column header, its unit, its formula. Pass the attachment's upload_id from the conversation, or the name "
        "of a file in the inbox folder (list_workbooks shows them). Opening the same file again is free and returns "
        "the same workbook_id. The original file is never changed."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("open_workbook")
def open_workbook(
    upload_id: Annotated[
        str | None, Field(description="ID of a spreadsheet the agent app uploaded (given in the conversation)")
    ] = None,
    inbox_file: Annotated[
        str | None, Field(description="File name in the inbox folder, e.g. 'Sales 2025.xlsx'")
    ] = None,
    name: Annotated[str | None, Field(description="The file's name as the user knows it, for display")] = None,
) -> CallToolResult:
    files = store.open_files(get_settings(), upload_id=upload_id, inbox_file=inbox_file, name=name)
    _, book = workbook(files.id)
    head = [f'Opened "{files.name}" as workbook_id={files.id}. Sheets: ' + ", ".join(f'"{s}"' for s in book.sheets)]
    if book.recalculated:
        head.append("The file carried no saved results, so every formula was recalculated here.")
    if book.has_drawings:
        head.append("Note: this workbook has charts or images; exported copies do not keep them.")
    tables = sqldb.describe(book)
    return _result("\n".join(head) + "\n\n" + _map(book) + "\n\n## SQL tables (for query)\n" + tables)


@mcp.tool(
    description=(
        "Read a sheet (or a range like A1:F40) cell by cell: values, and formulas where there are any. "
        "Use it to see how a part of the workbook is laid out."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("read_sheet")
def read_sheet(
    workbook_id: WorkbookId,
    sheet: Annotated[str, Field(description="Sheet name")],
    cell_range: Annotated[str | None, Field(description="Optional range, e.g. A1:F40")] = None,
    start_row: Annotated[int, Field(ge=1, description="First row to show, for paging")] = 1,
) -> CallToolResult:
    _, book = workbook(workbook_id)
    real = book.sheet(sheet)
    bounds = bounds_of(cell_range)
    limit = get_settings().max_rows
    rows: dict[int, list[str]] = {}
    for c in book.sheet_cells(real):
        if c.row < start_row or not in_range(c, bounds):
            continue
        if c.row not in rows and len(rows) >= limit:
            break
        text = show(c.value)
        if c.formula:
            text = f"{text} [{c.formula}]"
        rows.setdefault(c.row, []).append(f"{c.coord}: {text}")
    if not rows:
        return _result(f'Nothing in "{real}" {cell_range or ""} from row {start_row}.')
    lines = [" | ".join(cells) for cells in rows.values()]
    last = max(rows)
    more = any(c.row > last and in_range(c, bounds) for c in book.sheet_cells(real))
    tail = f"\n\n[more rows: call again with start_row={last + 1}]" if more else ""
    return _result(f'Sheet "{real}"' + (f" {cell_range}" if cell_range else "") + ":\n" + "\n".join(lines) + tail)


@mcp.tool(
    description=(
        "Find cells whose text contains some words (case-insensitive), with the numbers on the same row. "
        "E.g. find 'net profit' or 'sale rate'."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("find")
def find(
    workbook_id: WorkbookId,
    text: Annotated[str, Field(description="Words to look for")],
) -> CallToolResult:
    _, book = workbook(workbook_id)
    needle = " ".join(text.lower().split())
    if not needle:
        raise ToolFailure("bad_request", "text is empty")
    hits = []
    for c in sorted(book.cells.values(), key=lambda c: (book.sheets.index(c.sheet), c.row, c.col)):
        if isinstance(c.value, str) and needle in " ".join(c.value.lower().split()):
            same_row = [
                o for o in book.sheet_cells(c.sheet)
                if o.row == c.row and o.col > c.col and isinstance(o.value, int | float)
            ]  # fmt: skip
            numbers = ", ".join(
                f"{o.coord} = {show(o.value)}" + (f" [{o.formula}]" if o.formula else "") for o in same_row[:6]
            )
            hits.append(f'- {c.sheet}!{c.coord} "{show(c.value)}"' + (f" → {numbers}" if numbers else ""))
        if len(hits) >= 40:
            hits.append("[more matches: narrow the words]")
            break
    return _result("\n".join(hits) if hits else f"No cell contains {text!r}.")


ChartType = Literal["bar", "column", "pie", "line"]


@mcp.tool(
    description=(
        "Run one read-only SQL query (DuckDB) over the workbook. Table `cells` has every cell (sheet, cell, row, col, "
        "value, number, formula, label, header, unit); a sheet with a header row is also a table named after the sheet "
        "(quote it: SELECT * FROM \"Sales 2025\"). open_workbook lists the tables. Optionally draw the result as a "
        "chart (shown to the user) or return it as a file."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("query")
def query(
    workbook_id: WorkbookId,
    sql: Annotated[str, Field(description="One SELECT/WITH/DESCRIBE/SUMMARIZE statement")],
    chart: Annotated[ChartType | None, Field(description="Draw the result: bar, column, pie or line")] = None,
    chart_title: Annotated[str | None, Field(description="Title for the chart")] = None,
    label_column: Annotated[int, Field(ge=1, description="1-based result column with the chart labels")] = 1,
    value_columns: Annotated[
        list[int] | None, Field(description="1-based result columns to plot; default the second")
    ] = None,
    file_format: Annotated[
        Literal["xlsx", "csv"] | None, Field(description="Also return the full result as a file for the user")
    ] = None,
) -> CallToolResult:
    files, book = workbook(workbook_id)
    limit = get_settings().max_rows
    columns, rows, more = sqldb.run(book, sql, limit if not file_format else 100_000)
    shown = rows[:limit]
    text = _table(columns, [[show(v) for v in r] for r in shown]) if columns else "Done."
    if len(rows) > limit or more:
        text += f"\n\n[showing the first {limit} rows]"
    images, outputs = [], []
    if chart and columns:
        values = value_columns or [2]
        if any(v > len(columns) for v in [label_column, *values]):
            raise ToolFailure("bad_chart", f"the result has {len(columns)} columns")
        section = Section(
            title=chart_title or "Query result",
            columns=[str(c) for c in columns],
            rows=[Row(cells=[_cell(v) for v in r]) for r in shown[:60]],
            chart=Chart(type=chart, title=chart_title, label_column=label_column, value_columns=values),
        )
        lay = SectionLayout(section, 0, 0, 0, None, None, values=[list(r.cells) for r in section.rows])
        png = render.section_png(lay)
        images.append(png)
        store.export_path(files, chart_title or "query chart", ".png").write_bytes(png)
    if file_format:
        import pandas as pd

        frame = pd.DataFrame([list(r) for r in rows], columns=columns)
        path = store.export_path(files, "query result", f".{file_format}")
        if file_format == "csv":
            frame.to_csv(path, index=False)
        else:
            frame.to_excel(path, index=False)
        outputs.append((path.name, CSV if file_format == "csv" else XLSX, path.read_bytes()))
        text += f"\n\nSaved {len(rows)} rows to {path} and sent the file to the user."
    return _result(text, images, outputs)


def _cell(v: object) -> object:
    if isinstance(v, int | float | str) or v is None:
        return v
    return show(v)


@mcp.tool(
    description=(
        "What-if: change some input cells and see how chosen output cells move, recalculating the whole workbook "
        "(the file is not changed). E.g. changes {'Feasibility!C29': 38000}, outputs ['Feasibility!C95']. "
        "The first call on a workbook can take up to a minute while its formulas are compiled."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("what_if")
def what_if(
    workbook_id: WorkbookId,
    changes: Annotated[dict[str, float], Field(description="Cell → new number, e.g. {'Feasibility!C29': 38000}")],
    outputs: Annotated[list[str], Field(min_length=1, description="Cells to report, e.g. ['Feasibility!C95']")],
) -> CallToolResult:
    _, book = workbook(workbook_id)
    if not changes:
        raise ToolFailure("bad_request", "changes is empty")
    parsed_changes = {book.parse_ref(k): v for k, v in changes.items()}
    targets = [book.parse_ref(o) for o in outputs]
    after = book.calculate(parsed_changes, targets)
    rows = []
    for ref, new in parsed_changes.items():
        cell = book.cell(*ref)
        label = book.fact(cell).label if cell else ""
        rows.append([f"{ref[0]}!{ref[1]}", label, show(book.value(*ref)), show(new), "input"])
    for ref in targets:
        cell = book.cell(*ref)
        label = book.fact(cell).label if cell else ""
        before, new = book.value(*ref), after[ref]
        change = ""
        if isinstance(before, int | float) and isinstance(new, int | float):
            delta = new - before
            change = show(delta) + (f" ({delta / before:+.1%})" if before else "")
        rows.append([f"{ref[0]}!{ref[1]}", label, show(before), show(new), change])
    return _result(_table(["Cell", "Label", "Now", "What-if", "Change"], rows))


SPEC_DOC = """\
The sheet to build, as JSON:
{"sheet_name": "Dashboard", "title": "…", "subtitle": "optional line",
 "sections": [
   {"title": "1. Plot Area", "columns": ["Item", "Sq. mt.", "Sq. ft."],
    "rows": [["Plot area", "=Feasibility!C4", "=Feasibility!C4*10.764"],
             {"cells": ["Total", "=SUM_ABOVE()", "=SUM_ABOVE()"], "style": "total"}],
    "formats": [null, "num2", "int"],   # per column; a row can override: {"cells": [...], "format": "inr"}
    "chart": {"type": "column", "label_column": 1, "value_columns": [3]},
    "note": "optional one line under the table"}],
 "checks": [{"label": "Total matches the model", "left": "=[s1r2c2]", "right": "=Feasibility!C21", "tolerance": 0.01}]}
Cells: text, numbers, or formulas starting with '='. Formulas use Excel syntax with sheet-qualified references
(Feasibility!C4, 'C A Details'!F29, SUM('C A Details'!C10:C28)); [r2c3] is row 2 column 3 of the same table,
[s1r2c3] the same in section 1 (checks must use this form); SUM_ABOVE() sums the rows above (skipping total rows).
Functions: SUM AVERAGE MIN MAX COUNT COUNTA PRODUCT SUMPRODUCT ROUND ROUNDUP ROUNDDOWN ABS SQRT INT POWER MOD IF
IFERROR ISNUMBER ISBLANK AND OR NOT. Formats: int num1 num2 pct pct2 inr (₹ 1,23,456) inr_cr usd usd2 text, or an
Excel format string. A row's "format" (one for its numbers) or "formats" (per cell) overrides the column's, for
Item | Value | Unit tables that mix ₹, sq ft and %. Percent values are fractions (0.25 shows as 25.0%). Charts: bar
(horizontal, long labels), column, pie, line; they plot consecutive rows (default: the rows before the first total row).
Write the whole sheet in one spec. Every preview is shown to the user, so never preview to test a format or a formula:
read the text summary of a full preview, fix the spec, preview again only if something was wrong."""


def _built(workbook_id: str, spec: dict[str, Any]) -> tuple[store.WorkbookFiles, Built]:
    files, book = workbook(workbook_id)
    return files, build(SheetSpec.model_validate(spec), book)


def _summary(built: Built) -> str:
    parts = []
    for lay in built.sections:
        sec = lay.section
        rows = [[display(v, sec.cell_format(i, c)) for c, v in enumerate(r)] for i, r in enumerate(lay.values)]
        parts.append(f"### {sec.title}\n" + _table(sec.columns, rows))
        errors = [str(v) for r in lay.values for v in r if isinstance(v, str) and v.startswith("#")]
        if errors:
            parts.append(f"Errors in this section: {', '.join(sorted(set(errors)))}. Fix the formulas.")
    if built.checks:
        lines = [
            f"- {'OK' if c.ok else 'CHECK'}: {c.check.label} ({display(c.left, 'num2')} vs {display(c.right, 'num2')})"
            for c in built.checks
        ]
        parts.append("### Checks\n" + "\n".join(lines))
    return "\n\n".join(parts)


@mcp.tool(
    description=(
        "Preview a new sheet before building it: renders each section (table + chart) as an image the user sees, and "
        "returns the computed numbers and check results as text. Nothing is written to the workbook. Edit the spec "
        "and preview again until the user is happy, then call export_sheet with the same spec. " + SPEC_DOC
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("preview_sheet")
def preview_sheet(
    workbook_id: WorkbookId,
    spec: Annotated[dict[str, Any], Field(description="The sheet spec (see the tool description)")],
) -> CallToolResult:
    files, built = _built(workbook_id, spec)
    images = [render.section_png(lay) for lay in built.sections]
    if (checks := render.checks_png(built)) is not None:
        images.append(checks)
    for i, png in enumerate(images, 1):
        store.export_path(files, f"preview {i}", ".png").write_bytes(png)
    status = "All checks pass." if built.all_ok else "Some checks FAIL: fix the spec before exporting."
    text = (
        f"Preview of sheet {built.spec.sheet_name!r}: {len(built.sections)} sections, shown to the user as "
        f"{len(images)} images. {status if built.checks else 'No checks in the spec.'}\n\n" + _summary(built)
    )
    return _result(text, images)


@mcp.tool(
    description=(
        "Build the sheet into a copy of the workbook and send the .xlsx to the user. Call only after the user approved "
        "the preview. Every number in the new sheet is a live formula over the workbook's own cells; checks go on a "
        "Checks sheet. Takes the same spec as preview_sheet."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False),
)
@tool_handler("export_sheet")
def export_sheet(
    workbook_id: WorkbookId,
    spec: Annotated[dict[str, Any], Field(description="The approved sheet spec")],
    file_name: Annotated[str | None, Field(description="Name for the file, without extension")] = None,
) -> CallToolResult:
    files, built = _built(workbook_id, spec)
    if not built.all_ok:
        failing = ", ".join(c.check.label for c in built.checks if not c.ok)
        raise ToolFailure("checks_failed", f"these checks fail, so nothing was exported: {failing}")
    stem = file_name or f"{Path(files.name).stem} - {built.spec.sheet_name}"
    path = export.write(built, files.original, store.export_path(files, stem, ".xlsx"))
    mime = XLSX if path.suffix == ".xlsx" else "application/vnd.ms-excel.sheet.macroEnabled.12"
    text = (
        f"Built {path.name}: sheet {built.spec.sheet_name!r} added"
        + (f" with {len(built.checks)} checks on a Checks sheet" if built.checks else "")
        + f". The file was sent to the user and is also saved on this computer at {path}."
    )
    return _result(text, files=[(path.name, mime, path.read_bytes())])


def _register_python() -> None:
    @mcp.tool(
        description=(
            "Run Python on a copy of the workbook for analysis the other tools cannot do. The script starts with "
            "pandas imported, INPUT = 'input.xlsx' (the copy) and OUT = 'out'. print() what the user should know; "
            "save charts as PNG and tables as .xlsx/.csv into OUT to send them to the user. No network. "
            "Prefer query, what_if and preview_sheet when they can do the job."
        ),
        annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False),
    )
    @tool_handler("run_python")
    def run_python(
        workbook_id: WorkbookId,
        code: Annotated[str, Field(description="Python source")],
    ) -> CallToolResult:
        files, _ = workbook(workbook_id)
        res = pyrun.run(files, code, get_settings().python_timeout_seconds)
        status = "timed out" if res.exit_code is None else f"exit code {res.exit_code}"
        text = f"Python {status}.\n\n{res.output or '(no output)'}"
        if res.images or res.files:
            text += f"\n\nSent to the user: {', '.join(p.name for p in res.images + res.files)}"
        out_files = [(p.name, XLSX if p.suffix == ".xlsx" else CSV, p.read_bytes()) for p in res.files]
        return _result(text, [p.read_bytes() for p in res.images], out_files)


if get_settings().allow_python:
    _register_python()


# ---------------------------------------------------------------------- transports


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


@mcp.custom_route("/uploads", methods=["POST"])
async def upload(request: Request) -> JSONResponse:
    """Raw spreadsheet bytes in, upload_id out: the agent app sends a chat attachment here, then the model passes
    the id to open_workbook. Behind the same bearer auth as /mcp."""
    settings = get_settings()
    try:
        limit = settings.max_file_bytes
        if int(request.headers.get("content-length") or 0) > limit:
            raise ToolFailure("file_too_large", f"file exceeds {limit // (1024 * 1024)} MB")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > limit:
                raise ToolFailure("file_too_large", f"file exceeds {limit // (1024 * 1024)} MB")
        upload_id, kind = store.save_upload(settings, bytes(body))
    except ToolFailure as e:
        return JSONResponse({"error": {"code": e.code, "message": e.message}}, status_code=400)
    log.info("upload stored kind=%s size=%d", kind, len(body))
    return JSONResponse({"upload_id": upload_id, "size_bytes": len(body), "kind": kind})


def build_http_app():
    settings = get_settings()
    if not settings.mcp_auth_token:
        raise SystemExit("MCP_AUTH_TOKEN is required for the http transport")
    app = mcp.streamable_http_app(host=settings.mcp_host, max_request_body_size=2 * 1024 * 1024)
    return BearerAuthMiddleware(app, settings.mcp_auth_token)


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    settings = get_settings()
    settings.inbox().mkdir(parents=True, exist_ok=True)
    if settings.mcp_transport == "stdio":
        mcp.run("stdio")
    else:
        uvicorn.run(build_http_app(), host=settings.mcp_host, port=settings.mcp_port)


if __name__ == "__main__":
    main()
