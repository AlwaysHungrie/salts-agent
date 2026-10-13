from pathlib import Path

import pytest

from analyst_mcp import report, server

from .conftest import SAMPLE_SPEC, blobs, build_draft, error, text

REPORT = {
    "title": "Sample project",
    "subtitle": "Plot of {s1r1c2} sq. mt.",
    "facts": [{"label": "Property", "value": "C S No. 1"}],
    "highlights": [
        {"label": "Plot area", "cell": "[s1r1c3]", "unit": "sq. ft."},
        {"label": "Net profit", "cell": "[s2r3c2]", "note": "On revenue of {s2r1c3} Cr"},
    ],
    "leads": [None, "Net profit is {s2r3c2}."],
    "notes": [{"label": "Source", "text": "The <model> sheet."}],
}


@pytest.fixture
def printed(monkeypatch) -> list[str]:
    """Stands in for Chrome: records the page and writes a stub PDF."""
    pages = []

    def fake_print(page: str, out: Path, chrome: str, timeout: int = 90) -> Path:
        pages.append(page)
        out.write_bytes(b"%PDF-1.7 stub")
        return out

    monkeypatch.setattr(report, "find_chrome", lambda configured: "chrome")
    monkeypatch.setattr(report, "print_pdf", fake_print)
    return pages


async def test_report_prints_the_draft(proj, printed):
    assert not (await build_draft(proj, SAMPLE_SPEC))[-1].is_error
    res = await server.export_report(proj, report_spec=REPORT, file_name="Client report")
    assert "2. Profit" in text(res)
    assert blobs(res, "resource") == [b"%PDF-1.7 stub"]
    assert res.content[-1].resource.mime_type == "application/pdf"
    page = printed[0]
    # Numbers come from the draft's cells, shown in their formats.
    profit = 1000 * 2 * 10.764 * 0.9 * 30000 - (1000 * 2 * 10.764 * 0.9 * 4000 + 5000000)
    assert f'Net profit is <span class="num">{report.display(profit, "inr")}</span>.' in page
    assert "1,000.00</span> sq. mt." in page
    assert "10,764<small>sq. ft.</small>" in page
    assert "&lt;model&gt;" in page  # text is escaped
    assert page.count('<section class="slide') == 5  # cover, at a glance, two sections, notes
    assert "<svg" in page and "At a glance" in page and "Basis of these figures" in page


async def test_report_refuses_without_draft_and_bad_cells(proj, printed):
    assert error(await server.export_report(proj, report_spec=REPORT))["code"] == "no_draft"
    await build_draft(proj, SAMPLE_SPEC)
    bad = {**REPORT, "highlights": [{"label": "X", "cell": "[s3r1c1]"}]}
    assert error(await server.export_report(proj, report_spec=bad))["code"] == "bad_cell"
    typed = {**REPORT, "highlights": [{"label": "X", "cell": "1,000"}]}
    assert error(await server.export_report(proj, report_spec=typed))["code"] == "bad_cell"
    many = {**REPORT, "leads": ["a", "b", "c"]}
    assert error(await server.export_report(proj, report_spec=many))["code"] == "invalid_spec"
    assert not printed


async def test_report_refuses_failing_checks(proj, printed):
    spec = {**SAMPLE_SPEC, "checks": [{"label": "Wrong", "left": "=[s1r1c2]", "right": "=1", "tolerance": 0}]}
    await build_draft(proj, spec)
    assert error(await server.export_report(proj, report_spec=REPORT))["code"] == "checks_failed"


async def test_long_table_splits_evenly(proj, printed):
    rows = [[f"T{i}", "=Inputs!B1"] for i in range(1, 43)]
    spec = {"title": "Long", "sections": [{"title": "1. Rows", "columns": ["Item", "Value"], "rows": rows}]}
    await build_draft(proj, spec)
    await server.export_report(proj, report_spec={"title": "Long"})
    page = printed[0]
    assert page.count("class='cont'") == 2  # 42 rows: three slides of 14
    assert page.count("<tr") == 42 + 3


def test_ticks_are_round():
    assert report._ticks(0, 64.38) == [0, 20, 40, 60, 80]
    assert report._ticks(-3, 9) == [-5, 0, 5, 10]
    ticks = report._ticks(0, 0.37)
    assert ticks[0] == 0 and ticks[-1] >= 0.37 and len(ticks) <= 6


def test_find_chrome_reports_missing_path(tmp_path):
    with pytest.raises(report.ToolFailure) as e:
        report.find_chrome(tmp_path / "nope")
    assert e.value.code == "no_browser"
