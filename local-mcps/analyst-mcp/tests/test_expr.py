import pytest

from analyst_mcp import expr
from analyst_mcp.errors import ToolFailure


def ev(formula, refs=None, sec=None):
    refs = refs or {}

    def ref(text):
        if ":" in text:
            return refs[text]
        return [[refs.get(text)]]

    env = expr.Env(ref=ref, sec=sec or (lambda s, r, c: None), sum_above=lambda: 0.0)
    return expr.evaluate(expr.parse(formula), env)


def test_arithmetic_and_precedence():
    assert ev("=1+2*3") == 7
    assert ev("=(1+2)*3") == 9
    assert ev("=2^3^2") == 64  # Excel is left-associative
    assert ev("=-2^2") == 4  # and negation binds tighter than ^
    assert ev("=50%*10") == 5
    assert ev("=10/4") == 2.5


def test_references_and_ranges():
    refs = {"S!A1": 10, "'My Sheet'!B2": 5, "S!A1:A3": [[1], [2], ["x"]]}
    assert ev("=S!A1*2", refs) == 20
    assert ev("='My Sheet'!B2+1", refs) == 6
    assert ev("=SUM(S!A1:A3)", refs) == 3  # text in a range is skipped
    assert ev("=S!Z9+1", refs) == 1  # empty cell is 0


def test_functions():
    assert ev("=ROUND(2.345,2)") == 2.35
    assert ev("=ROUND(-2.5,0)") == -3
    assert ev('=IF(1>2,"a","b")') == "b"
    assert ev("=IFERROR(1/0,7)") == 7
    assert isinstance(ev("=1/0"), expr.XlError)
    assert ev("=MAX(1,5,3)") == 5
    assert ev("=ISNUMBER(S!A1)", {"S!A1": 3}) is True
    assert ev('="a"&1') == "a1"


def test_bare_reference_is_rejected_with_a_hint():
    with pytest.raises(ToolFailure) as e:
        expr.parse("=C4*2")
    assert "needs its sheet" in e.value.message


def test_unknown_function():
    with pytest.raises(ToolFailure) as e:
        ev("=VLOOKUP(1,S!A1:B2,2)", {"S!A1:B2": [[1, 2]]})
    assert e.value.code == "unsupported_function"


def test_to_excel_rewrites_spec_forms_only():
    out = expr.to_excel(
        "=[r1c2]*10.764+SUM_ABOVE()+'my sheet'!$A$1+feasibility!C4",
        lambda s, r, c: f"C{r + 10}",
        lambda: "SUM(C5:C9)",
        lambda name: {"my sheet": "My Sheet", "feasibility": "Feasibility"}[name],
    )
    assert out == "=C11*10.764+SUM(C5:C9)+'My Sheet'!$A$1+Feasibility!C4"
