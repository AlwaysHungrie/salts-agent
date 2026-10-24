"""What each person has cost the server's own OpenRouter key, per UTC day and month, against
PERSON_DAILY_LIMIT_USD and PERSON_MONTHLY_LIMIT_USD (0 = no limit). Only calls the server pays for count: a caller
who sends their own X-OpenRouter-Api-Key pays for themselves. Kept in DATA_DIR/spend/<person_id>.json, outside the
person's profile folder, so deleting a profile does not reset it."""

import json
from datetime import UTC, datetime
from pathlib import Path

from .errors import ToolFailure
from .services import Services


def _now() -> datetime:
    return datetime.now(UTC)


def _path(svc: Services, person_id: str) -> Path:
    return svc.settings.data_dir / "spend" / f"{person_id}.json"


def totals(svc: Services, person_id: str) -> tuple[float, float]:
    """Today's and this month's spend (UTC), in US dollars."""
    path = _path(svc, person_id)
    stored = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    now = _now()
    day = stored.get("day_usd", 0.0) if stored.get("day") == now.strftime("%Y-%m-%d") else 0.0
    month = stored.get("month_usd", 0.0) if stored.get("month") == now.strftime("%Y-%m") else 0.0
    return day, month


def ensure_room(svc: Services, person_id: str) -> None:
    """Refuse before any model call once today's or this month's limit is used."""
    day, month = totals(svc, person_id)
    daily, monthly = svc.settings.person_daily_limit_usd, svc.settings.person_monthly_limit_usd
    if monthly > 0 and month >= monthly:
        raise ToolFailure("spend_limit_reached", f"this person has used this month's allowance on this server "
                          f"(${month:.4f} of ${monthly:.2f}). Searching and saving work again next month (UTC)")
    if daily > 0 and day >= daily:
        raise ToolFailure("spend_limit_reached", f"this person has used today's allowance on this server "
                          f"(${day:.4f} of ${daily:.2f}). Searching and saving work again tomorrow (midnight UTC)")


def add(svc: Services, person_id: str, usd: float) -> None:
    """Add a call's cost to today and this month. No await between read and write, so calls cannot interleave."""
    if usd <= 0:
        return
    day, month = totals(svc, person_id)
    now = _now()
    path = _path(svc, person_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps({"day": now.strftime("%Y-%m-%d"), "day_usd": day + usd,
                               "month": now.strftime("%Y-%m"), "month_usd": month + usd}), encoding="utf-8")
    tmp.replace(path)
