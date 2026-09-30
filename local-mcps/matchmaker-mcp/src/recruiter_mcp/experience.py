"""years_exp from role dates, computed in code: merge overlapping ranges, sum months."""

import re
from datetime import date

_PRESENT = {"present", "current", "currently", "now", "ongoing", "till date", "to date", "today", "till now"}
_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
# Models are asked for "YYYY-MM" but sometimes copy the resume's own format, so accept the common ones.
_Y_M = re.compile(r"^(\d{4})(?:[-/.](\d{1,2}))?$")  # 2025, 2025-08, 2025/8
_M_Y = re.compile(r"^(\d{1,2})[-/.](\d{4})$")  # 08/2025, 8-2025
_NAME_Y = re.compile(r"^([a-z]{3,9})\.?,?\s*'?(\d{4}|\d{2})$")  # Aug 2025, August 2025, Sept. 2025, Aug '25


def _parse(value: str | None, today: date, *, is_end: bool = False) -> int | None:
    """A resume date -> absolute month index (year*12 + month-1), or None if unusable.
    A year-only date means January as a start and December as an end, so '2016 - 2020' counts all of both
    years rather than stopping in January 2020."""
    if not value:
        return None
    v = re.sub(r"\s+", " ", value.strip().lower())
    if v in _PRESENT:
        return today.year * 12 + today.month - 1
    month: int | None = None
    if m := _Y_M.match(v):
        year, month = int(m.group(1)), int(m.group(2)) if m.group(2) else None
    elif m := _M_Y.match(v):
        month, year = int(m.group(1)), int(m.group(2))
    elif (m := _NAME_Y.match(v)) and m.group(1)[:3] in _MONTHS:
        month, year = _MONTHS[m.group(1)[:3]], int(m.group(2))
        if year < 100:  # '25 -> 2025, '98 -> 1998
            year += 2000 if year <= today.year % 100 + 1 else 1900
    else:
        return None
    month = month or (12 if is_end else 1)
    if not 1 <= month <= 12 or not 1950 <= year <= today.year + 1:
        return None
    return year * 12 + month - 1


def years_of_experience(roles, today: date | None = None) -> float | None:
    """Roles are objects/dicts with `start` and `end`. A role with a start but no end counts one month.
    Returns None when no role has a usable start date."""
    today = today or date.today()
    now = today.year * 12 + today.month - 1
    ranges: list[tuple[int, int]] = []
    for r in roles:
        start = _parse(r["start"] if isinstance(r, dict) else r.start, today)
        end = _parse(r["end"] if isinstance(r, dict) else r.end, today, is_end=True)
        if start is None:
            continue
        if end is None:
            end = start
        start, end = min(start, now), min(end, now)
        if end < start:
            start, end = end, start
        # Inclusive month range: Jan..Jan is one month of work.
        ranges.append((start, end + 1))
    if not ranges:
        return None
    ranges.sort()
    total = 0
    cur_s, cur_e = ranges[0]
    for s, e in ranges[1:]:
        if s <= cur_e:
            cur_e = max(cur_e, e)
        else:
            total += cur_e - cur_s
            cur_s, cur_e = s, e
    total += cur_e - cur_s
    return round(total / 12, 1)
