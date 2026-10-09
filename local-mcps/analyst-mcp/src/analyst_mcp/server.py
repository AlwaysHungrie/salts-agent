import asyncio
import base64
import copy
import functools
import inspect
import json
import logging
import re
import sys
import threading
import traceback
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
from pydantic import Field, ValidationError, WithJsonSchema
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import authoring, export, pyrun, render, store
from . import breakdown as bd
from . import sql as sqldb
from .auth import BearerAuthMiddleware
from .config import get_settings
from .errors import ToolFailure
from .expr import quote_sheet
from .fmt import RUPEE, approx, display
from .spec import Built, Chart, Check, Row, Section, SectionLayout, SheetSpec, build, inline_schema, problems
from .workbook import Workbook, bounds_of, in_range, load, show

log = logging.getLogger("analyst_mcp")

XLSX = store.XLSX_MIME
CSV = "text/csv"

INSTRUCTIONS = """\
Spreadsheet analyst running on the user's own computer. It opens Excel/CSV files, answers questions about them,
runs what-if scenarios, builds new sheets (tables + charts) into a copy of the file, makes new Excel files, and
edits them. Whenever the user wants an Excel file, use these tools: they send a real .xlsx to the user.

Projects: each file the user works on is a project with a name they know ("Q3 Budget", "Diet plan"). Every tool takes
`project`, that name. Stay on the project this chat is about and pass its name on every call; when the user says to
switch to another project, use switch_to_project and from then on pass the new name. list_projects shows them all.
Several files in one chat (May, June and July data) are one project each, named after the file: open each with
open_file, then work across them by passing each name in turn (query each, combine the results in your answer).
If the chat has not named a project and there is more than one, ask the user which.

How to work:
1. Open the file: open_file with the attachment's upload_id (or inbox_file for a file in the inbox folder) and a
   project name (the file's name unless the user gave one). It returns a map of every number with the words around
   it (label, column header, unit) and its cell. Later calls pass the project name; there is no need to open it again.
2. Find numbers with the map, find, read_sheet or query. Never guess a cell address; look it up.
3. Answer plain questions directly from the values. Use what_if for "what if X changes" questions.
4. "Where does the money go", a cost split, any breakdown of a total: use breakdown on the total cell. It lists the
   items that add up to it exactly; you name a few heads and assign every item; it hands back the table rows.
5. For a new sheet, dashboard or report: write a spec with one section per thing the user asked for, numbered in
   their order. Every number in it must be a formula over the file's cells (=Feasibility!C4*10.764), never a typed
   result. A column holds one kind of quantity (do not put built-up area beside carpet area). Add a total row only
   when the rows are parts of one whole. Add checks that tie your totals back to the file's own totals. Build
   it with add_section, one call per section: each is shown to the user as an image. The server keeps the draft,
   so you never repeat earlier sections; add_section with `number` replaces one the user wants changed.
6. Only when the user is happy, export_sheet. It returns the .xlsx to the user. The project's file is not changed.
To make a new Excel file (a plan, a list, a table the user asked for): create_project with the rows. To change the
file (values, formulas, rows, sheets, bold, colours, number formats): edit_project. Both send the file to the user;
an edit becomes the project's new version, so the project name keeps meaning the latest file.
When the user asks for something the file does not have (a blank cell, no such figure), say so in your reply
and in the section ("Not given in the file"); never leave it out silently or make a number up.
Images reach the user only through add_section or query results; never write an image link yourself.
Keep replies short and in plain words; the user does not need cell addresses unless they ask.
"""

mcp = MCPServer(name="analyst-mcp", instructions=INSTRUCTIONS, version="0.1.0")

_books: dict[str, tuple[int, Workbook]] = {}
_books_lock = threading.Lock()


def workbook(project: str | store.Project) -> tuple[store.Project, Workbook]:
    """The project's current file, loaded once per version."""
    found = store.get(get_settings(), project) if isinstance(project, str) else project
    with _books_lock:
        cached = _books.get(found.key)
        if cached and cached[0] == found.version:
            return found, cached[1]
    book = load(found.id, found.name, found.file)
    with _books_lock:
        _books[found.key] = (found.version, book)
    sqldb.forget(found.key, keep=found.id)
    return found, book


def _error(code: str, message: str) -> CallToolResult:
    body = {"error": {"code": code, "message": message}}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))], is_error=True)


FAILED_ARGS_CHARS = 4000


def _log_failure(name: str, code: str, message: str, kwargs: dict[str, Any]) -> None:
    """A refused call, with what the model sent: a model that keeps repeating one mistake is only diagnosable from
    its arguments, which reach no other log."""
    sent = json.dumps(kwargs, default=str, ensure_ascii=False)
    if len(sent) > FAILED_ARGS_CHARS:
        sent = sent[:FAILED_ARGS_CHARS] + f"... [{len(sent) - FAILED_ARGS_CHARS} more chars]"
    log.info("tool %s failed: %s: %s\n  args: %s", name, code, message, sent)


def tool_handler(name: str):
    """Runs the tool in a worker thread (recalculation and drawing are CPU-bound) and turns failures into
    {code, message} errors, never tracebacks."""

    def decorate(fn):
        signature = inspect.signature(fn)

        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            sent = lambda: signature.bind_partial(*args, **kwargs).arguments  # noqa: E731
            try:
                return await asyncio.to_thread(functools.partial(fn, *args, **kwargs))
            except ToolFailure as e:
                _log_failure(name, e.code, e.message, sent())
                return _error(e.code, e.message)
            except ValidationError as e:
                problems = "; ".join(
                    f"{'.'.join(str(p) for p in err['loc']) or 'spec'}: {err['msg']}" for err in e.errors()[:8]
                )
                _log_failure(name, "invalid_spec", problems, sent())
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

ProjectName = Annotated[
    str, Field(description="The project's name, as this chat has been calling it (list_projects shows them)")
]


def _draft_titles(project: store.Project) -> str:
    draft = store.load_draft(project)
    return "; ".join(s.get("title", "") for s in draft["sections"]) if draft and draft.get("sections") else ""


@mcp.tool(
    description=(
        "List the projects on this computer (each is one Excel file under a name the user knows), newest first, and "
        "files waiting in the inbox folder. Use it when the user asks what projects there are, or which to pick."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("list_projects")
def list_projects() -> CallToolResult:
    settings = get_settings()
    projects = store.list_projects(settings)
    inbox = store.list_inbox(settings)
    rows = []
    for p in projects:
        meta = store.info(p)
        rows.append([p.name, (meta.get("updated_at") or "")[:16].replace("T", " "),
                     f"{p.version - 1} edits" if p.version > 1 else "as opened", _draft_titles(p)])  # fmt: skip
    parts = [
        _table(["Project", "Last changed (UTC)", "Changes", "Draft sheet sections"], rows)
        if projects
        else "No projects yet.",
        f"Inbox folder on this computer: {settings.inbox().resolve()}",
        ("Files in the inbox: " + ", ".join(inbox)) if inbox else "The inbox is empty.",
    ]
    return _result("\n\n".join(parts))


MAP_ROWS_PER_SHEET = 120
MAP_CHARS = 20000


def _with_approx(value: object, unit: str) -> str:
    words = approx(value, unit)
    return f"{show(value)} ({words})" if words else show(value)


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
            [f.cell.coord, f.label, f.header, _with_approx(f.cell.value, f.unit), f.unit, f.cell.formula or ""]
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


def _overview(project: store.Project, head: str) -> CallToolResult:
    """The project as the model needs it to work: its sheets, a map of every number, its SQL tables."""
    _, book = workbook(project)
    lines = [head + " Sheets: " + ", ".join(f'"{s}"' for s in book.sheets)]
    if book.recalculated:
        lines.append("The file carried no saved results, so every formula was recalculated here.")
    if book.has_drawings:
        lines.append("Note: this file has charts or images; exported copies do not keep them.")
    if titles := _draft_titles(project):
        lines.append(f"Its draft sheet has these sections: {titles}.")
    tables = sqldb.describe(book)
    guide = INSTRUCTIONS[INSTRUCTIONS.index("Projects:") :]
    return _result(
        "\n".join(lines) + "\n\n" + _map(book) + "\n\n## SQL tables (for query)\n" + tables + "\n\n" + guide
    )


@mcp.tool(
    description=(
        "Start a project from an Excel (.xlsx/.xlsm) or CSV file and get a map of every number in it: its cell, the "
        "label in its row, its column header, its unit, its formula. Pass the attachment's upload_id from the "
        "conversation, or the name of a file in the inbox folder (list_projects shows them), and a project name. "
        "Opening the same file again is free and returns the same project. The user's file is never changed."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("open_file")
def open_file(
    upload_id: Annotated[
        str | None, Field(description="ID of a spreadsheet the agent app uploaded (given in the conversation)")
    ] = None,
    inbox_file: Annotated[
        str | None, Field(description="File name in the inbox folder, e.g. 'Sales 2025.xlsx'")
    ] = None,
    project: Annotated[
        str | None,
        Field(description="Name for the project: the one the user gave, else the file's name, e.g. 'Q3 Budget'"),
    ] = None,
) -> CallToolResult:
    found, new = store.open_file(get_settings(), upload_id=upload_id, inbox_file=inbox_file, name=project)
    verb = "Started" if new else "Back on"
    return _overview(found, f'{verb} project "{found.name}". Pass project="{found.name}" to the other tools.')


@mcp.tool(
    description=(
        "Switch this chat to another project, when the user says to work on it (\"switch to the budget\", \"go back "
        "to the diet plan\"). Returns its map of numbers; pass its name to every tool from then on."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("switch_to_project")
def switch_to_project(project: ProjectName) -> CallToolResult:
    found = store.get(get_settings(), project, forgive=False)
    return _overview(found, f'Now on project "{found.name}". Pass project="{found.name}" to the other tools.')


@mcp.tool(
    description=(
        "Read a sheet (or a range like A1:F40) cell by cell: values, and formulas where there are any. "
        "Use it to see how a part of the file is laid out."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("read_sheet")
def read_sheet(
    project: ProjectName,
    sheet: Annotated[str, Field(description="Sheet name")],
    cell_range: Annotated[str | None, Field(description="Optional range, e.g. A1:F40")] = None,
    start_row: Annotated[int, Field(ge=1, description="First row to show, for paging")] = 1,
) -> CallToolResult:
    _, book = workbook(project)
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
    project: ProjectName,
    text: Annotated[str, Field(description="Words to look for")],
) -> CallToolResult:
    _, book = workbook(project)
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
        "Run one read-only SQL query (DuckDB) over the file. Table `cells` has every cell (sheet, cell, row, col, "
        "value, number, formula, label, header, unit); a sheet with a header row is also a table named after the sheet "
        "(quote it: SELECT * FROM \"Sales 2025\"). open_file and switch_to_project list the tables. Optionally draw "
        "the result as a chart (shown to the user) or return it as a file."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("query")
def query(
    project: ProjectName,
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
    files, book = workbook(project)
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
        "What-if: change some input cells and see how chosen output cells move, recalculating the whole file "
        "(the file is not changed). E.g. changes {'Feasibility!C29': 38000}, outputs ['Feasibility!C95']. "
        "The first call on a project can take up to a minute while its formulas are compiled."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("what_if")
def what_if(
    project: ProjectName,
    changes: Annotated[dict[str, float], Field(description="Cell → new number, e.g. {'Feasibility!C29': 38000}")],
    outputs: Annotated[list[str], Field(min_length=1, description="Cells to report, e.g. ['Feasibility!C95']")],
) -> CallToolResult:
    _, book = workbook(project)
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


@mcp.tool(
    description=(
        "What a total is made of: opens a total cell (e.g. total investment, total cost) into the items that add up "
        "to it exactly, each with its label and value. Use it for 'where does the money go', 'cost split', or any "
        "breakdown of a total; never pick the parts by reading the sheet yourself. "
        "Step 1: call with only `cell` to see the items. Step 2: call again with `groups`, a few heads the user will "
        "understand, each listing its item cells (every item in exactly one head). It checks the heads and returns "
        "the table rows and the check to paste into a sheet spec."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("breakdown")
def breakdown(
    project: ProjectName,
    cell: Annotated[str, Field(description="The total, e.g. Feasibility!C93")],
    groups: Annotated[
        dict[str, list[str]] | None,
        Field(description="Head → item cells or ranges, e.g. {'Construction': ['C33', 'C34'], 'Fees': ['C38:C39']}"),
    ] = None,
) -> CallToolResult:
    _, book = workbook(project)
    sheet, coord = book.parse_ref(cell)
    items, total = bd.components(book, sheet, coord)
    label = book.fact(book.cell(sheet, coord)).label or f"{sheet}!{coord}"
    unit = book.fact(book.cell(sheet, coord)).unit
    fmt = "inr" if RUPEE.search(unit or "") else "num2"
    ref = f"{quote_sheet(sheet)}!{coord}"
    if not groups:
        rows = [
            [it.coord if it.sheet == sheet else f"{it.sheet}!{it.coord}", it.label[:70],
             ("" if it.sign > 0 else "minus ") + _with_approx(it.value, unit or "")]
            for it in items
        ]  # fmt: skip
        return _result(
            f'{ref} "{label}" = {_with_approx(total, unit)} is the sum of these {len(items)} items:\n\n'
            + _table(["Cell", "Item", "Value"], rows)
            + "\n\nGroup them into a few heads (4 to 8) the reader will understand, and call breakdown again with "
            "`groups`. Every item goes in exactly one head."
        )
    heads = bd.assign(book, items, groups, sheet)
    n = len(heads)
    summary = [
        [name, _with_approx(sum(i.sign * i.value for i in its), unit), str(len(its))] for name, its in heads.items()
    ]
    section = {
        "title": f"N. {label}",
        "columns": ["Head", "Amount", "Share"],
        "formats": [None, fmt, "pct"],
        "rows": [[name, bd.formula(its), f"=[r{i}c2]/[r{n + 1}c2]"] for i, (name, its) in enumerate(heads.items(), 1)]
        + [{"cells": ["Total", "=SUM_ABOVE()", "=SUM_ABOVE()"], "style": "total"}],
        "chart": {"type": "pie", "label_column": 1, "value_columns": [2]},
    }
    check = {"label": f"Heads add up to {label}", "left": f"=[sNr{n + 1}c2]", "right": f"={ref}", "tolerance": 1}
    return _result(
        "The heads cover every item exactly once:\n\n"
        + _table(["Head", "Amount", "Items"], summary)
        + f"\n\nTotal {_with_approx(total, unit)}.\n\nThe section (number its title and rename it as the user asked):\n"
        + json.dumps(section, ensure_ascii=False)
        + "\n\nIts check:\n"
        + json.dumps(check, ensure_ascii=False)
        + "\n\nPass both to add_section as they are."
    )


SPEC_DOC = """\
A section, as JSON (the sheet and cell names here are placeholders; use the file's own):
{"title": "2. Revenue by region", "columns": ["Region", "Revenue", "Share"],
 "rows": [["North", "=SheetName!C4", "=[r1c2]/[r3c2]"], ["South", "=SheetName!C5", "=[r2c2]/[r3c2]"],
          {"cells": ["Total", "=SUM_ABOVE()", "=SUM_ABOVE()"], "style": "total"}],
 "formats": [null, "inr", "pct"],   # per column; a row can override: {"cells": [...], "format": "num1"}
 "chart": {"type": "pie", "label_column": 1, "value_columns": [2]},
 "note": "optional one line under the table"}
A check: {"label": "Total matches the model", "left": "=[r3c2]", "right": "=SheetName!C9", "tolerance": 1}.
Cells: text, numbers, or formulas starting with '='. Formulas use Excel syntax with sheet-qualified references
(Feasibility!C4, 'C A Details'!F29, SUM('C A Details'!C10:C28)); [r2c3] is row 2 column 3 of this table, [s1r2c3]
the same in section 1; SUM_ABOVE() sums the rows above (skipping total rows).
Functions: SUM AVERAGE MIN MAX COUNT COUNTA PRODUCT SUMPRODUCT ROUND ROUNDUP ROUNDDOWN ABS SQRT INT POWER MOD IF
IFERROR ISNUMBER ISBLANK AND OR NOT. Formats: int num1 num2 pct pct2 inr (rupees: ₹ 1,23,456) inr_cr (crores: a
rupee amount is divided by 10^7 for you, so =Feasibility!C30 shows ₹ 64.38 Cr) usd usd2 text, or an Excel format string.
A row's "format" (one for its numbers) or "formats" (per cell) overrides the column's, for Item | Value | Unit tables
that mix ₹, sq ft and %. Percent values are fractions (0.25 shows as 25.0%);
a whole-number percent above 10 (36.6) is divided by 100 for you. Charts: bar (horizontal, long labels),
column, pie, line; they plot consecutive rows (default: the rows before the first total row).
Every call is shown to the user, so never call it to test a format or a formula."""


def _built(project: str | store.Project, spec: dict[str, Any], only: int | None = None) -> tuple[store.Project, Built]:
    files, book = workbook(project)
    built = build(SheetSpec.model_validate(spec), book)
    if found := problems(built, only):
        found_text = " | ".join(found)
        raise ToolFailure("spec_problems", f"nothing was shown to the user; fix these and call again: {found_text}")
    return files, built


CELL_REF = re.compile(r"\[(?:s(\d+))?r(\d+)c(\d+)\]")
CRORE, HUNDRED = "10^7", "100"


def _fix_units(project: store.Project, spec: dict[str, Any], n: int) -> tuple[dict[str, Any], list[str]]:
    """Section n with its unit slips corrected instead of refused: rupees under inr_cr are divided by 10^7, a percent
    written as 36.6 under pct by 100. Every reference to a corrected cell is multiplied back, so the formulas and checks
    that use it keep their meaning. A SUM_ABOVE() total is left alone: it adds the corrected cells."""
    _, book = workbook(project)
    lay = build(SheetSpec.model_validate(spec), book).sections[n - 1]
    sec = lay.section
    scale: dict[tuple[int, int], str] = {}
    for ri, row in enumerate(lay.values):
        for ci, v in enumerate(row):
            raw = sec.rows[ri].cells[ci]
            if not isinstance(v, int | float) or isinstance(v, bool):
                continue
            if isinstance(raw, str) and "SUM_ABOVE" in raw.upper():
                continue
            fmt = sec.cell_format(ri, ci)
            if fmt == "inr_cr" and abs(v) >= 1e5:
                scale[(ri + 1, ci + 1)] = CRORE
            elif fmt in ("pct", "pct2") and 10 < abs(v) <= 100:
                scale[(ri + 1, ci + 1)] = HUNDRED
    if not scale:
        return spec, []

    def restore(formula: str, plain: bool) -> str:
        """`plain`: an unnumbered [r2c3] is section n's own, as inside the section."""

        def sub(m: re.Match) -> str:
            mine = int(m[1]) == n if m[1] else plain
            factor = scale.get((int(m[2]), int(m[3]))) if mine else None
            return f"({m[0]}*{factor})" if factor else m[0]

        return CELL_REF.sub(sub, formula)

    section = copy.deepcopy(spec["sections"][n - 1])
    for ri, row in enumerate(section["rows"]):
        cells = row["cells"] if isinstance(row, dict) else row
        for ci, cell in enumerate(cells):
            if isinstance(cell, str) and cell.startswith("="):
                cell = cells[ci] = restore(cell, True)
            factor = scale.get((ri + 1, ci + 1))
            if factor and isinstance(cell, str):
                cells[ci] = f"=({cell[1:]})/{factor}"
            elif factor and isinstance(cell, int | float):
                cells[ci] = cell / (1e7 if factor == CRORE else 100)
    checks = [{**c, "left": restore(c["left"], False), "right": restore(c["right"], False)} for c in spec["checks"]]
    sections = list(spec["sections"])
    sections[n - 1] = section
    notes = [
        f"row {r} column {c} "
        + ("was in rupees, so it is divided by 10^7 to show crores" if f == CRORE else "was a whole-number percent, "
           "so it is divided by 100")
        for (r, c), f in sorted(scale.items())
    ]  # fmt: skip
    return {**spec, "sections": sections, "checks": checks}, notes


def _numbered(formula: str, n: int) -> str:
    """Checks name this section's cells as [r2c3] (or [sNr2c3]); the draft needs [s2r2c3]."""
    formula = re.sub(r"\[sN(r\d+c\d+)\]", rf"[s{n}\1]", formula)
    return re.sub(r"\[(r\d+c\d+)\]", rf"[s{n}\1]", formula)


def _remove_section(files: store.Project, draft: dict, number: int | None) -> CallToolResult:
    sections = draft["sections"]
    if number is None or not 1 <= number <= len(sections):
        raise ToolFailure("bad_number", f"remove needs `number`, 1 to {len(sections)}")
    gone = sections.pop(number - 1)
    checks = []
    for c in draft["checks"]:
        if c.get("section") == number:
            continue
        # Later sections move up one; their own references follow them.
        def shift(f: str) -> str:
            return re.sub(r"\[s(\d+)(r\d+c\d+)\]", lambda m: f"[s{int(m[1]) - (int(m[1]) > number)}{m[2]}]", f)

        sec = c.get("section")
        checks.append({**c, "left": shift(c["left"]), "right": shift(c["right"]),
                       "section": sec - 1 if sec and sec > number else sec})  # fmt: skip
    store.save_draft(files, {**draft, "sections": sections, "checks": checks})
    left = " | ".join(s.get("title", "") for s in sections) or "none"
    return _result(f"Removed section {number} ({gone.get('title', '')!r}). Draft sections now: {left}.")


@mcp.tool(
    description=(
        "Build a new sheet (dashboard, report, summary) one section at a time. Adds the section to this project's "
        "draft sheet, or replaces section `number` when the user wants it changed, and shows that section to the user "
        "as an image (with its checks). The draft stays on this server: earlier sections never need repeating, and "
        "export_sheet builds the whole draft. For a whole sheet at once, call it once per section. remove=true with "
        "`number` takes a section out. " + SPEC_DOC
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False),
)
@tool_handler("add_section")
def add_section(
    project: ProjectName,
    section: Annotated[
        dict[str, Any] | None,
        # Validated as a dict (the draft keeps what was sent; a bad spec is logged), advertised with every field:
        # models that fill arguments from the schema send {} for an object whose fields it does not list.
        WithJsonSchema({"anyOf": [inline_schema(Section), {"type": "null"}]}),
        Field(description="The section: title, columns, rows, formats, chart, note; not with remove"),
    ] = None,
    number: Annotated[
        int | None, Field(ge=1, description="Replace this section (1-based); leave out to add at the end")
    ] = None,
    checks: Annotated[
        list[dict[str, Any]] | None,
        WithJsonSchema({"anyOf": [{"type": "array", "items": inline_schema(Check)}, {"type": "null"}]}),
        Field(description="Checks tying this section to the file's own totals"),
    ] = None,
    title: Annotated[str | None, Field(description="Title of the whole sheet")] = None,
    sheet_name: Annotated[str | None, Field(description="Name of the new sheet (default Dashboard)")] = None,
    remove: Annotated[bool, Field(description="Take section `number` out of the draft")] = False,
) -> CallToolResult:
    files = store.get(get_settings(), project)
    draft = store.load_draft(files)
    draft = draft or {"sheet_name": "Dashboard", "title": files.name, "sections": [], "checks": []}
    if remove:
        return _remove_section(files, draft, number)
    if section is None:
        raise ToolFailure("invalid_spec", "section is required unless remove=true")
    if title:
        draft["title"] = title
    if sheet_name:
        draft["sheet_name"] = sheet_name
    sections, kept = list(draft["sections"]), list(draft["checks"])
    if number is None or number == len(sections) + 1:
        sections.append(section)
        n = len(sections)
    elif number <= len(sections):
        n = number
        sections[n - 1] = section
        kept = [c for c in kept if c.get("section") != n]
    else:
        raise ToolFailure("bad_number", f"the draft has {len(sections)} sections; the next one is {len(sections) + 1}")
    for c in checks or []:
        if not isinstance(c, dict) or "left" not in c or "right" not in c:
            raise ToolFailure("invalid_spec", "each check needs label, left and right")
        kept.append({**c, "left": _numbered(c["left"], n), "right": _numbered(c["right"], n), "section": n})
    spec, fixed = _fix_units(files, {**draft, "sections": sections, "checks": kept}, n)
    _, built = _built(files, spec, only=n)
    store.save_draft(files, spec)

    lay = built.sections[n - 1]
    mine = [r for r, c in zip(built.checks, spec["checks"], strict=True) if c.get("section") == n]
    images = [render.section_png(lay)]
    if mine:
        images.append(render.checks_png(Built(built.spec, built.sections, mine, built.last_row)))
    store.export_path(files, f"section {n}", ".png").write_bytes(images[0])
    sec = lay.section
    rows = [[display(v, sec.cell_format(i, c)) for c, v in enumerate(r)] for i, r in enumerate(lay.values)]
    parts = [f"Section {n} is in the draft and was shown to the user as {len(images)} image(s).",
             f"### {sec.title}\n" + _table(sec.columns, rows)]  # fmt: skip
    if fixed:
        parts.append("Units corrected in this section: " + "; ".join(fixed) + ".")
    errors = sorted({str(v) for r in lay.values for v in r if isinstance(v, str) and v.startswith("#")})
    if errors:
        parts.append(f"Errors in this section: {', '.join(errors)}. Fix the formulas.")
    if mine:
        parts.append("Checks:\n" + "\n".join(
            f"- {'OK' if c.ok else 'CHECK'}: {c.check.label} ({display(c.left, 'num2')} vs {display(c.right, 'num2')})"
            for c in mine
        ))  # fmt: skip
    parts.append("Draft sections now: " + " | ".join(s.get("title", "") for s in sections) + ".")
    return _result("\n\n".join(parts), images)


@mcp.tool(
    description=(
        "Build the draft sheet (every section from add_section) into a copy of the project's file and send the .xlsx "
        "to the user. Call only after the user approved the sections. Every number in the new sheet is a live formula "
        "over the file's own cells; checks go on a Checks sheet."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False),
)
@tool_handler("export_sheet")
def export_sheet(
    project: ProjectName,
    file_name: Annotated[str | None, Field(description="Name for the file, without extension")] = None,
) -> CallToolResult:
    found = store.get(get_settings(), project)
    spec = store.load_draft(found)
    if not spec or not spec.get("sections"):
        raise ToolFailure("no_draft", "the draft has no sections yet: add them with add_section")
    files, built = _built(found, spec)
    if not built.all_ok:
        failing = ", ".join(c.check.label for c in built.checks if not c.ok)
        raise ToolFailure("checks_failed", f"these checks fail, so nothing was exported: {failing}")
    stem = file_name or f"{files.name} - {built.spec.sheet_name}"
    path = export.write(built, files.file, store.export_path(files, stem, ".xlsx"))
    mime = XLSX if path.suffix == ".xlsx" else "application/vnd.ms-excel.sheet.macroEnabled.12"
    contents = "\n".join(f"- {lay.section.title} ({len(lay.section.rows)} rows)" for lay in built.sections)
    text = (
        f"Built {path.name}: sheet {built.spec.sheet_name!r} added"
        + (f" with {len(built.checks)} checks on a Checks sheet" if built.checks else "")
        + f". The file was sent to the user and is also saved on this computer at {path}.\n\n"
        f"It contains exactly these sections; tell the user these, no others:\n{contents}"
    )
    return _result(text, files=[(path.name, mime, path.read_bytes())])


# ---------------------------------------------------------------------- writing files

CHANGED_SHOWN = 40


def _written(project: store.Project, verb: str, written: list[tuple[str, str]] = ()) -> CallToolResult:
    """Open what was written, so the reply says how it reads (formulas computed) and the next call can use it."""
    note = ""
    try:
        _, book = workbook(project)
        sheets = []
        for sheet in book.sheets:
            cells = book.sheet_cells(sheet)
            size = f"{max(c.row for c in cells)} rows x {max(c.col for c in cells)} columns" if cells else "empty"
            sheets.append(f'"{sheet}" ({size})')
        note = "Sheets: " + ", ".join(sheets) + "."
        if written:
            shown = [
                f"- {sheet}!{coord} = {show(book.cells[(sheet, coord)].value)}"
                + (f" [{book.cells[(sheet, coord)].formula}]" if book.cells[(sheet, coord)].formula else "")
                for sheet, coord in written[:CHANGED_SHOWN]
                if (sheet, coord) in book.cells
            ]
            if shown:
                note += "\n\nCells now read:\n" + "\n".join(shown)
    except ToolFailure as e:
        note = f"The file is saved, but its formulas could not be worked out here ({e.message}); Excel will."
    macros = store.has_macros(project.file)
    file_name = f"{project.name}.{'xlsm' if macros else 'xlsx'}"
    mime = "application/vnd.ms-excel.sheet.macroEnabled.12" if macros else XLSX
    text = (
        f'{verb} project "{project.name}". "{file_name}" was sent to the user and is also saved on this computer at '
        f"{project.file}.\n\n{note}"
    )
    return _result(text, files=[(file_name, mime, project.file.read_bytes())])


@mcp.tool(
    description=(
        "Make a new Excel file from rows, as a new project, and send the .xlsx to the user. Use it whenever the "
        "user asks for an Excel file or spreadsheet of something (a plan, a list, a schedule, a table). Each sheet is "
        "a list of rows, the first row its column headings (bold and frozen). Numbers stay numbers; a value starting "
        "with = is a formula (=SUM(B2:B8)). The other tools then take the project's name."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("create_project")
def create_project(
    name: Annotated[str, Field(description="Project and file name, e.g. 'Weekly diet plan'")],
    sheets: Annotated[
        list[authoring.NewSheet],
        WithJsonSchema({"type": "array", "minItems": 1, "items": inline_schema(authoring.NewSheet)}),
        Field(min_length=1, description="The sheets, in tab order"),
    ],
) -> CallToolResult:
    found, _ = store.start(get_settings(), name, authoring.create(sheets), "created")
    return _written(found, "Created")


@mcp.tool(
    description=(
        "Change the project's file and send the edited .xlsx to the user: write values or formulas into cells, add "
        "rows, add, rename (formulas follow) or delete sheets, and style ranges (bold, number format, fill colour, "
        "column width). Edits apply in order, all or none. The result is the project's new version (the one before is "
        "kept on this computer), so later questions and edits see the change. Look cells up first (read_sheet, find); "
        "never guess an address."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False),
)
@tool_handler("edit_project")
def edit_project(
    project: ProjectName,
    edits: Annotated[
        list[authoring.Edit],
        WithJsonSchema({"type": "array", "minItems": 1, "items": inline_schema(authoring.Edit)}),
        Field(min_length=1, description="The changes, applied in order"),
    ],
) -> CallToolResult:
    settings = get_settings()
    found = store.get(settings, project)
    data, written = authoring.apply(found.file, edits, store.has_macros(found.file))
    change = ", ".join(sorted({e.op for e in edits}))
    return _written(store.save_version(settings, found, data, change), "Edited", written)


@mcp.tool(
    description=(
        "Empty the project's draft sheet, to start a new dashboard on the same file. Only when the user asks to "
        "start over; to change or drop one section use add_section. Exports already sent are kept."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True),
)
@tool_handler("clear_draft")
def clear_draft(project: ProjectName) -> CallToolResult:
    found = store.get(get_settings(), project)
    store.clear_draft(found)
    return _result(f'The draft for project "{found.name}" is empty. The project and its file stay.')


@mcp.tool(
    description=(
        "Delete a project from this computer: every version of its file, its draft and exported files, and the "
        "uploaded file. Only when the user asks to delete the project. Files in the inbox folder are not touched."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False),
)
@tool_handler("delete_project")
def delete_project(project: ProjectName) -> CallToolResult:
    settings = get_settings()
    found = store.get(settings, project, forgive=False)
    with _books_lock:
        _books.pop(found.key, None)
    sqldb.forget(found.key)
    store.delete(settings, found)
    return _result(f'Deleted project "{found.name}" and everything made from it on this computer.')


def _register_python() -> None:
    @mcp.tool(
        description=(
            "Run Python on a copy of the project's file for analysis the other tools cannot do. The script starts with "
            "pandas imported, INPUT = 'input.xlsx' (the copy) and OUT = 'out'. print() what the user should know; "
            "save charts as PNG and tables as .xlsx/.csv into OUT to send them to the user. No network. "
            "Prefer query, what_if and add_section when they can do the job."
        ),
        annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False),
    )
    @tool_handler("run_python")
    def run_python(
        project: ProjectName,
        code: Annotated[str, Field(description="Python source")],
    ) -> CallToolResult:
        files, _ = workbook(project)
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
    the id to open_file. Behind the same bearer auth as /mcp."""
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
