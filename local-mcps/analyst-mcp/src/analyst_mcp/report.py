"""A PDF report of the draft: a 16:9 slide deck (cover, key figures, one slide per section, notes) drawn as HTML and
printed by headless Chrome. The numbers come from `spec.build`, the same evaluation the previews and the xlsx use."""

import html
import math
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from pydantic import BaseModel, Field

from .errors import ToolFailure
from .expr import XlError
from .fmt import display
from .render import compact
from .spec import Built, SectionLayout, chart_rows

PALETTE = ["#533afd", "#b9b9f9", "#0d253d", "#ea2261", "#665efd", "#f96bee", "#9b6829", "#64748d"]
ROWS_PER_SLIDE = 20
SIDE_CHART_ROWS = 12  # a table this long, or wider than SIDE_CHART_COLS, gets its chart on a slide of its own
SIDE_CHART_COLS = 4
CELL = re.compile(r"\{s(\d+)r(\d+)c(\d+)\}")


class Fact(BaseModel):
    label: str = Field(description="e.g. 'Property'")
    value: str = Field(description="Short text, e.g. 'C S No. 138'")


class Highlight(BaseModel):
    label: str = Field(description="e.g. 'Net profit'")
    cell: str = Field(description="The draft cell it shows, e.g. '[s2r3c2]' (section 2, row 3, column 2)")
    unit: str | None = Field(None, description="Small text after the number, e.g. 'sq. ft.'")
    note: str | None = Field(None, description="One short line under it; may hold cells like {s1r1c3}")


class Note(BaseModel):
    label: str = Field(description="e.g. 'Source', 'Areas', 'Status'")
    text: str


class Report(BaseModel):
    title: str = Field(description="Big cover title, e.g. 'Zapsu Zuri Compound redevelopment'")
    subtitle: str | None = Field(None, description="One line under the title")
    kicker: str | None = Field(None, description="Small label top-left of the cover, e.g. 'Redevelopment feasibility'")
    short_title: str | None = Field(None, description="Name in every slide's top bar; defaults to the title")
    date: str | None = Field(None, description="Top-right of the cover; defaults to this month, e.g. 'October 2026'")
    facts: list[Fact] = Field(default_factory=list, max_length=4, description="Up to 4 facts along the cover's foot")
    highlights: list[Highlight] = Field(
        default_factory=list, max_length=6, description="Up to 6 key figures for an 'at a glance' slide, the last dark"
    )
    leads: list[str | None] = Field(
        default_factory=list,
        description=(
            "One sentence per section, in section order, shown under its heading (null to skip). Write numbers as "
            "cells, {s2r3c2}, never typed: they are filled with the cell's shown value"
        ),
    )
    notes: list[Note] = Field(default_factory=list, max_length=4, description="Closing 'basis of these figures' slide")
    footer: str | None = Field(None, description="Small line at the foot of every slide, e.g. the source and date")


# ---------------------------------------------------------------------- values


def _num(v: object) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def _cell(built: Built, s: int, r: int, c: int) -> tuple[object, str | None]:
    if not 1 <= s <= len(built.sections):
        raise ToolFailure("bad_cell", f"there is no section {s}; the draft has {len(built.sections)}")
    lay = built.sections[s - 1]
    if not (1 <= r <= len(lay.values) and 1 <= c <= len(lay.section.columns)):
        raise ToolFailure(
            "bad_cell",
            f"section {s} ({lay.section.title!r}) has {len(lay.values)} rows and {len(lay.section.columns)} columns",
        )
    return lay.values[r - 1][c - 1], lay.section.cell_format(r - 1, c - 1)


def _fill(built: Built, text: str) -> str:
    """Escaped text with every {s2r3c2} replaced by that cell's shown value."""
    out, last = [], 0
    for m in CELL.finditer(text):
        out.append(html.escape(text[last : m.start()]))
        value, fmt = _cell(built, int(m[1]), int(m[2]), int(m[3]))
        out.append(f'<span class="num">{html.escape(display(value, fmt))}</span>')
        last = m.end()
    out.append(html.escape(text[last:]))
    return "".join(out)


def _big(text: str, unit: str | None) -> str:
    """A figure for a card: '₹ 12.34 Cr' shows as ₹12.34 with a small 'Cr'."""
    text = text.replace("₹ ", "₹")
    m = re.match(r"^(.*?\d)\s+([A-Za-z][\w. ]*)$", text)
    small = [m[2]] if m else []
    if m:
        text = m[1]
    if unit:
        small.append(unit)
    tail = f"<small>{html.escape(' '.join(small))}</small>" if small else ""
    return html.escape(text) + tail


# ---------------------------------------------------------------------- charts (inline SVG)


@dataclass
class Series:
    labels: list[str]
    names: list[str]
    values: list[list[float]]
    fmts: list[str | None] = field(default_factory=list)


def _series(lay: SectionLayout) -> Series:
    chart = lay.section.chart
    rows = chart_rows(lay.section)
    labels = [display(lay.values[r - 1][chart.label_column - 1], None) for r in rows]
    values = [[_num(lay.values[r - 1][c - 1]) or 0.0 for r in rows] for c in chart.value_columns]
    names = [lay.section.columns[c - 1] for c in chart.value_columns]
    fmts = [lay.section.cell_format(rows[0] - 1, c - 1) for c in chart.value_columns]
    return Series(labels, names, values, fmts)


def _t(x, y, text, size=12, fill="#64748d", anchor="middle", extra=""):
    return (f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" font-size="{size}" fill="{fill}"{extra}>'
            f"{html.escape(text)}</text>")  # fmt: skip


def _short(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _legend(s: Series) -> str:
    if len(s.names) < 2:
        return ""
    items = "".join(f'<span><i style="background:{PALETTE[k % len(PALETTE)]}"></i>{html.escape(n)}</span>'
                    for k, n in enumerate(s.names))  # fmt: skip
    return f'<div class="legend">{items}</div>'


def _scale(values: list[float]) -> tuple[float, float]:
    lo, hi = min(0.0, *values), max(0.0, *values)
    return (lo, hi) if hi > lo else (lo, lo + 1)


def _ticks(lo: float, hi: float, count: int = 4) -> list[float]:
    """Round axis steps (1, 2, 2.5 or 5 times a power of ten) whose span covers lo..hi."""
    raw = (hi - lo) / count or 1.0
    power = 10 ** math.floor(math.log10(raw))
    step = next(m * power for m in (1, 2, 2.5, 5, 10) if m * power >= raw)
    first = math.floor(lo / step) * step
    return [first + i * step for i in range(math.ceil((hi - first) / step - 1e-9) + 1)]


def _grid(ticks: list[float], y, pl: int, w: int, fmt: str | None) -> list[str]:
    out = []
    for v in ticks:
        out.append(f'<line x1="{pl}" x2="{w}" y1="{y(v):.1f}" y2="{y(v):.1f}" stroke="#eef1f5"/>')
        out.append(_t(pl - 8, y(v) + 4, compact(v, fmt), 11, anchor="end"))
    return out


def _column(s: Series, w: int, h: int) -> str:
    pl, pb, pt = 56, 44, 26
    flat = [v for vals in s.values for v in vals]
    ticks = _ticks(*_scale(flat))
    lo, hi = ticks[0], ticks[-1]
    y = lambda v: pt + (hi - v) / (hi - lo) * (h - pt - pb)  # noqa: E731
    n, k = len(s.labels), len(s.values)
    slot = (w - pl) / n
    bw = min(96, slot * 0.7 / k)
    out = _grid(ticks, y, pl, w, s.fmts[0])
    labels_on = n * k <= 10
    for j, label in enumerate(s.labels):
        cx = pl + slot * (j + 0.5)
        for m, vals in enumerate(s.values):
            v = vals[j]
            x = cx - bw * k / 2 + bw * m
            top, bottom = sorted((y(v), y(0)))
            out.append(f'<rect x="{x + 1:.1f}" y="{top:.1f}" width="{bw - 2:.1f}" height="{bottom - top:.1f}" rx="4" '
                       f'fill="{PALETTE[m % len(PALETTE)]}"/>')  # fmt: skip
            if labels_on:
                out.append(_t(x + bw / 2, top - 7, display(v, s.fmts[m]), 12, "#0d253d"))
        out.append(_t(cx, h - pb + 18, _short(label, int(slot / 6.5)), 11.5))
    out.append(f'<line x1="{pl}" x2="{w}" y1="{y(0):.1f}" y2="{y(0):.1f}" stroke="#c9d2dc"/>')
    return f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">{"".join(out)}</svg>'


def _bar(s: Series, w: int, h: int) -> str:
    n, k = len(s.labels), len(s.values)
    gutter = min(200, max(60, 7 * max(len(label) for label in s.labels)))
    flat = [v for vals in s.values for v in vals]
    lo, hi = _scale(flat)
    room = w - gutter - 90
    x = lambda v: gutter + (v - lo) / (hi - lo) * room  # noqa: E731
    slot = h / n
    bh = min(28, slot * 0.72 / k)
    out = []
    for j, label in enumerate(s.labels):
        cy = slot * (j + 0.5)
        out.append(_t(gutter - 10, cy + 4, _short(label, gutter // 7), 11.5, anchor="end"))
        for m, vals in enumerate(s.values):
            v = vals[j]
            yy = cy - bh * k / 2 + bh * m
            left, right = sorted((x(0), x(v)))
            out.append(f'<rect x="{left:.1f}" y="{yy + 1:.1f}" width="{right - left:.1f}" height="{bh - 2:.1f}" '
                       f'rx="3" fill="{PALETTE[m % len(PALETTE)]}"/>')  # fmt: skip
            out.append(_t(right + 8, yy + bh / 2 + 4, display(v, s.fmts[m]), 11.5, "#0d253d", "start"))
    return f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">{"".join(out)}</svg>'


def _line(s: Series, w: int, h: int) -> str:
    pl, pb, pt = 56, 44, 20
    flat = [v for vals in s.values for v in vals]
    lo, hi = min(flat), max(flat)
    pad = (hi - lo) * 0.05 or abs(hi) * 0.1 or 1
    ticks = _ticks(lo - pad, hi + pad)
    lo, hi = ticks[0], ticks[-1]
    y = lambda v: pt + (hi - v) / (hi - lo) * (h - pt - pb)  # noqa: E731
    n = len(s.labels)
    x = lambda j: pl + (w - pl - 16) * (j / (n - 1) if n > 1 else 0.5)  # noqa: E731
    out = _grid(ticks, y, pl, w, s.fmts[0])
    every = max(1, math.ceil(n / 10))
    for j, label in enumerate(s.labels):
        if j % every == 0:
            out.append(_t(x(j), h - pb + 18, _short(label, 12), 11))
    for m, vals in enumerate(s.values):
        color = PALETTE[m % len(PALETTE)]
        pts = " ".join(f"{x(j):.1f},{y(v):.1f}" for j, v in enumerate(vals))
        out.append(
            f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2.5" stroke-linejoin="round"/>'
        )
        if n <= 24:
            out += [f'<circle cx="{x(j):.1f}" cy="{y(v):.1f}" r="3.5" fill="{color}"/>' for j, v in enumerate(vals)]
    return f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">{"".join(out)}</svg>'


def _total(v: float, fmt: str | None) -> str:
    """A donut's centre: rupees in crores or lakhs, so it fits."""
    if (fmt or "").startswith("inr") and abs(v) >= 1e5:
        return f"₹{v / 1e7:,.2f} Cr" if abs(v) >= 1e7 else f"₹{v / 1e5:,.2f} lakh"
    return display(v, fmt)


def _donut(s: Series, size: int) -> tuple[str, str]:
    vals = [max(0.0, v) for v in s.values[0]]
    total = sum(vals) or 1.0
    R, r0, c = size * 0.42, size * 0.27, size / 2

    def p(a, rr):
        return c + rr * math.sin(a), c - rr * math.cos(a)

    out, a0 = [], 0.0
    for i, v in enumerate(vals):
        a1 = a0 + 2 * math.pi * v / total
        if v <= 0:
            continue
        if a1 - a0 >= 2 * math.pi - 1e-9:
            a1 -= 1e-4
        big = 1 if a1 - a0 > math.pi else 0
        (x0, y0), (x1, y1), (x2, y2), (x3, y3) = p(a0, R), p(a1, R), p(a1, r0), p(a0, r0)
        out.append(f'<path d="M{x0:.1f},{y0:.1f} A{R:.1f},{R:.1f} 0 {big} 1 {x1:.1f},{y1:.1f} L{x2:.1f},{y2:.1f} '
                   f'A{r0:.1f},{r0:.1f} 0 {big} 0 {x3:.1f},{y3:.1f} Z" fill="{PALETTE[i % len(PALETTE)]}" '
                   'stroke="#fff" stroke-width="3"/>')  # fmt: skip
        a0 = a1
    out.append(_t(c, c + 2, _total(sum(s.values[0]), s.fmts[0]), 22, "#0d253d", extra=' letter-spacing="-0.6"'))
    out.append(_t(c, c + 24, "Total", 12))
    legend = "".join(
        f'<span><i style="background:{PALETTE[i % len(PALETTE)]}"></i>{html.escape(_short(label, 28))} '
        f"{v / total * 100:.0f}%</span>"
        for i, (label, v) in enumerate(zip(s.labels, vals, strict=True))
    )
    svg = f'<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}">{"".join(out)}</svg>'
    return svg, f'<div class="legend wrap">{legend}</div>'


def chart_svg(lay: SectionLayout, w: int, h: int) -> str:
    s = _series(lay)
    kind = lay.section.chart.type
    if kind == "pie":
        svg, legend = _donut(s, min(w, h - 40))
        return f'{legend}<div class="center">{svg}</div>'
    if kind == "bar":
        return _legend(s) + _bar(s, w, h - (30 if len(s.names) > 1 else 0))
    draw = _line if kind == "line" else _column
    return _legend(s) + draw(s, w, h - (30 if len(s.names) > 1 else 0))


# ---------------------------------------------------------------------- slides


def _table(lay: SectionLayout, rows: list[int], small: bool) -> str:
    sec = lay.section
    head = "".join(f"<th>{html.escape(c)}</th>" for c in sec.columns)
    body = []
    for r in rows:
        style = sec.rows[r].style
        cls = {"total": "tot", "highlight": "hl"}.get(style, "")
        cells = []
        for c, v in enumerate(lay.values[r]):
            text = display(v, sec.cell_format(r, c))
            neg = c and _num(v) is not None and _num(v) < 0
            err = isinstance(v, XlError)
            cls_c = ' class="neg"' if neg or err else ""
            cells.append(f"<td{cls_c}>{html.escape(text)}</td>")
        body.append(f'<tr class="{cls}">{"".join(cells)}</tr>')
    return f'<table class="t{" sm" if small else ""}"><tr>{head}</tr>{"".join(body)}</table>'


def _heading(title: str) -> str:
    """'3. Sale rate' -> 'Sale rate': the number stays in the top bar."""
    return re.sub(r"^\s*\d+[.)]\s*", "", title) or title


class Deck:
    def __init__(self, built: Built, report: Report):
        self.built, self.report = built, report
        self.name = html.escape(report.short_title or report.title)
        self.footer = html.escape(report.footer or "")
        self.slides: list[tuple[str, str, str | None, str]] = []  # (bar label, inner html, footer note, class)

    def add(self, label: str, inner: str, note: str | None = None, cls: str = "") -> None:
        self.slides.append((label, inner, note, cls))

    def html(self) -> str:
        total = len(self.slides) + 1
        out = [self.cover()]
        for i, (label, inner, note, cls) in enumerate(self.slides, 2):
            foot = html.escape(note) if note else self.footer
            out.append(
                f'<section class="slide {cls}"><div class="bar"><span><b>{self.name}</b>&nbsp;&nbsp;&nbsp;'
                f'{html.escape(label)}</span><span class="num">{i:02d} / {total:02d}</span></div>{inner}'
                f'<div class="foot"><span>{foot}</span></div></section>'
            )
        title = html.escape(self.report.title)
        return (f'<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>'
                f'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500&display=block" '
                f'rel="stylesheet"><style>{CSS}</style></head><body>{"".join(out)}</body></html>')  # fmt: skip

    def cover(self) -> str:
        r = self.report
        facts = "".join(
            f'<div><div class="k">{html.escape(f.label)}</div><div class="mv">{html.escape(f.value)}</div></div>'
            for f in r.facts
        )
        cols = max(1, len(r.facts))
        when = html.escape(r.date or date.today().strftime("%B %Y"))
        sub = f'<div class="sub">{_fill(self.built, r.subtitle)}</div>' if r.subtitle else ""
        meta = f'<div class="meta" style="grid-template-columns:repeat({cols},1fr)">{facts}</div>' if facts else ""
        return (f'<section class="slide cover"><div class="mesh"></div><div class="in">'
                f'<div class="bar" style="border:none"><span><b>{html.escape(r.kicker or "")}</b></span>'
                f'<span class="num" style="color:#0d253d;font-weight:400">{when}</span></div>'
                f'<h1>{html.escape(r.title)}</h1>{sub}{meta}</div></section>')  # fmt: skip


def build_html(built: Built, report: Report) -> str:
    deck = Deck(built, report)
    if report.highlights:
        cards = []
        last = len(report.highlights) - 1
        for i, h in enumerate(report.highlights):
            m = re.fullmatch(r"\s*\[s(\d+)r(\d+)c(\d+)\]\s*", h.cell)
            if not m:
                raise ToolFailure("bad_cell", f"highlight {h.label!r}: cell must look like [s2r3c2], not {h.cell!r}")
            value, fmt = _cell(built, int(m[1]), int(m[2]), int(m[3]))
            note = f'<div class="s">{_fill(built, h.note)}</div>' if h.note else ""
            cards.append(f'<div class="card{" dark" if i == last else ""}"><div class="k">{html.escape(h.label)}</div>'
                         f'<div class="v">{_big(display(value, fmt), h.unit)}</div>{note}</div>')  # fmt: skip
        cols = 3 if len(cards) != 4 else 2
        deck.add("At a glance", f'<h2>At a glance</h2><div class="glance" style="grid-template-columns:'
                 f'repeat({cols},1fr)">{"".join(cards)}</div>')  # fmt: skip

    for si, lay in enumerate(built.sections, 1):
        sec = lay.section
        lead_text = report.leads[si - 1] if si - 1 < len(report.leads) else None
        lead = f'<p class="lead">{_fill(built, lead_text)}</p>' if lead_text else ""
        head = f"<h2>{html.escape(_heading(sec.title))}</h2>{lead}"
        n = len(sec.rows)
        parts = math.ceil(n / ROWS_PER_SLIDE)
        chunks = [list(range(n * i // parts, n * (i + 1) // parts)) for i in range(parts)]
        beside = sec.chart is not None and n <= SIDE_CHART_ROWS and len(sec.columns) <= SIDE_CHART_COLS
        small = n > 8
        for k, rows in enumerate(chunks):
            label = sec.title + (" (continued)" if k else "")
            top = head if k == 0 else f"<h2>{html.escape(_heading(sec.title))} <span class='cont'>continued</span></h2>"
            table = f'<div class="card grow">{_table(lay, rows, small)}</div>'
            if beside:
                chart = f'<div class="card chart" style="width:560px">{chart_svg(lay, 496, 330)}</div>'
                deck.add(
                    label, f'{top}<div class="body">{table}{chart}</div>', sec.note, "long" if len(rows) > 12 else ""
                )
            else:
                deck.add(label, f'{top}<div class="body">{table}</div>', sec.note, "long" if len(rows) > 12 else "")
        if sec.chart is not None and not beside:
            title = sec.chart.title or _heading(sec.title)
            chart = f'<div class="card chart grow">{chart_svg(lay, 1060, 400)}</div>'
            deck.add(sec.title + " (chart)", f'<h2>{html.escape(title)}</h2><div class="body">{chart}</div>', sec.note)

    if report.notes:
        cards = "".join(f'<div class="card soft"><div class="k">{html.escape(n.label)}</div>'
                        f'<div class="lead" style="margin-top:6px">{_fill(built, n.text)}</div></div>'
                        for n in report.notes)  # fmt: skip
        deck.add("Notes", f'<h2>Basis of these figures</h2><div class="body notes">{cards}</div>')
    return deck.html()


# ---------------------------------------------------------------------- PDF

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]
CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"]


def find_chrome(configured: Path | None) -> str:
    if configured:
        if configured.exists():
            return str(configured)
        raise ToolFailure("no_browser", f"CHROME_PATH is set to {configured}, which does not exist")
    for path in CHROME_CANDIDATES:
        if Path(path).exists():
            return path
    for name in CHROME_NAMES:
        if found := shutil.which(name):
            return found
    raise ToolFailure(
        "no_browser",
        "PDF reports are printed by Chrome, Chromium or Edge, and none was found on this computer. Install one, or set "
        "CHROME_PATH to its executable",
    )


def print_pdf(page: str, out: Path, chrome: str, timeout: int = 90) -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "report.html"
        src.write_text(page, encoding="utf-8")
        args = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={Path(tmp) / 'profile'}",
            "--no-pdf-header-footer",
            "--virtual-time-budget=10000",
            f"--print-to-pdf={out}",
            src.as_uri(),
        ]
        try:
            run = subprocess.run(args, capture_output=True, timeout=timeout, env={**os.environ})
        except subprocess.TimeoutExpired as e:
            raise ToolFailure("pdf_failed", f"Chrome took longer than {timeout} s to print the report") from e
    if not out.exists() or out.stat().st_size == 0:
        detail = run.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no output"]
        raise ToolFailure("pdf_failed", f"Chrome did not print the report ({detail[0][:300]})")
    return out


CSS = """
@page{size:1280px 720px;margin:0}
:root{--primary:#533afd;--deep:#4434d4;--dark:#1c1e54;--ink:#0d253d;--ink2:#273951;--mute:#64748d;--soft-bg:#f6f9fc;
--cream:#f5e9d4;--hair:#e3e8ee}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:var(--ink);font-family:Inter,system-ui,sans-serif;font-weight:300;
font-feature-settings:"ss01";-webkit-print-color-adjust:exact;print-color-adjust:exact}
.slide{width:1280px;height:720px;position:relative;overflow:hidden;page-break-after:always;background:#fff;
display:flex;flex-direction:column;padding:0 72px}
.slide:last-child{page-break-after:auto}
.bar{display:flex;justify-content:space-between;align-items:center;height:72px;border-bottom:1px solid var(--hair);
font-size:13px;color:var(--mute);letter-spacing:-.2px;flex-shrink:0}
.bar b{font-weight:500;color:var(--ink)}
.num{font-feature-settings:"tnum";letter-spacing:-.42px}
.foot{margin-top:auto;height:48px;display:flex;align-items:center;font-size:11px;color:var(--mute);
border-top:1px solid var(--hair);flex-shrink:0}
h2{font-size:44px;font-weight:300;letter-spacing:-.9px;line-height:1.1;margin-top:36px;flex-shrink:0}
h2 .cont{font-size:20px;color:var(--mute);letter-spacing:-.2px}
.lead{font-size:17px;line-height:1.45;color:var(--ink2);margin-top:12px;max-width:860px}
.body{display:flex;gap:32px;margin-top:28px;flex:1;min-height:0;padding-bottom:28px}
.body.notes{flex-direction:column;gap:14px;max-width:900px}
.card{background:#fff;border:1px solid var(--hair);border-radius:12px;padding:24px 32px;
box-shadow:rgba(0,55,112,.08) 0 1px 3px;display:flex;flex-direction:column;justify-content:center;min-height:0}
.card.grow{flex:1;min-width:0}
.card.chart{align-items:stretch}
.card.soft{background:var(--soft-bg);box-shadow:none}
.card.dark{background:var(--dark);border-color:var(--dark);color:#fff}
.k{font-size:13px;color:var(--mute);font-weight:400;letter-spacing:-.2px}
.dark .k{color:#b9b9f9}
.v{font-size:44px;font-weight:300;letter-spacing:-1px;line-height:1.1;margin-top:10px;font-feature-settings:"tnum"}
.v small{font-size:18px;letter-spacing:-.2px;margin-left:6px;color:var(--mute)}
.dark .v small{color:#b9b9f9}
.s{font-size:13px;color:var(--mute);margin-top:8px;line-height:1.4}
.dark .s{color:#c9cdf5}
.glance{display:grid;gap:24px;margin-top:36px}
.glance .card{padding:32px 36px 28px;min-height:170px;justify-content:flex-start}
table.t{width:100%;border-collapse:collapse;font-size:15px}
table.t th{font-size:13px;font-weight:400;color:var(--mute);text-align:right;padding:0 0 10px 16px;
border-bottom:1px solid var(--hair)}
table.t td{padding:12px 0 12px 16px;border-bottom:1px solid var(--hair);text-align:right;
font-feature-settings:"tnum";letter-spacing:-.3px}
table.t th:first-child,table.t td:first-child{text-align:left;padding-left:0}
table.t tr.hl td{font-weight:500}
table.t tr.hl td:first-child{color:var(--primary)}
table.t tr.tot td{font-weight:500;border-bottom:none;border-top:1.5px solid var(--ink)}
table.t td.neg{color:#ea2261}
table.t td:not(:first-child),table.t th:not(:first-child){white-space:nowrap}
table.sm td{padding:2.5px 0 2.5px 14px;font-size:12.5px}
.long h2{font-size:30px;margin-top:24px}.long .lead{font-size:15px;margin-top:6px}.long .body{margin-top:18px}
.long .card{padding:18px 28px}
table.sm th{padding-bottom:8px;font-size:12px}
.legend{display:flex;gap:20px;font-size:12.5px;color:var(--mute);margin-bottom:10px}
.legend.wrap{flex-wrap:wrap;gap:8px 18px;justify-content:center}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px;vertical-align:-1px}
.center{display:flex;justify-content:center}
svg text{font-family:Inter,system-ui,sans-serif;font-feature-settings:"tnum"}
.cover{padding:0}
.mesh{position:absolute;inset:0 0 auto 0;height:430px;background:
radial-gradient(40% 70% at 8% 30%,#f5e9d4 0%,rgba(245,233,212,0) 70%),
radial-gradient(35% 80% at 30% 10%,#ffc7a3 0%,rgba(255,199,163,0) 70%),
radial-gradient(40% 90% at 55% 35%,#c4b5fd 0%,rgba(196,181,253,0) 70%),
radial-gradient(35% 80% at 78% 15%,#665efd 0%,rgba(102,94,253,0) 72%),
radial-gradient(30% 70% at 96% 45%,#f96bee 0%,rgba(249,107,238,0) 70%),
radial-gradient(30% 60% at 88% 0%,#ea2261 0%,rgba(234,34,97,0) 70%)}
.mesh:after{content:"";position:absolute;inset:0;
background:linear-gradient(to bottom,rgba(255,255,255,0) 45%,#fff 100%)}
.cover .in{position:relative;padding:0 72px;height:100%;display:flex;flex-direction:column}
.cover h1{font-size:72px;font-weight:300;letter-spacing:-2px;line-height:1.02;margin-top:150px;max-width:960px}
.cover .sub{font-size:20px;color:var(--ink2);margin-top:20px;letter-spacing:-.2px;max-width:960px}
.meta{display:grid;margin-top:auto;margin-bottom:56px;border-top:1px solid var(--hair)}
.meta div{padding:18px 24px 0 0}
.meta .k{font-size:12px}
.meta .mv{font-size:17px;margin-top:6px;font-weight:400}
"""
