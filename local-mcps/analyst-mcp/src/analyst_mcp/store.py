"""Files on disk: uploads in, projects of files, exports out.

A project is a named folder of files the user works on together ("Dialysis": the rate sheet, the sub-inventory, May,
June and July data). The model passes the project's name to every tool, and a file's name where it matters, so a chat
keeps to its project by naming it and moves to another by naming that one.

DATA_DIR/uploads/<sha256>.<ext>                              bytes the agent app POSTed to /uploads
DATA_DIR/projects/<p>/project.json                           the project's name, when it changed
DATA_DIR/projects/<p>/files/<f>/versions/<n>.xlsx            a file; an edit adds version n+1 (CSV converted once)
DATA_DIR/projects/<p>/files/<f>/file.json                    its name, current version, where it came from
DATA_DIR/projects/<p>/files/<f>/draft.json                   the sheet being built on it a section at a time
DATA_DIR/projects/<p>/exports/                               xlsx and png files this server wrote

A version is never written to once saved: edits add a version, exports are copies.
"""

import hashlib
import io
import json
import re
import shutil
import threading
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings
from .errors import ToolFailure

UPLOAD_ID = re.compile(r"^[0-9a-f]{64}$")
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
NAME_CHARS = 80
SHOWN = 20
EXTENSIONS = (".xlsx", ".xlsm", ".csv")


@dataclass
class Project:
    key: str
    dir: Path
    name: str

    @property
    def exports(self) -> Path:
        path = self.dir / "exports"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def books(self) -> list["Book"]:
        """The project's files, in the order they were added."""
        found = []
        folder = self.dir / "files"
        if folder.exists():
            for sub in folder.iterdir():
                meta = _read(sub / "file.json")
                first = sub / "versions" / "1.xlsx"
                if meta and first.exists():
                    found.append((first.stat().st_mtime_ns, _book(self, sub, meta)))
        return [b for _, b in sorted(found, key=lambda f: (f[0], f[1].key))]


@dataclass
class Book:
    """One file of a project."""

    project: Project
    key: str
    dir: Path
    name: str
    version: int

    @property
    def id(self) -> str:
        """Names this version's loaded workbook in the caches: an edit is a new version, so stale results cannot
        survive it."""
        return f"{self.project.key}/{self.key}@{self.version}"

    @property
    def file(self) -> Path:
        return self.dir / "versions" / f"{self.version}.xlsx"

    @property
    def exports(self) -> Path:
        return self.project.exports


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


def _stem(name: str) -> str:
    return Path(name).stem if name.lower().endswith(EXTENSIONS) else name


def _clean_name(name: str | None, what: str = "project") -> str:
    """The name as the user would say it: spaces tidied, a file extension dropped ('Budget.xlsx' is 'Budget')."""
    cleaned = _stem(" ".join((name or "").split()))
    if not _key(cleaned):
        raise ToolFailure(f"bad_{what}_name", f"a {what} needs a name with letters or digits, e.g. 'Dialysis'")
    return cleaned[:NAME_CHARS]


def _root(settings: Settings) -> Path:
    root = settings.data_dir / "projects"
    if root.exists():
        _migrate(root)
    return root


_migrating = threading.Lock()


def _migrate(root: Path) -> None:
    """A project from before projects held files (projects/<p>/versions/) becomes a project with that one file. Under a
    lock: tools run in threads, and two calls at once would both move the same folder."""
    with _migrating:
        for folder in root.iterdir():
            if (folder / "versions").is_dir():
                _migrate_one(folder)


def _migrate_one(folder: Path) -> None:
    meta = _read(folder / "project.json")
    target = folder / "files" / folder.name
    target.mkdir(parents=True, exist_ok=True)
    (folder / "versions").rename(target / "versions")
    if (folder / "draft.json").exists():
        (folder / "draft.json").rename(target / "draft.json")
    _write(target / "file.json", **{k: v for k, v in meta.items() if k != "updated_at"},
           updated_at=meta.get("updated_at"))  # fmt: skip
    (folder / "project.json").write_text(
        json.dumps({"name": meta.get("name", folder.name), "created_at": meta.get("created_at"),
                    "updated_at": meta.get("updated_at")}, ensure_ascii=False),  # fmt: skip
        encoding="utf-8",
    )


def _project(folder: Path, meta: dict) -> Project:
    return Project(key=folder.name, dir=folder, name=meta.get("name", folder.name))


def _book(project: Project, folder: Path, meta: dict) -> Book:
    return Book(project=project, key=folder.name, dir=folder, name=meta.get("name", folder.name),
                version=int(meta.get("version", 1)))  # fmt: skip


def _touch(project: Project) -> None:
    _write(project.dir / "project.json", updated_at=_now())


def _ensure_project(settings: Settings, name: str | None) -> tuple[Project, bool]:
    """The project named `name`, made when there is none yet."""
    name = _clean_name(name)
    folder = _root(settings) / _key(name)
    meta = _read(folder / "project.json")
    if meta:
        return _project(folder, meta), False
    folder.mkdir(parents=True, exist_ok=True)
    now = _now()
    _write(folder / "project.json", name=name, created_at=now, updated_at=now)
    return Project(key=folder.name, dir=folder, name=name), True


def _put(project: Project, name: str, data: bytes, source: str, digest: str, replace: bool) -> tuple[Book, str]:
    """Store `data` as the file `name` of the project. Returns the file and what happened: "added", "same" (that file
    is already there), "replaced" (a new version of a file with that name)."""
    name = _clean_name(name, "file")
    folder = project.dir / "files" / _key(name)
    meta = _read(folder / "file.json")
    if meta:
        book = _book(project, folder, meta)
        if meta.get("sha256") == digest:
            return book, "same"
        if not replace:
            raise ToolFailure(
                "file_exists",
                f'project "{project.name}" already has a file "{book.name}"; give the new one another name, or '
                "edit_file to change that one",
            )
        return save_version(book, data, source), "replaced"
    (folder / "versions").mkdir(parents=True, exist_ok=True)
    (folder / "versions" / "1.xlsx").write_bytes(data)
    now = _now()
    _write(folder / "file.json", name=name, version=1, source=source, sha256=digest, created_at=now, updated_at=now,
           history=[{"version": 1, "change": source, "at": now}])  # fmt: skip
    _touch(project)
    return Book(project=project, key=folder.name, dir=folder, name=name, version=1), "added"


def add_file(
    settings: Settings, *, project: str | None, upload_id: str | None, inbox_file: str | None, name: str | None
) -> tuple[Book, bool, str]:
    """Put an upload or an inbox file into a project (made when new; named after the file when no name is given).
    The same file again changes nothing; a different file under a name the project has is that file's new version.
    Returns the file, whether the project is new, and what happened to the file."""
    if bool(upload_id) == bool(inbox_file):
        raise ToolFailure("bad_request", "pass exactly one of upload_id or inbox_file")
    source = _upload_path(settings, upload_id) if upload_id else _inbox_path(settings, inbox_file or "")
    data = source.read_bytes()
    if len(data) > settings.max_file_bytes:
        raise ToolFailure("file_too_large", f"file exceeds {settings.max_file_bytes // (1024 * 1024)} MB")
    kind = _kind(data)
    digest = hashlib.sha256(data).hexdigest()
    name = _clean_name(name or inbox_file or f"Spreadsheet {digest[:6]}", "file")
    xlsx = _csv_to_xlsx(data, name) if kind == "csv" else data
    found, new = _ensure_project(settings, project or name)
    book, what = _put(found, name, xlsx, "upload" if upload_id else f"inbox file {inbox_file}", digest, replace=True)
    return book, new, what


def create_file(settings: Settings, project: str | None, name: str, data: bytes) -> Book:
    found, _ = _ensure_project(settings, project or name)
    book, _ = _put(found, name, data, "created", hashlib.sha256(data).hexdigest(), replace=False)
    return book


def save_version(book: Book, data: bytes, change: str) -> Book:
    """The file's next version. The ones before stay on disk as they were."""
    meta = _read(book.dir / "file.json")
    version = max(int(p.stem) for p in (book.dir / "versions").glob("*.xlsx")) + 1
    (book.dir / "versions" / f"{version}.xlsx").write_bytes(data)
    now = _now()
    history = [*meta.get("history", []), {"version": version, "change": change, "at": now}]
    _write(book.dir / "file.json", version=version, updated_at=now, history=history,
           sha256=hashlib.sha256(data).hexdigest())  # fmt: skip
    _touch(book.project)
    return Book(project=book.project, key=book.key, dir=book.dir, name=book.name, version=version)


def _match(items: list, name: str, key) -> list:
    """Items whose name is `name`, else those whose name holds it or is held by it ('budget' for 'Q3 Budget')."""
    wanted = _key(_stem(name)) if name else ""
    if not wanted:
        return []
    exact = [i for i in items if key(i) == wanted]
    return exact or [i for i in items if wanted in key(i) or key(i) in wanted]


def get_project(settings: Settings, name: str, forgive: bool = True) -> Project:
    """The project the model named. With `forgive`, a name that matches none means the only project when there is
    just one: the model sometimes passes a file name instead."""
    projects = list_projects(settings)
    close = _match(projects, name, lambda p: p.key)
    if not close:
        # A file's name finds the project holding it.
        close = list({b.project.key: b.project for p in projects for b in _match(p.books(), name, lambda b: b.key)}
                     .values())  # fmt: skip
    if len(close) == 1:
        return close[0]
    if len(close) > 1:
        raise ToolFailure("project_unclear", f"{name!r} could be " + _names(close) + "; ask which")
    if forgive and len(projects) == 1:
        return projects[0]
    said = f"no project named {name!r}" if name and name.strip() else "say which project"
    raise ToolFailure("project_not_found", said + known(projects))


def get_book(settings: Settings, project: str, file: str | None = None, sheets: tuple[str, ...] = ()) -> Book:
    """A file of the project. Without `file`, the only file, or the only one with all of `sheets` (the sheets the
    call names)."""
    found = get_project(settings, project)
    books = found.books()
    if not books:
        raise ToolFailure("no_files", f'project "{found.name}" has no files yet: open_file or create_file')
    if file:
        close = _match(books, file, lambda b: b.key)
        if len(close) == 1:
            return close[0]
        if len(books) == 1:
            return books[0]
        said = f"{file!r} could be " if close else f'project "{found.name}" has no file {file!r}; its files are '
        raise ToolFailure("file_not_found", said + _names(close or books))
    if len(books) == 1:
        return books[0]
    if sheets:
        wanted = {s.strip().lower() for s in sheets}
        holding = [b for b in books if wanted <= {s.lower() for s in sheet_names(b)}]
        if len(holding) == 1:
            return holding[0]
    raise ToolFailure(
        "file_needed", f'project "{found.name}" has several files; pass `file`, one of ' + _names(books)
    )


def sheet_names(book: Book) -> list[str]:
    import openpyxl

    wb = openpyxl.load_workbook(book.file, read_only=True)
    try:
        return list(wb.sheetnames)
    finally:
        wb.close()


def _names(items: list) -> str:
    shown = ", ".join(f'"{i.name}"' for i in items[:SHOWN])
    return shown + (f" and {len(items) - SHOWN} more" if len(items) > SHOWN else "")


def known(projects: list[Project]) -> str:
    """The projects, so a model can pick the one the user means, or ask."""
    if not projects:
        return "; there are no projects yet: open_file for an attached file, create_file for a new one"
    return f". Projects: {_names(projects)}. Pick the one the user means; if unsure, ask them"


def list_projects(settings: Settings) -> list[Project]:
    """Every project, the one changed last first."""
    root = _root(settings)
    found = []
    if root.exists():
        for folder in root.iterdir():
            meta = _read(folder / "project.json")
            if meta:
                found.append((meta.get("updated_at") or "", _project(folder, meta)))
    return [p for _, p in sorted(found, key=lambda f: f[0], reverse=True)]


def info(item: Project | Book) -> dict:
    return _read(item.dir / ("project.json" if isinstance(item, Project) else "file.json"))


def move_file(settings: Settings, book: Book, to: str) -> tuple[Book, bool]:
    """Move a file, with its versions and draft, into another project (made when new)."""
    target, new = _ensure_project(settings, to)
    if target.key == book.project.key:
        return book, False
    dest = target.dir / "files" / book.key
    if dest.exists():
        raise ToolFailure("file_exists", f'project "{target.name}" already has a file "{book.name}"')
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(book.dir), str(dest))
    _touch(target)
    if not book.project.books():
        shutil.rmtree(book.project.dir)  # a project left with no files is gone
    else:
        _touch(book.project)
    return Book(project=target, key=book.key, dir=dest, name=book.name, version=book.version), new


def remove_file(settings: Settings, book: Book) -> None:
    """Delete one file (every version, its draft) and the upload it came from. Inbox files stay."""
    _forget_upload(settings, _read(book.dir / "file.json").get("sha256", ""))
    shutil.rmtree(book.dir)
    _touch(book.project)


def delete_project(settings: Settings, project: Project) -> None:
    """Delete the project: every file, draft and export, and the uploads they came from. Inbox files stay."""
    for book in project.books():
        _forget_upload(settings, _read(book.dir / "file.json").get("sha256", ""))
    shutil.rmtree(project.dir)


def _forget_upload(settings: Settings, digest: str) -> None:
    if UPLOAD_ID.match(digest):
        for path in (settings.data_dir / "uploads").glob(f"{digest}.*"):
            path.unlink(missing_ok=True)


def has_macros(path: Path) -> bool:
    with zipfile.ZipFile(path) as z:
        return "xl/vbaProject.bin" in z.namelist()


def list_inbox(settings: Settings) -> list[str]:
    inbox = settings.inbox()
    inbox.mkdir(parents=True, exist_ok=True)
    return sorted(p.name for p in inbox.iterdir() if p.is_file() and p.suffix.lower() in (".xlsx", ".xlsm", ".csv"))


def load_draft(book: Book) -> dict | None:
    """The sheet being built a section at a time. Kept here because the agent does not carry tool results from one
    turn to the next."""
    path = book.dir / "draft.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


_draft_locks: dict[Path, threading.Lock] = {}
_draft_locks_guard = threading.Lock()


def draft_lock(book: Book) -> threading.Lock:
    """Held across a draft's read-change-save. Tools run in threads and a model calls add_section several times at
    once; unlocked, each saves its own copy and the overlapping writes left a draft no tool could read."""
    with _draft_locks_guard:
        return _draft_locks.setdefault(book.dir.resolve(), threading.Lock())


def save_draft(book: Book, spec: dict) -> None:
    """Written whole to a temporary file and swapped in, so a reader never meets half a draft."""
    path = book.dir / "draft.json"
    tmp = path.with_name(f"draft.json.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def clear_draft(book: Book) -> None:
    (book.dir / "draft.json").unlink(missing_ok=True)


def export_path(item: Project | Book, stem: str, suffix: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9 ._-]+", "", stem).strip() or "export"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return item.exports / f"{safe} {stamp}{suffix}"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _read(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write(path: Path, **changes) -> None:
    path.write_text(json.dumps(_read(path) | changes, ensure_ascii=False), encoding="utf-8")
