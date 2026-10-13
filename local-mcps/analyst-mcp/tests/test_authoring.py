"""create_file and edit_file: the agent asks for an Excel file and the user gets a real .xlsx, which every
other tool can then read and later edits start from."""

import io

import openpyxl

from analyst_mcp import server, store
from analyst_mcp.authoring import Edit, NewSheet

from .conftest import blobs, error, text

PLAN = [
    NewSheet(
        name="Week",
        rows=[
            ["Day", "Breakfast", "kcal"],
            ["Mon", "Oats & berries", 350],
            ["Tue", "Poha", 420],
            ["Total", None, "=SUM(C2:C3)"],
        ],
    ),
    NewSheet(name="Rules", rows=[["Rule"], ["No sugar"]]),
]


def book(res) -> openpyxl.Workbook:
    (data,) = blobs(res, "resource")
    return openpyxl.load_workbook(io.BytesIO(data))


async def test_create_sends_a_file_the_other_tools_read(settings):
    res = await server.create_file("Weekly diet plan", PLAN)
    assert not res.is_error, text(res)
    uri = next(c.resource.uri for c in res.content if c.type == "resource")
    assert uri.endswith("Weekly%20diet%20plan.xlsx")
    wb = book(res)
    assert wb.sheetnames == ["Week", "Rules"]
    week = wb["Week"]
    assert week["C2"].value == 350 and week["C4"].value == "=SUM(C2:C3)"
    assert week["A1"].font.b and week.freeze_panes == "A2"
    q = text(await server.query("Weekly diet plan", "SELECT Day, kcal FROM \"Week\" WHERE Day = 'Tue'"))
    assert "| Tue | 420 |" in q


async def test_create_through_the_mcp_call_path(settings):
    # The SDK turns the JSON arguments into models; a schema it cannot read would fail here, not in the tests above.
    res = await server.mcp.call_tool(
        "create_file", {"name": "plan.xlsx", "sheets": [{"name": "A", "rows": [["x", "y"], [1, True]]}]}
    )
    assert not res.is_error, text(res)
    assert book(res)["A"]["B2"].value is True


async def test_edit_makes_a_new_copy_and_shows_the_new_numbers(settings, proj, model_file):
    before = model_file.read_bytes()
    res = await server.edit_file(
        proj,
        [
            Edit(op="set", sheet="inputs", cells={"B2": 35000}),
            Edit(op="append_rows", sheet="Tenants", rows=[["T7", 30]]),
            Edit(op="format", sheet="Tenants", range="A1:C1", bold=True, fill="FFF2CC", width=14),
        ],
    )
    assert not res.is_error, text(res)
    body = text(res)
    assert "Inputs!B2 = 35,000" in body
    wb = book(res)
    assert wb["Tenants"]["A9"].value == "T7"
    assert wb["Tenants"]["A1"].font.b and wb["Tenants"]["A1"].fill.start_color.rgb.endswith("FFF2CC")
    # The project now means the edited file; the user's own file is as it was.
    revenue = text(await server.read_sheet(proj, "Model Sheet", "B2:B2"))
    assert f"{1000 * 2 * 10.764 * 0.9 * 35000:,.0f}"[:6] in revenue
    assert model_file.read_bytes() == before


async def test_rename_carries_formulas_along(settings, proj):
    res = await server.edit_file(proj, [Edit(op="rename_sheet", sheet="Inputs", to="Assumptions 2026")])
    assert not res.is_error, text(res)
    model = book(res)["Model Sheet"]
    assert model["B1"].value == "='Assumptions 2026'!B1*2*10.764*0.9"
    assert model["B2"].value == "=B1*'Assumptions 2026'!B2"


async def test_delete_of_a_sheet_in_use_is_refused_and_nothing_is_saved(settings, proj):
    version = store.get_book(settings, proj).version
    res = await server.edit_file(
        proj, [Edit(op="add_sheet", sheet="Notes", rows=[["ok"]]), Edit(op="delete_sheet", sheet="Inputs")]
    )
    err = error(res)
    assert err["code"] == "sheet_in_use"
    assert err["message"].startswith("edit 2 (delete_sheet)") and "Model Sheet!B1" in err["message"]
    assert store.get_book(settings, proj).version == version


async def test_unknown_sheet_names_the_real_ones(settings, proj):
    err = error(await server.edit_file(proj, [Edit(op="set", sheet="Sales", cells={"A1": 1})]))
    assert err["code"] == "sheet_not_found" and "Model Sheet" in err["message"]


async def test_edits_are_versions_of_one_file(settings):
    first = await server.create_file("Budget", [NewSheet(name="S", rows=[["a"], [1]])])
    assert 'Created "Budget" in project "Budget"' in text(first)
    await server.edit_file("budget", [Edit(op="set", sheet="S", cells={"A2": 2})])
    third = await server.edit_file("Budget", [Edit(op="set", sheet="S", cells={"A2": 3})])
    uri = next(c.resource.uri for c in third.content if c.type == "resource")
    assert uri.endswith("Budget.xlsx") and book(third)["S"]["A2"].value == 3
    found = store.get_book(settings, "Budget")
    assert found.version == 3 and len(list((found.dir / "versions").iterdir())) == 3
    assert "Budget (2 edits)" in text(await server.list_projects())


async def test_a_new_file_joins_the_project_but_not_over_another(settings):
    await server.create_file("Budget", [NewSheet(name="S", rows=[["a"]])], project="Q3")
    added = await server.create_file("Notes", [NewSheet(name="N", rows=[["b"]])], project="q3")
    assert 'Created "Notes" in project "Q3"' in text(added)
    err = error(await server.create_file("budget", [NewSheet(name="S", rows=[["b"]])], project="Q3"))
    assert err["code"] == "file_exists"


async def test_a_sheet_from_a_query_needs_no_typed_data(settings):
    """An ABC analysis over the project's files as one query: the server fills the sheet, so the model never has to
    write out hundreds of rows (a reply that long gets cut off and the turn ends with nothing)."""
    from .test_tools import month

    for name, qty in (("may", 10), ("june", 20)):
        month(settings, name, qty)
        await server.open_file(inbox_file=f"{name}.xlsx", project="Dialysis")
    abc = """
        WITH t AS (SELECT Item, SUM(Value) AS value FROM "Sales" GROUP BY Item),
        r AS (SELECT *, SUM(value) OVER (ORDER BY value DESC) / SUM(value) OVER () AS cum FROM t)
        SELECT Item, value, round(cum, 2) AS cum_share,
               CASE WHEN cum <= 0.5 THEN 'A' WHEN cum <= 0.8 THEN 'B' ELSE 'C' END AS class
        FROM r ORDER BY value DESC"""
    res = await server.create_file(
        "ABC analysis", [NewSheet(name="ABC", query=abc), NewSheet(name="Notes", rows=[["Note"], ["Rates: lowest"]])],
        project="Dialysis",
    )  # fmt: skip
    assert not res.is_error, text(res)
    ws = book(res)["ABC"]
    assert [c.value for c in ws[1]] == ["Item", "value", "cum_share", "class"]
    assert [c.value for c in ws[2]] == ["Bolt", 150, 0.5, "A"] and ws["D4"].value == "C"
    assert 'Created "ABC analysis" in project "Dialysis"' in text(res)
    assert error(await server.create_file("X", [NewSheet(name="S")], project="Dialysis"))["code"] == "bad_sheet"


async def test_fill_copies_one_row_of_formulas_down(settings):
    """A formula column over 70 items is one set and one fill, not 70 rows typed out (the turn that tried ran out
    of room after one row)."""
    items = [["Item", "Qty", "Rate"], ["Gauze", 3, 10], ["Tape", 5, 4], ["Needle", 2, 50]]
    await server.create_file("Model", [NewSheet(name="Data", rows=items), NewSheet(name="Value", rows=[["Item"]])])
    res = await server.edit_file(
        "Model",
        [
            Edit(
                op="set",
                sheet="Value",
                cells={
                    "A2": "=Data!A2",
                    "B2": "=SUMIF(Data!$A:$A,$A2,Data!B:B)*Data!$C2",
                    "C2": "=RANK(B2,B$2:B$4)",
                },
            ),
            Edit(op="fill", sheet="Value", range="A2:C4"),
        ],
    )
    assert not res.is_error, text(res)
    value = book(res)["Value"]
    assert value["B4"].value == "=SUMIF(Data!$A:$A,$A4,Data!B:B)*Data!$C4"
    assert value["C3"].value == "=RANK(B3,B$2:B$4)"
    body = text(res)
    assert "Value!B4 = 100" in body and "Value!C4 = 1" in body


async def test_fill_refuses_an_empty_top_row(settings):
    await server.create_file("Model", [NewSheet(name="S", rows=[["a"]])])
    err = error(await server.edit_file("Model", [Edit(op="fill", sheet="S", range="B2:B9")]))
    assert err["code"] == "bad_range" and "set the first row" in err["message"]
