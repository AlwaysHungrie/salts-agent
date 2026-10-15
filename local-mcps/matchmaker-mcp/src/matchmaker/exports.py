"""Exports and the reset. An export is one zip under DATA_DIR/exports/<export_id>/: a CSV with a row per person (or
job) and every person's (or job's) own files, handed to the user as a share link (links.py). Exports older than a
link's lifetime are removed when the next one is made.

The reset wipes everything the server holds. It takes two calls: the first returns a one-time code for the user to
type back, the second, with that code, deletes."""

import csv
import io
import json
import re
import secrets
import shutil
import time
import uuid
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from . import links
from .errors import ToolFailure
from .people import people_dir
from .services import Services

PEOPLE_COLUMNS = ["person_id", "name", "email", "phone", "headline", "current_title", "seniority", "location",
                  "open_to_relocate", "relocation_note", "work_mode", "years_experience", "work_authorization",
                  "notice_period", "languages", "education", "industries", "skills", "notes", "summary", "documents",
                  "folder_in_zip"]
JOB_COLUMNS = ["job_id", "title", "posted_at", "role_type", "core_work", "must_haves", "years_needed", "folder_in_zip"]
_EXPORT_ID = re.compile(r"[0-9a-f]{32}")
CONFIRM_SECONDS = 600


def exports_dir(svc: Services) -> Path:
    return svc.settings.data_dir / "exports"


def _folder_name(label: str | None, item_id: str) -> str:
    """`Amir_Soto_3f0c9a1b`: readable, unique, safe in every file system."""
    clean = re.sub(r"[^A-Za-z0-9]+", "_", label or "").strip("_")[:60]
    return f"{clean}_{item_id[:8]}" if clean else item_id[:8]


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    return str(value)


def _csv(columns: list[str], rows: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    w.writeheader()
    for row in rows:
        w.writerow({k: _cell(row.get(k)) for k in columns})
    return ("﻿" + buf.getvalue()).encode("utf-8")  # the BOM makes Excel read it as UTF-8


def _prune(svc: Services) -> None:
    cutoff = time.time() - svc.settings.link_ttl_hours * 3600
    for old in exports_dir(svc).iterdir() if exports_dir(svc).is_dir() else []:
        if old.is_dir() and old.stat().st_mtime < cutoff:
            shutil.rmtree(old, ignore_errors=True)


def _write_zip(svc: Services, filename: str, fill) -> tuple[str, Path]:
    _prune(svc)
    export_id = uuid.uuid4().hex
    folder = exports_dir(svc) / export_id
    folder.mkdir(parents=True)
    path = folder / filename
    tmp = path.with_name(path.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        fill(z)
    tmp.replace(path)
    return export_id, path


def export_file(svc: Services, export_id: str) -> Path | None:
    if not _EXPORT_ID.fullmatch(export_id or ""):
        return None
    folder = exports_dir(svc) / export_id
    found = [p for p in folder.glob("*.zip")] if folder.is_dir() else []
    return found[0] if found else None


def export_people(svc: Services) -> tuple[str, Path, int]:
    """(export_id, zip, people): people.csv and people/<Name_id>/ with each person's files."""
    root = people_dir(svc)
    folders = sorted(f for f in root.iterdir() if (f / "person.json").is_file()) if root.is_dir() else []

    def fill(z: zipfile.ZipFile) -> None:
        rows = []
        for f in folders:
            meta = json.loads((f / "person.json").read_text(encoding="utf-8"))
            inner = f"people/{_folder_name(meta.get('name'), meta['person_id'])}"
            rows.append({**(meta.get("profile") or {}), "person_id": meta["person_id"], "name": meta.get("name"),
                         "email": meta.get("email"), "phone": meta.get("phone"),
                         "documents": list(meta.get("documents", {})), "folder_in_zip": inner})
            for file in links.person_files(f):
                z.write(file, f"{inner}/{file.name}")
        z.writestr("people.csv", _csv(PEOPLE_COLUMNS, rows))

    export_id, path = _write_zip(svc, f"matchmaker-people-{datetime.now(UTC):%Y-%m-%d}.zip", fill)
    return export_id, path, len(folders)


def export_jobs(svc: Services) -> tuple[str, Path, int]:
    """(export_id, zip, jobs): jobs.csv and jobs/<Title_id>/job.md, the posting as sent."""
    root = svc.settings.data_dir / "jobs"
    folders = sorted(f for f in root.iterdir() if (f / "job.json").is_file()) if root.is_dir() else []

    def fill(z: zipfile.ZipFile) -> None:
        rows = []
        for f in folders:
            meta = json.loads((f / "job.json").read_text(encoding="utf-8"))
            core = json.loads((f / "core.json").read_text(encoding="utf-8")) if (f / "core.json").is_file() else {}
            inner = f"jobs/{_folder_name(meta.get('title'), meta['job_id'])}"
            posted = datetime.fromtimestamp((f / "job.json").stat().st_mtime, UTC).strftime("%Y-%m-%d %H:%M")
            rows.append({**core, **meta, "posted_at": posted, "folder_in_zip": inner})
            if (f / "job.md").is_file():
                z.write(f / "job.md", f"{inner}/job.md")
        z.writestr("jobs.csv", _csv(JOB_COLUMNS, rows))

    export_id, path = _write_zip(svc, f"matchmaker-jobs-{datetime.now(UTC):%Y-%m-%d}.zip", fill)
    return export_id, path, len(folders)


# ---------------------------------------------------------------- reset


@dataclass
class Holdings:
    people: int
    jobs: int
    inbox_files: int


def holdings(svc: Services, inbox: Path) -> Holdings:
    root = svc.settings.data_dir
    count = lambda d, f: sum(1 for p in d.iterdir() if (p / f).is_file()) if d.is_dir() else 0  # noqa: E731
    files = sum(1 for p in inbox.rglob("*") if p.is_file()) if inbox.is_dir() else 0
    return Holdings(people=count(root / "people", "person.json"), jobs=count(root / "jobs", "job.json"),
                    inbox_files=files)


class ResetCodes:
    """One code at a time, single use, for CONFIRM_SECONDS. Kept in memory: a restart voids it."""

    def __init__(self) -> None:
        self.code: str | None = None
        self.expires = 0.0

    def issue(self) -> str:
        # Letters and digits that cannot be misread for one another.
        self.code = "".join(secrets.choice("ACDEFHJKMNPRTWXY34679") for _ in range(6))
        self.expires = time.time() + CONFIRM_SECONDS
        return self.code

    def redeem(self, code: str) -> bool:
        given = re.sub(r"[^A-Z0-9]", "", (code or "").upper()).removeprefix("RESET")
        ok = self.code is not None and time.time() < self.expires and secrets.compare_digest(given, self.code)
        self.code = None  # a wrong guess spends the code too
        return ok


def wipe(svc: Services, inbox: Path) -> None:
    """Every person, job, upload, export and inbox file, and the inbox ledger."""
    root = svc.settings.data_dir.resolve()
    if root == Path(root.anchor) or root == Path.home().resolve():
        raise ToolFailure("refused", "the data folder is a whole drive or the home folder; not wiping it")
    for child in root.iterdir() if root.is_dir() else []:
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    for child in inbox.iterdir() if inbox.is_dir() else []:  # an inbox set elsewhere (MM_INBOX_DIR)
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    svc.index = None
