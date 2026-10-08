import copy
import io
import json

import openpyxl
import pytest

from analyst_mcp import server

from .conftest import SAMPLE_SPEC, blobs, build_draft, error, text

PROFIT = 1000 * 2 * 10.764 * 0.9 * 30000 - (1000 * 2 * 10.764 * 0.9 * 4000 + 5000000)


async def test_open_recalculates_and_maps(wid):
    res = await server.open_workbook(inbox_file="model.xlsx")
    body = text(res)
    assert f"workbook_id={wid}" in body
    assert "recalculated" in body
    assert "| B6 | Net profit |" in body
    # A table column is summarised once, its SUM row named as the total.
    assert 'Column "Existing" B2:B7: 6 numbers' in body
    assert "total row B8" in body
    assert '"Tenants"' in body  # also a SQL table


async def test_open_same_file_twice_gives_same_id(wid):
    again = await server.open_workbook(inbox_file="model.xlsx")
    assert f"workbook_id={wid}" in text(again)


async def test_inbox_name_cannot_escape(settings, wid):
    res = await server.open_workbook(inbox_file="../workbooks/x.xlsx")
    assert error(res)["code"] == "inbox_file_not_found"


async def test_find_and_read(wid):
    found = text(await server.find(wid, "net PROFIT"))
    assert "Model Sheet!A6" in found and f"{PROFIT:,.0f}"[:6] in found
    read = text(await server.read_sheet(wid, "model sheet", "A1:B2"))
    assert "B2:" in read and "[=B1*Inputs!B2]" in read


async def test_query_is_read_only_and_charts(wid):
    res = await server.query(wid, 'SELECT Tenant, Existing FROM "Tenants" ORDER BY Existing DESC', chart="bar")
    assert "| T4 | 28.2 |" in text(res)
    assert len(blobs(res, "image")) == 1
    assert error(await server.query(wid, "DROP TABLE cells"))["code"] == "read_only"
    assert error(await server.query(wid, "SELECT 1; SELECT 2"))["code"] == "bad_sql"
    leak = await server.query(wid, "SELECT * FROM read_csv('/etc/hosts')")
    assert error(leak)["code"] == "sql_error"


async def test_query_file(wid):
    res = await server.query(wid, "SELECT sheet, cell, number FROM cells WHERE number IS NOT NULL", file_format="xlsx")
    (data,) = blobs(res, "resource")
    rows = list(openpyxl.load_workbook(io.BytesIO(data)).active.values)
    assert rows[0] == ("sheet", "cell", "number") and len(rows) > 10


async def test_what_if(wid):
    res = text(await server.what_if(wid, {"Inputs!B2": 33000}, ["'Model Sheet'!B6"]))
    expected = PROFIT + 1000 * 2 * 10.764 * 0.9 * 3000
    assert f"{expected:,.0f}"[:7] in res
    assert "+" in res  # relative change shown


async def test_preview_numbers_images_and_checks(wid):
    first, second = await build_draft(wid, SAMPLE_SPEC)
    assert "| Plot area | 1,000.00 | 10,764 |" in text(first)
    assert "- OK: Profit matches the model" in text(second)
    assert f"₹ {PROFIT / 1e7:,.2f}"[:6] not in text(second)  # amount column uses Indian grouping, not crore
    assert len(blobs(first, "image")) == 1 and len(blobs(second, "image")) == 2  # each section once, + its checks


async def test_preview_reports_failing_check(wid):
    spec = copy.deepcopy(SAMPLE_SPEC)
    spec["checks"][0]["right"] = "='Model Sheet'!B5"
    assert "CHECK: Profit matches the model" in text((await build_draft(wid, spec))[-1])
    res = await server.export_sheet(wid)
    assert error(res)["code"] == "checks_failed"


@pytest.mark.parametrize(
    "change, code",
    [
        (lambda s: s["sections"][0]["rows"][0].__setitem__(1, "=B1"), "bad_formula"),
        (lambda s: s.__setitem__("sheet_name", "Inputs"), "sheet_exists"),
        (lambda s: s["sections"][0]["rows"][0].__setitem__(2, "=[r1c3]"), "circular_reference"),
        (lambda s: s["sections"][0]["rows"].append(["a", 1, 2, 3]), "invalid_spec"),
        (lambda s: s["sections"][0]["rows"][0].__setitem__(1, "=Nope!A1"), "sheet_not_found"),
    ],
)
async def test_spec_errors_are_specific(wid, change, code):
    spec = copy.deepcopy(SAMPLE_SPEC)
    change(spec)
    assert error((await build_draft(wid, spec))[-1])["code"] == code


async def test_refused_call_is_logged_with_its_arguments(wid, caplog):
    caplog.set_level("INFO", logger="analyst_mcp")
    res = await server.add_section(wid, section={"title": "Bad", "columns": ["A"], "rows": "not a list"})
    assert error(res)["code"] == "invalid_spec"
    (line,) = [r.getMessage() for r in caplog.records if "add_section failed" in r.getMessage()]
    assert "invalid_spec" in line and "rows" in line
    assert '"not a list"' in line and wid in line


async def test_clear_draft_starts_over_on_the_same_file(wid):
    await build_draft(wid, SAMPLE_SPEC)
    assert not (await server.clear_draft(wid)).is_error
    assert error(await server.export_sheet(wid))["code"] == "no_draft"
    assert "Draft sheet" not in text(await server.list_workbooks())
    res = await server.add_section(wid, SAMPLE_SPEC["sections"][0])
    assert "Draft sections now: " + SAMPLE_SPEC["sections"][0]["title"] + "." in text(res)


async def test_forget_workbook_deletes_its_files_but_not_the_inbox(settings, wid, model_file):
    from analyst_mcp import store

    upload_id, _ = store.save_upload(settings, model_file.read_bytes())
    assert f"workbook_id={wid}" in text(await server.open_workbook(upload_id=upload_id))
    await build_draft(wid, SAMPLE_SPEC)
    assert not (await server.forget_workbook(wid)).is_error
    assert not (settings.data_dir / "workbooks" / wid).exists()
    assert not list((settings.data_dir / "uploads").iterdir())
    assert model_file.exists()
    assert error(await server.read_sheet(wid, "Inputs"))["code"] == "workbook_not_found"
    assert error(await server.open_workbook(upload_id=upload_id))["code"] == "upload_not_found"
    # Opening it again from the inbox gives a fresh workbook with no draft.
    again = await server.open_workbook(inbox_file=model_file.name)
    assert f"workbook_id={wid}" in text(again)
    assert error(await server.export_sheet(wid))["code"] == "no_draft"


async def test_export_is_a_copy_with_live_formulas(wid, model_file):
    before = model_file.read_bytes()
    await build_draft(wid, SAMPLE_SPEC)
    res = await server.export_sheet(wid, file_name="Client pack")
    assert not res.is_error, text(res)
    (data,) = blobs(res, "resource")
    uri = next(c.resource.uri for c in res.content if c.type == "resource")
    assert uri.startswith("file:///Client%20pack")
    wb = openpyxl.load_workbook(io.BytesIO(data))
    assert wb.sheetnames == ["Dashboard", "Inputs", "Model Sheet", "Tenants", "Checks"]
    dash = wb["Dashboard"]
    cells = {c.value for row in dash.iter_rows() for c in row if isinstance(c.value, str)}
    assert "=Inputs!B1" in cells
    assert "='Model Sheet'!B2" in cells
    assert any(v.startswith("=C") and "-C" in v for v in cells)  # [r1c2]-[r2c2] became addresses
    assert len(dash._charts) == 1
    assert wb["Checks"]["B4"].value.startswith("=Dashboard!")
    assert model_file.read_bytes() == before  # the original is untouched


async def test_csv_upload_flow(settings):
    from starlette.testclient import TestClient

    client = TestClient(server.build_http_app())
    csv = b"Region,Sales\nNorth,120\nSouth,80\nNorth,40\n"
    assert client.post("/uploads", content=csv).status_code == 401
    res = client.post("/uploads", content=csv, headers={"authorization": "Bearer test-token"})
    assert res.status_code == 200, res.text
    upload_id = res.json()["upload_id"]
    opened = await server.open_workbook(upload_id=upload_id, name="sales.csv")
    wid = text(opened).split("workbook_id=")[1].split(".")[0]
    q = text(await server.query(wid, 'SELECT Region, SUM(Sales) AS total FROM "sales" GROUP BY 1 ORDER BY 1'))
    assert "| North | 160 |" in q
    old_xls = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1rest"
    bad = client.post("/uploads", content=old_xls, headers={"authorization": "Bearer test-token"})
    assert bad.status_code == 400 and "xls" in bad.json()["error"]["message"]


def test_run_python_is_off_by_default():
    assert "run_python" not in {t.name for t in server.mcp._tool_manager.list_tools()}


async def test_pyrun_copies_input_and_collects_outputs(wid, settings):
    from analyst_mcp import pyrun, store

    files = store.get_files(settings, wid)
    code = (
        "import matplotlib.pyplot as plt\n"
        "df = pd.read_excel(INPUT, sheet_name='Tenants')\n"
        "print(len(df))\n"
        "df.to_csv(OUT + '/t.csv', index=False)\n"
        "plt.plot([1, 2]); plt.savefig(OUT + '/c.png')\n"
    )
    res = pyrun.run(files, code, timeout=60)
    assert res.exit_code == 0, res.output
    assert res.output.splitlines()[0] == "6"  # the SUM row has no saved result, so pandas sees it as empty
    assert [p.name for p in res.images] == ["c.png"] and [p.name for p in res.files] == ["t.csv"]
    slow = pyrun.run(files, "import time; time.sleep(5)", timeout=1)
    assert slow.exit_code is None and "stopped" in slow.output


async def test_row_formats_override_columns(wid):
    spec = {
        "title": "Mixed units",
        "sections": [
            {
                "title": "Sale rate",
                "columns": ["Item", "Value", "Unit"],
                "formats": [None, "int", None],
                "rows": [
                    {"cells": ["Revenue", "='Model Sheet'!B2", "₹"], "format": "inr"},
                    ["Area", "='Model Sheet'!B1", "sq ft"],
                    {"cells": ["Margin", "='Model Sheet'!B6/'Model Sheet'!B2", ""], "formats": [None, "pct"]},
                ],
            }
        ],
    }
    body = text((await build_draft(wid, spec))[-1])
    assert "| Revenue | ₹ 58,12,56,000 | ₹ |" in body
    assert "| Area | 19,375 | sq ft |" in body
    assert "| Margin | 85.8% |  |" in body
    res = await server.export_sheet(wid)
    (data,) = blobs(res, "resource")
    ws = openpyxl.load_workbook(io.BytesIO(data))["Dashboard"]
    formats = [ws.cell(r, 3).number_format for r in range(6, 9)]  # title row 4, header 5, data 6-8
    assert formats[1] == "#,##0" and formats[2] == "0.0%" and "₹" in formats[0]


async def test_breakdown_lists_the_parts_of_a_total(wid):
    body = text(await server.breakdown(wid, "'Model Sheet'!B6"))
    # Net profit = Revenue - (Construction + Approvals): the total cost subtotal is opened, signs kept.
    assert "| B2 | Revenue |" in body
    assert "| B3 | Construction | minus" in body
    assert "| B4 | Approvals | minus" in body
    assert "B5" not in body.split("items:")[1]


async def test_breakdown_groups_must_cover_every_item_once(wid):
    missing = error(await server.breakdown(wid, "'Model Sheet'!B5", {"Building": ["B3"]}))
    assert missing["code"] == "bad_groups" and "B4 Approvals" in missing["message"]
    twice = error(await server.breakdown(wid, "'Model Sheet'!B5", {"A": ["B3:B4"], "B": ["B4"]}))
    assert "in both 'A' and 'B'" in twice["message"]


async def test_sections_build_a_draft_that_exports(wid):
    area = {"title": "1. Area", "columns": ["Item", "Sq. ft."], "formats": [None, "int"],
            "rows": [["Saleable area", "='Model Sheet'!B1"]]}  # fmt: skip
    first = await server.add_section(wid, area, title="Project dashboard")
    assert len(first.content) == 2 and "Draft sections now: 1. Area." in text(first)

    body = text(await server.breakdown(wid, "'Model Sheet'!B5", {"Building": ["B3"], "Approvals": ["B4"]}))
    section = json.loads(body.split("as the user asked):\n", 1)[1].split("\n\n", 1)[0])
    check = json.loads(body.split("Its check:\n", 1)[1].split("\n\n", 1)[0])
    section["title"] = "2. Where the cost goes"
    second = await server.add_section(wid, section, checks=[check])
    assert "- OK: Heads add up to Total cost" in text(second)
    assert "| Total |" in text(second) and "100.0%" in text(second)
    assert len(blobs(second, "image")) == 2  # the section and its checks, not section 1 again

    # Change section 1 in place; the check of section 2 still points at section 2.
    area["rows"][0][0] = "Saleable carpet area"
    assert "1. Area | 2. Where the cost goes" in text(await server.add_section(wid, area, number=1))
    assert "Draft sheet for" in text(await server.list_workbooks())
    removed = await server.add_section(wid, number=1, remove=True)
    assert "Draft sections now: 2. Where the cost goes." in text(removed)
    await server.add_section(wid, area)  # now section 2; the cost check moved to section 1 with its section

    exported = await server.export_sheet(wid)
    (data,) = blobs(exported, "resource")
    book = openpyxl.load_workbook(io.BytesIO(data))
    ws = book["Dashboard"]
    assert ws["B2"].value == "Project dashboard"
    assert "Saleable carpet area" in [c.value for c in ws["B"]]
    assert "- 2. Where the cost goes (3 rows)\n- 1. Area (1 rows)" in text(exported)
    assert "Heads add up to Total cost" in [row[0].value for row in book["Checks"].iter_rows(max_col=1)]


async def test_preview_refuses_numbers_that_read_wrong(wid):
    def spec(fmt, value, chart=None):
        return {"title": "T", "sections": [{"title": "1. S", "columns": ["Item", "Value"], "formats": [None, fmt],
                                            "rows": [["Revenue", value]], "chart": chart}]}  # fmt: skip

    crore = error((await build_draft(wid, spec("inr_cr", "='Model Sheet'!B2")))[-1])
    assert crore["code"] == "spec_problems" and "use inr for rupees" in crore["message"]
    assert not (await build_draft(wid, spec("inr_cr", "='Model Sheet'!B2/10^7")))[-1].is_error
    pct = error((await build_draft(wid, spec("pct", "=57.7")))[-1])
    assert "percents are fractions" in pct["message"]
    typed = error((await build_draft(wid, spec("int", "₹100")))[-1])
    assert "typed text '₹100'" in typed["message"]
    rows = [["Revenue", "='Model Sheet'!B2", "₹"], ["Saleable area", "='Model Sheet'!B1", "sq ft"]]
    area = {"title": "T", "sections": [{"title": "1. S", "columns": ["Item", "Value", "Unit"], "formats": [None, "inr"],
                                        "rows": rows}]}  # fmt: skip
    assert "row 2 shows 19,375.20 as money" in error((await build_draft(wid, area))[-1])["message"]
    pie = {
        "title": "T",
        "sections": [{
            "title": "1. Cost", "columns": ["Head", "Amount"],
            "rows": [["Construction", "='Model Sheet'!B3"],
                     {"cells": ["Total", "='Model Sheet'!B5"], "style": "total"}],
            "chart": {"type": "pie", "value_columns": [2]},
        }],
    }  # fmt: skip
    assert "pie slices add up to" in error((await build_draft(wid, pie))[-1])["message"]


def test_big_numbers_get_words():
    from analyst_mcp.fmt import approx

    assert approx(643834212.77, "Rs.") == "≈ ₹ 64.38 Cr"
    assert approx(475000, "Rs.") == "≈ ₹ 4.75 lakh"
    assert approx(35000, "Rs.") == ""
    assert approx(643834212.77, "") == "≈ 643.83 million"
    assert approx(19375, "sq ft") == ""


async def test_unknown_workbook_id_names_the_open_ones(wid):
    lost = error(await server.breakdown("abcdefabcdef", "'Model Sheet'!B5"))
    assert lost["code"] == "workbook_not_found" and f"{wid} (model.xlsx)" in lost["message"]
