"""The Excel formula subset a sheet spec is written in.

One formula string does two jobs: `evaluate` computes it in Python for previews and checks, and `to_excel` rewrites
it into the formula the exported sheet carries. Because both come from the same text, the picture the user approves
and the workbook they get cannot disagree.

Beyond Excel syntax, two spec-only forms refer to cells of the sheet being built:
  [r2c3]      row 2, column 3 of this section's table (1-based, data rows only)
  [s1r2c3]    the same in section 1 (needed in checks, which belong to no section)
  SUM_ABOVE() the sum of the data rows above in the same column, skipping rows styled "total"
"""

import math
import re
from collections.abc import Callable
from dataclasses import dataclass

from openpyxl.utils import get_column_letter

from .errors import ToolFailure

TOKEN = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<str>"(?:[^"]|"")*")
  | (?P<sec>\[(?:s(?P<sec_s>\d+))?r(?P<sec_r>\d+)c(?P<sec_c>\d+)\])
  | (?P<ref>(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)
  | (?P<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)
  | (?P<fn>[A-Za-z_][A-Za-z0-9_.]*(?=\s*\())
  | (?P<bool>TRUE|FALSE)\b
  | (?P<bare>\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)
  | (?P<op><=|>=|<>|[-+*/^&=<>%(),:])
    """,
    re.VERBOSE | re.IGNORECASE,
)


class XlError(str):
    """An Excel error value (#DIV/0!, #VALUE!, …) carried through like Excel does."""


@dataclass
class Tok:
    kind: str
    text: str
    start: int
    end: int
    groups: dict


def tokenize(formula: str) -> list[Tok]:
    if not formula.startswith("="):
        raise ToolFailure("bad_formula", f"formulas start with '=': {formula!r}")
    body = formula[1:]
    out: list[Tok] = []
    pos = 0
    while pos < len(body):
        m = TOKEN.match(body, pos)
        if not m:
            raise ToolFailure("bad_formula", f"cannot read {body[pos:pos + 20]!r} in {formula!r}")
        kind = m.lastgroup
        if kind in ("sec_s", "sec_r", "sec_c"):
            kind = "sec"
        if kind != "ws":
            if kind == "bare":
                raise ToolFailure(
                    "bad_formula",
                    f"{m.group(0)!r} in {formula!r} needs its sheet, like Feasibility!{m.group(0)} or "
                    f"'Sheet name'!{m.group(0)}; for cells of the table being built use [r2c3]",
                )
            out.append(Tok(kind, m.group(0), m.start() + 1, m.end() + 1, m.groupdict()))
        pos = m.end()
    return out


# ---------------------------------------------------------------------- parsing


class Parser:
    def __init__(self, formula: str) -> None:
        self.formula = formula
        self.toks = tokenize(formula)
        self.i = 0

    def peek(self) -> Tok | None:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self, text: str | None = None) -> Tok:
        tok = self.peek()
        if tok is None or (text is not None and tok.text != text):
            raise ToolFailure("bad_formula", f"expected {text or 'more'} in {self.formula!r}")
        self.i += 1
        return tok

    def parse(self):
        node = self.compare()
        if self.peek() is not None:
            raise ToolFailure("bad_formula", f"unexpected {self.peek().text!r} in {self.formula!r}")
        return node

    def compare(self):
        node = self.concat()
        while (t := self.peek()) and t.kind == "op" and t.text in ("=", "<>", "<", ">", "<=", ">="):
            self.i += 1
            node = ("bin", t.text, node, self.concat())
        return node

    def concat(self):
        node = self.additive()
        while (t := self.peek()) and t.text == "&":
            self.i += 1
            node = ("bin", "&", node, self.additive())
        return node

    def additive(self):
        node = self.term()
        while (t := self.peek()) and t.kind == "op" and t.text in ("+", "-"):
            self.i += 1
            node = ("bin", t.text, node, self.term())
        return node

    def term(self):
        node = self.power()
        while (t := self.peek()) and t.kind == "op" and t.text in ("*", "/"):
            self.i += 1
            node = ("bin", t.text, node, self.power())
        return node

    def power(self):
        node = self.unary()
        while (t := self.peek()) and t.text == "^":
            self.i += 1
            node = ("bin", "^", node, self.unary())
        return node

    def unary(self):
        t = self.peek()
        if t and t.kind == "op" and t.text in ("-", "+"):
            self.i += 1
            inner = self.unary()
            return ("neg", inner) if t.text == "-" else inner
        return self.postfix()

    def postfix(self):
        node = self.primary()
        while (t := self.peek()) and t.text == "%":
            self.i += 1
            node = ("pct", node)
        return node

    def primary(self):
        t = self.take()
        if t.kind == "num":
            return ("num", float(t.text))
        if t.kind == "str":
            return ("str", t.text[1:-1].replace('""', '"'))
        if t.kind == "bool":
            return ("num", 1.0 if t.text.upper() == "TRUE" else 0.0)
        if t.kind == "ref":
            return ("ref", t.text)
        if t.kind == "sec":
            g = t.groups
            return ("sec", int(g["sec_s"]) if g["sec_s"] else None, int(g["sec_r"]), int(g["sec_c"]))
        if t.kind == "fn":
            name = t.text.upper()
            self.take("(")
            args = []
            if self.peek() and self.peek().text != ")":
                args.append(self.compare())
                while self.peek() and self.peek().text == ",":
                    self.i += 1
                    args.append(self.compare())
            self.take(")")
            return ("fn", name, args)
        if t.text == "(":
            node = self.compare()
            self.take(")")
            return node
        raise ToolFailure("bad_formula", f"unexpected {t.text!r} in {self.formula!r}")


def parse(formula: str):
    return Parser(formula).parse()


# ---------------------------------------------------------------------- evaluation


@dataclass
class Env:
    """What a formula can see while it is evaluated."""

    ref: Callable[[str], list[list[object]]]  # Sheet!A1 or Sheet!A1:B4 -> rows of values
    sec: Callable[[int | None, int, int], object]  # section cell
    sum_above: Callable[[], object]  # SUM_ABOVE() at the cell being evaluated


def _num(v: object) -> float | XlError:
    if isinstance(v, XlError):
        return v
    if v is None or v == "":
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, int | float):
        return float(v)
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return XlError("#VALUE!")


def _flat(values) -> list[object]:
    if isinstance(values, list):
        out = []
        for v in values:
            out.extend(_flat(v))
        return out
    return [values]


def _numbers(args: list) -> list[float] | XlError:
    """Numeric values among the arguments, as SUM sees them: text and blanks in ranges are skipped."""
    out = []
    for arg in args:
        for v in _flat(arg):
            if isinstance(v, XlError):
                return v
            if isinstance(v, bool):
                continue
            if isinstance(v, int | float):
                out.append(float(v))
    return out


def _truthy(v: object) -> bool | XlError:
    if isinstance(v, XlError):
        return v
    if isinstance(v, str):
        if v.upper() in ("TRUE", "FALSE"):
            return v.upper() == "TRUE"
        return XlError("#VALUE!")
    return bool(_num(v))


def _fn(name: str, args: list, raw: list) -> object:
    if name == "SUM_ABOVE":
        raise AssertionError("handled by caller")
    if name in ("SUM", "AVERAGE", "MIN", "MAX", "COUNT", "PRODUCT"):
        nums = _numbers(args)
        if isinstance(nums, XlError):
            return nums
        if name == "SUM":
            return sum(nums)
        if name == "COUNT":
            return float(len(nums))
        if name == "PRODUCT":
            return math.prod(nums) if nums else 0.0
        if not nums:
            return XlError("#DIV/0!") if name == "AVERAGE" else 0.0
        return {"AVERAGE": sum(nums) / len(nums), "MIN": min(nums), "MAX": max(nums)}[name]
    if name == "COUNTA":
        return float(sum(1 for v in _flat(args) if v not in (None, "")))
    if name == "SUMPRODUCT":
        cols = [_flat(a) for a in args]
        if len({len(c) for c in cols}) != 1:
            return XlError("#VALUE!")
        total = 0.0
        for items in zip(*cols, strict=True):
            prod = 1.0
            for v in items:
                prod *= v if isinstance(v, int | float) and not isinstance(v, bool) else 0.0
            total += prod
        return total
    if name in ("ROUND", "ROUNDUP", "ROUNDDOWN"):
        x, digits = _num(_one(args, 0)), _num(_one(args, 1, 0))
        if isinstance(x, XlError) or isinstance(digits, XlError):
            return x if isinstance(x, XlError) else digits
        f = 10 ** int(digits)
        if name == "ROUND":
            return math.floor(abs(x) * f + 0.5) / f * (1 if x >= 0 else -1)
        if name == "ROUNDUP":
            return math.ceil(abs(x) * f) / f * (1 if x >= 0 else -1)
        return math.floor(abs(x) * f) / f * (1 if x >= 0 else -1)
    if name in ("ABS", "SQRT", "INT"):
        x = _num(_one(args, 0))
        if isinstance(x, XlError):
            return x
        if name == "SQRT":
            return math.sqrt(x) if x >= 0 else XlError("#NUM!")
        return abs(x) if name == "ABS" else float(math.floor(x))
    if name in ("POWER", "MOD"):
        a, b = _num(_one(args, 0)), _num(_one(args, 1))
        if isinstance(a, XlError) or isinstance(b, XlError):
            return a if isinstance(a, XlError) else b
        if name == "MOD":
            return XlError("#DIV/0!") if b == 0 else a - b * math.floor(a / b)
        return a**b
    if name == "IF":
        cond = _truthy(_one(args, 0))
        if isinstance(cond, XlError):
            return cond
        return _one(args, 1, True) if cond else _one(args, 2, False)
    if name == "IFERROR":
        v = _one(args, 0)
        return _one(args, 1) if isinstance(v, XlError) else v
    if name == "ISNUMBER":
        v = _one(args, 0)
        return isinstance(v, int | float) and not isinstance(v, bool)
    if name == "ISBLANK":
        return _one(args, 0) in (None, "")
    if name in ("AND", "OR"):
        vals = [_truthy(v) for v in _flat(args) if v is not None]
        for v in vals:
            if isinstance(v, XlError):
                return v
        return all(vals) if name == "AND" else any(vals)
    if name == "NOT":
        v = _truthy(_one(args, 0))
        return v if isinstance(v, XlError) else not v
    raise ToolFailure(
        "unsupported_function",
        f"{name}() is not supported in sheet specs; use {', '.join(sorted(SUPPORTED))}",
    )


SUPPORTED = {
    "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "PRODUCT", "SUMPRODUCT", "ROUND", "ROUNDUP", "ROUNDDOWN",
    "ABS", "SQRT", "INT", "POWER", "MOD", "IF", "IFERROR", "ISNUMBER", "ISBLANK", "AND", "OR", "NOT", "SUM_ABOVE",
}  # fmt: skip


def _one(args: list, i: int, default: object = None) -> object:
    if i >= len(args):
        return default
    v = args[i]
    if isinstance(v, list):
        flat = _flat(v)
        return flat[0] if len(flat) == 1 else XlError("#VALUE!")
    return v


def evaluate(node, env: Env) -> object:
    kind = node[0]
    if kind in ("num", "str"):
        return node[1]
    if kind == "ref":
        rows = env.ref(node[1])
        return rows[0][0] if ":" not in node[1] else rows
    if kind == "sec":
        return env.sec(node[1], node[2], node[3])
    if kind == "neg":
        v = _num(_one([evaluate(node[1], env)], 0))
        return v if isinstance(v, XlError) else -v
    if kind == "pct":
        v = _num(_one([evaluate(node[1], env)], 0))
        return v if isinstance(v, XlError) else v / 100
    if kind == "fn":
        if node[1] == "SUM_ABOVE":
            return env.sum_above()
        if node[1] in ("IF", "IFERROR"):  # lazy, like Excel
            return _lazy(node, env)
        args = [evaluate(a, env) for a in node[2]]
        return _fn(node[1], args, node[2])
    if kind == "bin":
        op = node[1]
        a = _one([evaluate(node[2], env)], 0)
        b = _one([evaluate(node[3], env)], 0)
        if op == "&":
            return f"{_text(a)}{_text(b)}"
        if op in ("=", "<>", "<", ">", "<=", ">="):
            return _compare(op, a, b)
        x, y = _num(a), _num(b)
        if isinstance(x, XlError) or isinstance(y, XlError):
            return x if isinstance(x, XlError) else y
        if op == "+":
            return x + y
        if op == "-":
            return x - y
        if op == "*":
            return x * y
        if op == "/":
            return XlError("#DIV/0!") if y == 0 else x / y
        if op == "^":
            return x**y
    raise AssertionError(kind)


def _lazy(node, env: Env) -> object:
    args = node[2]
    if node[1] == "IF":
        cond = _truthy(_one([evaluate(args[0], env)], 0))
        if isinstance(cond, XlError):
            return cond
        pick = 1 if cond else 2
        if pick < len(args):
            return _one([evaluate(args[pick], env)], 0)
        return cond
    v = _one([evaluate(args[0], env)], 0)
    return _one([evaluate(args[1], env)], 0) if isinstance(v, XlError) and len(args) > 1 else v


def _text(v: object) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _compare(op: str, a: object, b: object) -> bool:
    if isinstance(a, str) and isinstance(b, str):
        a, b = a.lower(), b.lower()
    elif isinstance(a, str) or isinstance(b, str):
        if op in ("=", "<>"):
            return (op == "<>") != (a == b)
        a, b = str(a), str(b)
    else:
        a, b = _num(a), _num(b)
    return {"=": a == b, "<>": a != b, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]


# ---------------------------------------------------------------------- excel output


def to_excel(
    formula: str,
    sec_address: Callable[[int | None, int, int], str],
    sum_above_text: Callable[[], str],
    sheet_name: Callable[[str], str],
) -> str:
    """The formula as the exported sheet carries it: spec-only forms replaced, sheet names as the workbook has them."""
    toks = tokenize(formula)
    parse(formula)  # rejects malformed formulas before anything is written
    out = []
    pos = 1
    body = formula
    i = 0
    while i < len(toks):
        tok = toks[i]
        out.append(body[pos : tok.start])
        if tok.kind == "sec":
            g = tok.groups
            out.append(sec_address(int(g["sec_s"]) if g["sec_s"] else None, int(g["sec_r"]), int(g["sec_c"])))
            pos = tok.end
        elif tok.kind == "fn" and tok.text.upper() == "SUM_ABOVE":
            # SUM_ABOVE ( )
            out.append(sum_above_text())
            pos = toks[i + 2].end
            i += 2
        elif tok.kind == "ref":
            sheet, _, rest = tok.text.rpartition("!")
            real = sheet_name(sheet[1:-1].replace("''", "'") if sheet.startswith("'") else sheet)
            out.append(f"{quote_sheet(real)}!{rest}")
            pos = tok.end
        else:
            out.append(tok.text)
            pos = tok.end
        i += 1
    return "=" + "".join(out).strip()


def quote_sheet(name: str) -> str:
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", name) and not re.fullmatch(r"[A-Za-z]{1,3}\d+", name):
        return name
    return "'" + name.replace("'", "''") + "'"


def address(col: int, row: int) -> str:
    return f"{get_column_letter(col)}{row}"
