"""Files on disk: uploads in, projects, exports out.

A project is one Excel file under a name the user knows. The model passes that name to every tool, so a chat keeps to
its project by naming it, and moves to another by naming that one.

DATA_DIR/uploads/<sha256>.<ext>              bytes the agent app POSTed to /uploads
DATA_DIR/projects/<key>/versions/<n>.xlsx    the file; an edit adds version n+1 (a CSV is converted once)
DATA_DIR/projects/<key>/project.json         name, current version, where it came from
DATA_DIR/projects/<key>/draft.json           the sheet being built a section at a time
DATA_DIR/projects/<key>/exports/             xlsx and png files this server wrote

A version is never written to once saved: edits add a version, exports are copies.
"""

import hashlib
import io
import json
import re
import shutil
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings
from .errors import ToolFailure

UPLOAD_ID = re.compile(r"^[0-9a-f]{64}$")
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
NAME_CHARS = 80
SHOWN_PROJECTS = 20


@dataclass
class Project:
    key: str
    dir: Path
    name: str
    version: int

    @property
    def id(self) -> str:
        """Names this version's loaded workbook in the caches: an edit is a new version, so stale results cannot
        survive it."""
        return f"{self.key}@{self.version}"

    @property
    def file(self) -> Path:
        return self.dir / "versions" / f"{self.version}.xlsx"

    @property
    def exports(self) -> Path:
        path = self.dir / "exports"
        path.mkdir(parents=True, exist_ok=True)
        return path


def _kind(data: bytes) -> str:
    """xlsx, xlsm or csv, from the bytes themselves; anything else is refused with a hint."""
    if data[:4] == b"PK\x03\x04":
        try:
            names = set(zipfile.ZipFile(io.BytesIO(data)).namelist())
        except zipfile.BadZipFile as e:
            raise ToolFailure("unsupported_file", "the file is a damaged zip, not a readable workbook") from e
        if "xl/workbook.xml" in names:
            return "xlsm" if "xl/vbaProject.bin" in names else "xlsx"
        if "content.xml" in names:
            raise ToolFailure("unsupported_file", "OpenDocument (.ods) is not supported; save it as .xlsx and resend")
        raise ToolFailure("unsupported_file", "the file is a zip but not an Excel workbook")
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        raise ToolFailure("unsupported_file", "old .xls files are not supported; save it as .xlsx and resend")
    if b"\x00" in data[:4096]:
        raise ToolFailure("unsupported_file", "only .xlsx, .xlsm and .csv files are supported")
    return "csv"


def save_upload(settings: Settings, data: bytes) -> tuple[str, str]:
    """Store uploaded bytes under their sha256. Returns (upload_id, kind)."""
    if not data:
        raise ToolFailure("empty_file", "the upload was empty")
    kind = _kind(data)
    digest = hashlib.sha256(data).hexdigest()
    folder = settings.data_dir / "uploads"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{digest}.{kind}"
    if not path.exists():
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    return digest, kind


def _upload_path(settings: Settings, upload_id: str) -> Path:
    if not UPLOAD_ID.match(upload_id):
        raise ToolFailure("bad_upload_id", "upload_id is not one this server issued; pass the id from the conversation")
    for kind in ("xlsx", "xlsm", "csv"):
        path = settings.data_dir / "uploads" / f"{upload_id}.{kind}"
        if path.exists():
            return path
    raise ToolFailure("upload_not_found", "no upload with that id; ask the user to attach the file again")


def _inbox_path(settings: Settings, name: str) -> Path:
    inbox = settings.inbox().resolve()
    path = (inbox / name).resolve()
    # Only files directly in the inbox: a name can never reach the rest of the machine.
    if path.parent != inbox or not path.is_file():
        raise ToolFailure("inbox_file_not_found", f"no file named {name!r} in the inbox folder {inbox}")
    return path


def _csv_to_xlsx(data: bytes, sheet: str) -> bytes:
    import pandas as pd

    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    sep = "\t" if text.count("\t") > text.count(",") else ","
    frame = pd.read_csv(io.StringIO(text), sep=sep)
    out = io.BytesIO()
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        frame.to_excel(writer, sheet_name=sheet[:31] or "Sheet1", index=False)
    return out.getvalue()


def _key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]


def _clean_name(name: str | None) -> str:
    """The name as the user would say it: spaces tidied, a file extension dropped ('Budget.xlsx' is 'Budget')."""
    cleaned = " ".join((name or "").split())
    if cleaned.lower().endswith((".xlsx", ".xlsm", ".csv")):
        cleaned = Path(cleaned).stem
    if not _key(cleaned):
        raise ToolFailure("bad_project_name", "a project needs a name with letters or digits, e.g. 'Q3 budget'")
    return cleaned[:NAME_CHARS]


def _root(settings: Settings) -> Path:
    return settings.data_dir / "projects"


def _project(folder: Path, meta: dict) -> Project:
    return Project(key=folder.name, dir=folder, name=meta.get("name", folder.name), version=int(meta.get("version", 1)))


def start(
    settings: Settings, name: str | None, data: bytes, source: str, digest: str | None = None
) -> tuple[Project, bool]:
    """A new project holding `data` as version 1, and whether it is new. Starting it again from the same file is the
    same project; another file under a name already taken is refused, so no project is replaced by accident."""
    name = _clean_name(name)
    digest = digest or hashlib.sha256(data).hexdigest()
    folder = _root(settings) / _key(name)
    if (folder / "project.json").exists():
        meta = _read_meta(folder)
        if meta.get("sha256") == digest:
            return _project(folder, meta), False
        raise ToolFailure(
            "project_exists",
            f'there is already a project "{meta.get("name", name)}"; give this one another name, or switch_to_project '
            "to work on that one",
        )
    (folder / "versions").mkdir(parents=True, exist_ok=True)
    (folder / "versions" / "1.xlsx").write_bytes(data)
    now = _now()
    meta = {"name": name, "version": 1, "source": source, "sha256": digest, "created_at": now, "updated_at": now,
            "history": [{"version": 1, "change": source, "at": now}]}  # fmt: skip
    _write_meta(folder, **meta)
    return _project(folder, meta), True


def open_file(
    settings: Settings, *, upload_id: str | None, inbox_file: str | None, name: str | None
) -> tuple[Project, bool]:
    """A project from an upload or an inbox file, named `name` or after the file."""
    if bool(upload_id) == bool(inbox_file):
        raise ToolFailure("bad_request", "pass exactly one of upload_id or inbox_file")
    source = _upload_path(settings, upload_id) if upload_id else _inbox_path(settings, inbox_file or "")
    data = source.read_bytes()
    if len(data) > settings.max_file_bytes:
        raise ToolFailure("file_too_large", f"file exceeds {settings.max_file_bytes // (1024 * 1024)} MB")
    kind = _kind(data)
    digest = hashlib.sha256(data).hexdigest()
    name = _clean_name(name or inbox_file or f"Spreadsheet {digest[:6]}")
    xlsx = _csv_to_xlsx(data, name) if kind == "csv" else data
    return start(settings, name, xlsx, "upload" if upload_id else f"inbox file {inbox_file}", digest)


def save_version(settings: Settings, project: Project, data: bytes, change: str) -> Project:
    """The project's next version. The ones before stay on disk as they were."""
    meta = _read_meta(project.dir)
    version = max(int(p.stem) for p in (project.dir / "versions").glob("*.xlsx")) + 1
    (project.dir / "versions" / f"{version}.xlsx").write_bytes(data)
    now = _now()
    history = [*meta.get("history", []), {"version": version, "change": change, "at": now}]
    _write_meta(project.dir, version=version, updated_at=now, history=history)
    return Project(key=project.key, dir=project.dir, name=project.name, version=version)


def has_macros(path: Path) -> bool:
    with zipfile.ZipFile(path) as z:
        return "xl/vbaProject.bin" in z.namelist()


def get(settings: Settings, name: str, forgive: bool = True) -> Project:
    """The project the model named. A close name finds it ('budget' for 'Q3 Budget', the file name for the project
    named after it). With `forgive`, a name that matches none means the only project when there is just one: the model
    sometimes passes the file name it saw instead."""
    projects = list_projects(settings)
    wanted = _key(Path(name).stem if name.lower().endswith((".xlsx", ".xlsm", ".csv")) else name) if name else ""
    if wanted:
        exact = [p for p in projects if p.key == wanted]
        close = exact or [p for p in projects if wanted in p.key or p.key in wanted]
        if len(close) == 1:
            return close[0]
        if len(close) > 1:
            raise ToolFailure(
                "project_unclear", f"{name!r} could be " + ", ".join(f'"{p.name}"' for p in close) + "; ask which"
            )
    if forgive and len(projects) == 1:
        return projects[0]
    said = f"no project named {name!r}" if wanted else "say which project"
    raise ToolFailure("project_not_found", said + known(projects))


def known(projects: list[Project]) -> str:
    """The projects, so a model can ask the user which one is meant."""
    if not projects:
        return "; there are no projects yet: open_file for an attached file, create_project for a new one"
    shown = ", ".join(f'"{p.name}"' for p in projects[:SHOWN_PROJECTS])
    more = f" and {len(projects) - SHOWN_PROJECTS} more" if len(projects) > SHOWN_PROJECTS else ""
    return f". Projects: {shown}{more}. If the user has not said which, ask them"


def list_projects(settings: Settings) -> list[Project]:
    """Every project, the one changed last first."""
    root = _root(settings)
    found = []
    if root.exists():
        for folder in root.iterdir():
            meta = _read_meta(folder)
            if meta:
                found.append((meta.get("updated_at") or "", _project(folder, meta)))
    return [p for _, p in sorted(found, key=lambda f: f[0], reverse=True)]


def info(project: Project) -> dict:
    return _read_meta(project.dir)


def list_inbox(settings: Settings) -> list[str]:
    inbox = settings.inbox()
    inbox.mkdir(parents=True, exist_ok=True)
    return sorted(p.name for p in inbox.iterdir() if p.is_file() and p.suffix.lower() in (".xlsx", ".xlsm", ".csv"))


def load_draft(project: Project) -> dict | None:
    """The sheet being built a section at a time. Kept here because the agent does not carry tool results from one
    turn to the next."""
    path = project.dir / "draft.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def save_draft(project: Project, spec: dict) -> None:
    (project.dir / "draft.json").write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")


def clear_draft(project: Project) -> None:
    (project.dir / "draft.json").unlink(missing_ok=True)


def delete(settings: Settings, project: Project) -> None:
    """Delete the project's folder (every version, draft, exports) and the upload it came from, which is named by
    the sha256 the project keeps. Inbox files are the user's own and stay."""
    digest = _read_meta(project.dir).get("sha256", "")
    shutil.rmtree(project.dir)
    if UPLOAD_ID.match(digest):
        for path in (settings.data_dir / "uploads").glob(f"{digest}.*"):
            path.unlink(missing_ok=True)


def export_path(project: Project, stem: str, suffix: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9 ._-]+", "", stem).strip() or "export"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return project.exports / f"{safe} {stamp}{suffix}"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _read_meta(folder: Path) -> dict:
    try:
        return json.loads((folder / "project.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_meta(folder: Path, **changes) -> None:
    meta = _read_meta(folder) | changes
    (folder / "project.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
