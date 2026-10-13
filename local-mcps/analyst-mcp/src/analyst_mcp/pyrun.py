"""run_python: the agent's own Python against a copy of the workbook, for what the other tools cannot do.

This runs model-written code on this machine. It is off unless ALLOW_PYTHON=true. The code runs in a fresh folder
with a copy of the workbook, an emptied environment and a time limit; that keeps it from touching the original
and from running forever, but it is not a security sandbox, which is why it is off by default.
"""

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .store import Book, export_path

PRELUDE = """\
import pandas as pd
INPUT = "input.xlsx"   # a copy of the workbook
OUT = "out"            # write charts (.png) and files (.xlsx, .csv) here to give them to the user
"""


@dataclass
class RunResult:
    exit_code: int | None
    output: str
    images: list[Path] = field(default_factory=list)
    files: list[Path] = field(default_factory=list)
    folder: Path | None = None


def run(book: Book, code: str, timeout: int) -> RunResult:
    folder = export_path(book, "python run", "")
    (folder / "out").mkdir(parents=True)
    shutil.copyfile(book.file, folder / "input.xlsx")
    (folder / "script.py").write_text(PRELUDE + "\n" + code, encoding="utf-8")
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(folder),
        "MPLBACKEND": "Agg",
        # Shared across runs: matplotlib otherwise rebuilds its font cache in every fresh HOME.
        "MPLCONFIGDIR": str(book.project.dir.parent.parent / ".mplconfig"),
        "PYTHONIOENCODING": "utf-8",
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),  # Windows needs it to start Python at all
    }
    try:
        proc = subprocess.run(
            [sys.executable, "-I", "script.py"],
            cwd=folder,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        code_, output = proc.returncode, (proc.stdout + ("\n" + proc.stderr if proc.stderr else "")).strip()
    except subprocess.TimeoutExpired as e:
        partial = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else e.stdout or ""
        code_, output = None, f"{partial}\n[stopped after {timeout} s]".strip()
    if len(output) > 8000:
        output = output[:4000] + "\n…\n" + output[-4000:]
    made = sorted(p for p in (folder / "out").rglob("*") if p.is_file())
    return RunResult(
        exit_code=code_,
        output=output,
        images=[p for p in made if p.suffix.lower() == ".png"][:8],
        files=[p for p in made if p.suffix.lower() in (".xlsx", ".csv")][:4],
        folder=folder,
    )
