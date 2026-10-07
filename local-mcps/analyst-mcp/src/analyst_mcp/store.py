"""Files on disk: uploads in, opened workbooks, exports out.

DATA_DIR/uploads/<sha256>.<ext>          bytes the agent app POSTed to /uploads
DATA_DIR/workbooks/<id>/original.xlsx    the workbook every tool reads (a CSV is converted once)
DATA_DIR/workbooks/<id>/meta.json        display name and where it came from
DATA_DIR/workbooks/<id>/exports/         xlsx and png files this server wrote

The original is never written to: exports are copies.
"""

import hashlib
import io
import json
import re
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings
from .errors import ToolFailure

UPLOAD_ID = re.compile(r"^[0-9a-f]{64}$")
WORKBOOK_ID = re.compile(r"^[0-9a-f]{12}$")
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@dataclass
class WorkbookFiles:
    id: str
    dir: Path
    name: str

    @property
    def original(self) -> Path:
        return self.dir / "original.xlsx"

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


def _csv_to_xlsx(data: bytes, sheet: str, target: Path) -> None:
    import pandas as pd

    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    sep = "\t" if text.count("\t") > text.count(",") else ","
    frame = pd.read_csv(io.StringIO(text), sep=sep)
    with pd.ExcelWriter(target, engine="openpyxl") as writer:
        frame.to_excel(writer, sheet_name=sheet[:31] or "Sheet1", index=False)


def open_files(settings: Settings, *, upload_id: str | None, inbox_file: str | None, name: str | None) -> WorkbookFiles:
    """Make (or reuse) the workbook folder for an upload or an inbox file. Same bytes, same id."""
    if bool(upload_id) == bool(inbox_file):
        raise ToolFailure("bad_request", "pass exactly one of upload_id or inbox_file")
    source = _upload_path(settings, upload_id) if upload_id else _inbox_path(settings, inbox_file or "")
    data = source.read_bytes()
    if len(data) > settings.max_file_bytes:
        raise ToolFailure("file_too_large", f"file exceeds {settings.max_file_bytes // (1024 * 1024)} MB")
    kind = _kind(data)
    wid = hashlib.sha256(data).hexdigest()[:12]
    folder = settings.data_dir / "workbooks" / wid
    display = name or (inbox_file if inbox_file else f"workbook-{wid}.{kind}")
    files = WorkbookFiles(id=wid, dir=folder, name=display)
    if not files.original.exists():
        folder.mkdir(parents=True, exist_ok=True)
        if kind == "csv":
            _csv_to_xlsx(data, Path(display).stem, files.original)
        else:
            files.original.write_bytes(data)
        meta = {"name": display, "source": "upload" if upload_id else "inbox", "opened_at": _now()}
        (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    elif name:
        _write_meta(folder, name=name)
    return files


def get_files(settings: Settings, workbook_id: str) -> WorkbookFiles:
    if not WORKBOOK_ID.match(workbook_id or ""):
        raise ToolFailure("bad_workbook_id", "workbook_id is the 12-character id open_workbook returned")
    folder = settings.data_dir / "workbooks" / workbook_id
    if not (folder / "original.xlsx").exists():
        raise ToolFailure("workbook_not_found", "no open workbook with that id; call open_workbook first")
    return WorkbookFiles(id=workbook_id, dir=folder, name=_read_meta(folder).get("name", workbook_id))


def list_workbooks(settings: Settings) -> list[dict]:
    root = settings.data_dir / "workbooks"
    rows = []
    if root.exists():
        for folder in sorted(root.iterdir()):
            if (folder / "original.xlsx").exists():
                meta = _read_meta(folder)
                rows.append(
                    {"workbook_id": folder.name, "name": meta.get("name", ""), "opened_at": meta.get("opened_at")}
                )
    return rows


def list_inbox(settings: Settings) -> list[str]:
    inbox = settings.inbox()
    inbox.mkdir(parents=True, exist_ok=True)
    return sorted(p.name for p in inbox.iterdir() if p.is_file() and p.suffix.lower() in (".xlsx", ".xlsm", ".csv"))


def export_path(files: WorkbookFiles, stem: str, suffix: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9 ._-]+", "", stem).strip() or "export"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return files.exports / f"{safe} {stamp}{suffix}"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _read_meta(folder: Path) -> dict:
    try:
        return json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_meta(folder: Path, **changes) -> None:
    meta = _read_meta(folder) | changes
    (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
