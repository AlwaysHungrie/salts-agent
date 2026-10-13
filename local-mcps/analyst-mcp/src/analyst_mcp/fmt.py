"""How a value looks in previews and text summaries, following the column's number format."""

import re

from .expr import XlError


def indian(n: float) -> str:
    """12345678 -> 1,23,45,678"""
    sign = "-" if n < 0 else ""
    digits = str(int(round(abs(n))))
    if len(digits) <= 3:
        return sign + digits
    head, tail = digits[:-3], digits[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return sign + ",".join(groups) + "," + tail


RUPEE = re.compile(r"(?:^|[^a-z])(?:rs|inr)(?:[^a-z]|$)|₹", re.IGNORECASE)


def approx(value: object, unit: str = "") -> str:
    """A big number in words people read it in: '≈ ₹ 64.38 Cr' for rupees, '≈ 643.8 million' otherwise; '' if small.
    Models misplace digits in 643,834,212; they do not misread this."""
    if not isinstance(value, int | float) or isinstance(value, bool):
        return ""
    v = float(value)
    if RUPEE.search(unit or ""):
        if abs(v) >= 1e7:
            return f"≈ ₹ {v / 1e7:,.2f} Cr"
        if abs(v) >= 1e5:
            return f"≈ ₹ {v / 1e5:,.2f} lakh"
        return ""
    if abs(v) >= 1e9:
        return f"≈ {v / 1e9:,.2f} billion"
    if abs(v) >= 1e6:
        return f"≈ {v / 1e6:,.2f} million"
    return ""


def display(value: object, fmt: str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, XlError):
        return str(value)
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if not isinstance(value, int | float):
        return str(value)
    v = float(value)
    f = (fmt or "").strip()
    if f in ("", "General", "text"):
        if v.is_integer() and abs(v) < 1e15:
            return f"{int(v):,}"
        return f"{v:,.2f}"
    presets = {
        "int": lambda: f"{v:,.0f}",
        "num1": lambda: f"{v:,.1f}",
        "num2": lambda: f"{v:,.2f}",
        "pct": lambda: f"{v * 100:.1f}%",
        "pct2": lambda: f"{v * 100:.2f}%",
        "inr": lambda: f"₹ {indian(v)}",
        "inr_cr": lambda: f"₹ {v:,.2f} Cr",
        "usd": lambda: f"${v:,.0f}",
        "usd2": lambda: f"${v:,.2f}",
    }
    if f in presets:
        return presets[f]()
    return _excel_like(v, f)


def _excel_like(v: float, f: str) -> str:
    """Best effort for a raw Excel format string: decimals, %, thousands, quoted prefix/suffix."""
    section = f.split(";")[0]
    section = re.sub(r"\[[^\]]*\]", "", section)
    prefix = suffix = ""
    m = re.match(r'^"([^"]*)"', section)
    if m:
        prefix, section = m.group(1), section[m.end() :]
    m = re.search(r'"([^"]*)"$', section)
    if m:
        suffix, section = m.group(1), section[: m.start()]
    pct = "%" in section
    if pct:
        v *= 100
    decimals = len(section.split(".")[1].rstrip("%").replace("#", "0")) if "." in section else 0
    decimals = min(decimals, 6)
    body = f"{v:,.{decimals}f}" if "," in section else f"{v:.{decimals}f}"
    return f"{prefix}{body}{'%' if pct else ''}{suffix}"
