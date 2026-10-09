# analyst-mcp

Spreadsheet MCP server for a salt-agent (Python 3.12, uv, mcp SDK 2.2). Each file is a named project; opens
xlsx/xlsm/csv, maps every number,
SQL (DuckDB), what-if (`formulas`), sheet specs → PNG previews + xlsx export. No database; files under `DATA_DIR`.
User docs: `README.md`.

## Commands

```sh
uv sync
uv run pytest -q          # ~47 tests, ~15 s, offline
uv run ruff check src tests
MCP_TRANSPORT=http MCP_AUTH_TOKEN=x MCP_PORT=8380 uv run analyst-mcp
```

## Layout (src/analyst_mcp)

| File | Role |
|---|---|
| `server.py` | Tools, `tool_handler` (runs in a thread, ToolFailure/ValidationError → `{code, message}`), `/uploads`, `/healthz`, transports |
| `store.py` | Uploads (sha256), projects (`projects/<key>/versions/<n>.xlsx`, CSV converted once), name lookup, inbox, export paths |
| `workbook.py` | Loads cells (values + formulas), recalculates files without cached values, labels/headers/units, what-if via `formulas` |
| `expr.py` | The Excel formula subset of specs: tokenizer, parser, evaluator, `to_excel` rewrite (`[r2c3]`, `[s1r2c3]`, `SUM_ABOVE()`) |
| `spec.py` | `SheetSpec` models, layout (where each cell lands), evaluation of every cell and check, `problems` |
| `breakdown.py` | Opens a total into the cells that add up to it; validates head groupings |
| `render.py` | matplotlib PNGs: section (table + chart), checks |
| `authoring.py` | `create_project` (new file from rows) and `edit_project` (cell, row, sheet and style edits into new bytes) |
| `export.py` | openpyxl copy of the original + new sheet (formulas, native charts) + Checks sheet |
| `sql.py` | DuckDB in memory per workbook: `cells` + header-row sheets; external access off |
| `pyrun.py` | `run_python` subprocess (only registered when `ALLOW_PYTHON=true`) |
| `fmt.py` | Value display per number format (Indian grouping for `inr`) |

## Decisions that must not be undone

- Preview and export come from the same spec formulas (`spec.build`). Never compute a number for the picture one way
  and write it to Excel another way.
- Spec numbers are formulas over workbook cells, not typed results; bare `C4` is rejected so every reference names
  its sheet. `export_sheet` refuses while a check fails.
- A project is named by the user, not by an id: the model forgets server ids between turns, but a name it and the
  user say stays in the chat, which is how each chat keeps to its own project. No per-chat state on the server.
- A saved version is never written; exports go to `projects/<key>/exports/`. An edit is new bytes saved as the
  project's next version (`store.save_version`), so the name always means the latest file.
- The draft sheet lives on the server (`draft.json`): the agent carries tool results between turns only shortened, so the
  model must never have to resend earlier sections.
- Files reach the server only through `/uploads` (agent app) or the inbox. No `file_base64` tool fields, no
  arbitrary paths.
- Images and files go back as MCP `image` and embedded `resource` (blob) content. The agent stores them as chat
  attachments and gives the model links only.
- Every text read/write uses `encoding="utf-8"`, paths use `pathlib`: macOS, Linux and Windows.
