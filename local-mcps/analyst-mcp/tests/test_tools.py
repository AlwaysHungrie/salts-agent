import copy
import io

import openpyxl
import pytest

from analyst_mcp import server

from .conftest import SAMPLE_SPEC, blobs, error, text

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
    res = await server.preview_sheet(wid, SAMPLE_SPEC)
    body = text(res)
    assert "All checks pass" in body
    assert "| Plot area | 1,000.00 | 10,764 |" in body
    assert f"₹ {PROFIT / 1e7:,.2f}"[:6] not in body  # amount column uses Indian grouping, not crore
    assert len(blobs(res, "image")) == 3  # two sections + checks


async def test_preview_reports_failing_check(wid):
    spec = copy.deepcopy(SAMPLE_SPEC)
    spec["checks"][0]["right"] = "='Model Sheet'!B5"
    body = text(await server.preview_sheet(wid, spec))
    assert "CHECK: Profit matches the model" in body
    res = await server.export_sheet(wid, spec)
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
    assert error(await server.preview_sheet(wid, spec))["code"] == code


async def test_export_is_a_copy_with_live_formulas(wid, model_file):
    before = model_file.read_bytes()
    res = await server.export_sheet(wid, SAMPLE_SPEC, file_name="Client pack")
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
