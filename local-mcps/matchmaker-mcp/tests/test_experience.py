from datetime import date

import pytest

from recruiter_mcp.experience import years_of_experience

TODAY = date(2026, 9, 30)


def r(start, end):
    return {"start": start, "end": end}


def test_single_role_to_present():
    # 2024-01..2026-09 inclusive = 33 months
    assert years_of_experience([r("2024-01", "present")], TODAY) == pytest.approx(2.8)


def test_overlapping_roles_are_merged_not_double_counted():
    roles = [r("2021-01", "present"), r("2020-01", "2022-06"), r("2018-07", "2020-12")]
    # merged 2018-07..2026-09 = 99 months = 8.25, stored to one decimal
    assert years_of_experience(roles, TODAY) == 8.2


def test_gaps_are_not_counted():
    roles = [r("2015-01", "2015-12"), r("2020-01", "2020-12")]
    assert years_of_experience(roles, TODAY) == 2.0


def test_year_only_dates_and_case_insensitive_present():
    # Year-only start = January, year-only end = December: 2016-01..2020-12 = 60 months.
    assert years_of_experience([r("2016", "2020")], TODAY) == 5.0
    assert years_of_experience([r("2025", "2025")], TODAY) == 1.0
    # A year-only end in the current year is capped at today, not December.
    assert years_of_experience([r("2026-01", "2026")], TODAY) == pytest.approx(0.8)
    assert years_of_experience([r("2026-01", "Present")], TODAY) == pytest.approx(0.8)


def test_no_dates_returns_none():
    assert years_of_experience([r(None, None)], TODAY) is None
    assert years_of_experience([], TODAY) is None


def test_garbage_dates_are_ignored():
    assert years_of_experience([r("sometime", "later"), r("2025-01", "2025-12")], TODAY) == 1.0


def test_start_without_end_counts_one_month():
    assert years_of_experience([r("2025-05", None)], TODAY) == pytest.approx(0.1)


def test_future_dates_clamped_and_reversed_ranges_fixed():
    assert years_of_experience([r("2026-01", "2027-06")], TODAY) == pytest.approx(0.8)
    assert years_of_experience([r("2025-12", "2025-01")], TODAY) == 1.0


def test_accepts_role_objects():
    from recruiter_mcp.models import Role

    roles = [Role(title="x", company=None, start="2025-01", end="2025-06", highlights=[])]
    assert years_of_experience(roles, TODAY) == 0.5


def test_month_name_and_slash_dates():
    from datetime import date

    from recruiter_mcp.experience import years_of_experience

    today = date(2026, 9, 30)
    roles = [
        {"start": "Aug 2025", "end": "Present"},
        {"start": "Jan 2024", "end": "Mar 2025"},
        {"start": "Jan 2023", "end": "Oct 2023"},
        {"start": "Aug 2020", "end": "Nov 2022"},
    ]
    assert years_of_experience(roles, today) == 5.6
    same = [{"start": a, "end": b} for a, b in [
        ("August 2025", "present"), ("01/2024", "2025/03"), ("Jan. 2023", "Oct '23"), ("2020-08", "Nov, 2022")]]
    assert years_of_experience(same, today) == 5.6
    assert years_of_experience([{"start": "Sept 2025", "end": "Currently"}], today) == 1.1
    assert years_of_experience([{"start": "Summer 2020", "end": "Foo 2021"}], today) is None
