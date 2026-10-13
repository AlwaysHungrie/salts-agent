# analyst-mcp: spreadsheet analysis for a salt-agent

An MCP server that runs on your own computer and gives an agent spreadsheet skills. It
opens Excel (.xlsx, .xlsm) and CSV files and answers questions about them. It can also
run what-if scenarios, build new sheets (tables and charts) into a copy of the
file, make new Excel files from rows, and edit them. The user sees preview images in the chat before anything is
built, and receives the finished .xlsx as a download.

## Projects

A **project** is a named set of files the user works on together. For example, "Dialysis" might hold a rate sheet,
the sub-inventory, and May, June and July data.
- **Naming:** every tool takes `project`, its name, so a chat stays on its project by naming it. Names match loosely,
  so "budget" finds "Q3 Budget".
- **Picking a project:** the model picks the project from the user's words (`list_projects` shows each project with
  its files) and asks only when it can't tell. "Switch to dialysis" moves the chat (`switch_to_project`).
- **Adding files:** `open_file` adds an attachment to a project, or starts a new one. `move_file` regroups files.
- **SQL across files:** `query` reads every file of the project. A sheet name several files share is one stacked
  table with a `file` column, so totals across files are one query. `"<file>.<sheet>"` is one file's sheet.
- **One-file tools:** reads, edits, what-if and dashboards work on one file. They take `file` when the project has
  several, unless the sheet named picks it.

The user's own file is never changed. An edit saves the file's next version
(`projects/<project>/files/<file>/versions/<n>.xlsx`); earlier versions stay on disk. Projects saved before
projects held files open as projects with one file.

## How a request goes

1. The user attaches a file in the chat. The agent app uploads it to this server
   (`POST /uploads`) and the model adds it to a project with `open_file`.
2. `open_file` returns a map of every number in the file. Each entry has its
   cell, the label on its row, its column header, its unit and its formula. The model
   finds numbers from the map, and does not guess cell addresses.
3. For a new sheet, the model adds **sections** one at a time with `add_section`. Each
   section is a table, can have a chart, and holds formulas over the file's cells
   (`=Feasibility!C4*10.764`), with optional checks that tie its totals back to the
   file's own totals. The server keeps the draft (`projects/<p>/files/<f>/draft.json`),
   because the agent does not carry tool results from one turn to the next.
4. Each `add_section` call evaluates the section in Python and draws it as a PNG (plus
   one for its checks). The agent shows the images in the chat. Sections that read
   wrong (rupees shown as crores, an area shown as ₹, a number typed as text, pie
   slices that miss part of the total) are refused before anyone sees them.
5. `export_sheet` writes the draft into a copy of the file. Every number in it is
   a live Excel formula, the checks go on a Checks sheet, and the agent hands the user
   the file. The export is refused while any check fails.

The preview and the export are made from the same formula text, so the numbers in the
picture the user approved are the numbers in the file.

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Lists the projects with their files (edits, draft sections), newest first, and the files in the inbox folder. |
| `open_file` | Adds an upload (`upload_id`) or an inbox file (`inbox_file`) to `project` (made when new; named after the file when left out). A changed file under a name the project has becomes its new version. Returns the map of numbers and the SQL tables. |
| `switch_to_project` | Moves the chat to another project by name. Returns the map of each of its files and the SQL tables. |
| `read_sheet` | Reads a sheet or a range cell by cell, with formulas. Pages with `start_row`. |
| `find` | Finds cells whose text contains some words, with the numbers on the same row, in every file of the project. |
| `query` | Runs one read-only DuckDB SQL query over every file of the project. It can draw the result as a chart, or return it as an .xlsx or .csv file. |
| `what_if` | Changes input cells, recalculates the whole file, and reports the outputs before and after. |
| `breakdown` | Opens a total cell into the items that add up to it exactly; with `groups`, checks every item is in one head and returns the section rows and check. |
| `add_section` | Adds, replaces (`number`) or removes (`remove`) one section of the draft sheet and shows it as an image. |
| `export_sheet` | Builds the draft into a copy of the file and returns the .xlsx. |
| `create_file` | Makes a new Excel file from rows in `project` (first row bold headings; `=` starts a formula) and returns the .xlsx. |
| `edit_file` | Applies edits in order, all or none: `set` cells, `fill` (the top row of a range copied down it, references shifting as in Excel), `append_rows`, `add_sheet`, `rename_sheet` (formulas follow), `delete_sheet` (refused while formulas use it), `format` (bold, number format, fill, width). Saves the file's next version and returns the .xlsx. |
| `move_file` | Moves a file (versions, draft) to another project; a project left empty is removed. |
| `remove_file` | Deletes one file of a project, every version and its upload. Inbox files stay. |
| `clear_draft` | Empties the draft sheet, to start a new dashboard on the same file. |
| `delete_project` | Deletes a project's files, drafts, exports and uploads from this computer. Inbox files stay. |
| `run_python` | Runs Python on a copy of the project's file. **Off** unless `ALLOW_PYTHON=true`; see [Security](#security). |

In SQL, the `cells` table has every non-empty cell: `sheet`, `cell`, `row`, `col`,
`value`, `number`, `formula`, `label`, `header`, `unit`. A sheet with a header row is
also a table named after the sheet, for example `SELECT * FROM "Sales 2025"`.

## Sheet specs

```json
{"sheet_name": "Dashboard", "title": "Project summary",
 "sections": [
   {"title": "1. Plot Area", "columns": ["Item", "Sq. mt.", "Sq. ft."],
    "formats": [null, "num2", "int"],
    "rows": [["Plot area", "=Feasibility!C4", "=[r1c2]*10.764"]]},
   {"title": "2. Profit", "columns": ["Item", "₹ Crore"], "formats": [null, "num2"],
    "rows": [["Revenue", "=Feasibility!C30/10^7"],
             ["Investment", "=Feasibility!C93/10^7"],
             {"cells": ["Net profit", "=[r1c2]-[r2c2]"], "style": "total"}],
    "chart": {"type": "column", "value_columns": [2], "rows": [1, 2, 3]}}],
 "checks": [{"label": "Profit matches the model", "left": "=[s2r3c2]*10^7",
             "right": "=Feasibility!C95", "tolerance": 1}]}
```

- **Cells:** a cell is text, a number, or a formula starting with `=`.
- **Formula references:**
  - Workbook cells need their sheet, quoted when the name has spaces:
    `'C A Details'!F29`.
  - `[r2c3]` is row 2, column 3 of the same table.
  - `[s1r2c3]` is the same cell in section 1. Checks must use this form.
  - `SUM_ABOVE()` sums the rows above, skipping total rows.
- **Functions:** `SUM` `AVERAGE` `MIN` `MAX` `COUNT` `COUNTA` `PRODUCT`
  `SUMPRODUCT` `ROUND` `ROUNDUP` `ROUNDDOWN` `ABS` `SQRT` `INT` `POWER` `MOD` `IF`
  `IFERROR` `ISNUMBER` `ISBLANK` `AND` `OR` `NOT`.
- **Formats:** `int`, `num1`, `num2`, `pct`, `pct2`, `inr` (₹ 1,23,45,678),
  `inr_cr`, `usd`, `usd2`, `text`, or any Excel format string. Percentages are
  fractions, so 0.25 shows as 25.0%.
- **Charts:** `bar` (horizontal), `column`, `pie` or `line`. A chart plots
  consecutive rows of its table.

## Running it

salts-tools runs it on your laptop behind the shared tunnel and connects it to the agent:

```bash
salts-tools start analyst        # or start:staging analyst
```

That needs [uv](https://docs.astral.sh/uv/) and cloudflared, but not Docker. The agent gets an MCP server named
`analyst` with the token already set. Turn on **File ingest** and **MCP** in the agent's
capabilities so users can attach workbooks.

By hand:

```bash
uv sync
uv run analyst-mcp                                        # stdio
MCP_TRANSPORT=http MCP_AUTH_TOKEN=… uv run analyst-mcp    # HTTP on 127.0.0.1:8000/mcp
uv run pytest -q
uv run ruff check src tests
```

## Settings

Set these in `.env` (see `.env.example`) or in the environment.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | `./data` | Holds uploads and projects (`projects/<p>/files/<f>/versions/<n>.xlsx`, exports in `projects/<p>/exports/`). |
| `INBOX_DIR` | `DATA_DIR/inbox` | A folder of files the agent can open by name. |
| `MAX_FILE_BYTES` | 25 MB | The largest file accepted. |
| `MAX_ROWS` | 200 | The most rows a query or a sheet read returns. |
| `ALLOW_PYTHON` | `false` | Registers `run_python`. |
| `PYTHON_TIMEOUT_SECONDS` | 60 | The time limit for one `run_python` call. |

## Limits

- Old `.xls` and OpenDocument `.ods` files are refused. Save them as `.xlsx` first.
- An exported copy does not keep charts or images that were already in the file.
  `open_file` says when a file has them.
- Exported formulas have no saved results. Excel, Google Sheets and Numbers calculate
  them when the file opens; quick-look previews show them empty.
- `what_if` compiles the file's formulas the first time it runs on a project version,
  which takes seconds to a minute. Later calls are fast. Excel functions the
  [`formulas`](https://github.com/vinci1it2000/formulas) package does not support make
  it fail with a `recalc_failed` error.

## Security

- **Network:** the server listens on `127.0.0.1` only. Every request except
  `/healthz` needs `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- **Files:** inbox file names cannot leave the inbox folder, and the server never reads
  other paths on the machine.
- **SQL:** queries run in an in-memory DuckDB with external access switched off. Only
  reading statements are accepted.
- **`run_python`:** it runs code the model wrote on this machine. Each run gets a fresh
  folder, a copy of the project's file, an emptied environment and a time limit. That is not
  a sandbox: the code can read anything your user account can read. Leave it off unless
  you trust everyone who can message the agent.
