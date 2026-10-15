"""POST /uploads: an agent app sends a chat attachment's bytes, the model then passes the upload_id to
add_document. Stored under DATA_DIR/uploads/<sha256>.<pdf|docx|txt>, the type read from the bytes."""

import hashlib
import io
import re
import zipfile
from pathlib import Path

from .config import Settings
from .errors import ToolFailure

UPLOAD_ID = re.compile(r"[0-9a-f]{64}")
KINDS = ("pdf", "docx", "txt")


def _kind(data: bytes) -> str:
    if data[:5] == b"%PDF-":
        return "pdf"
    if data[:4] == b"PK\x03\x04":
        try:
            names = set(zipfile.ZipFile(io.BytesIO(data)).namelist())
        except zipfile.BadZipFile:
            raise ToolFailure("unsupported_file", "the file is a damaged zip, not a readable document") from None
        if "word/document.xml" in names:
            return "docx"
        raise ToolFailure("unsupported_file", "only PDF, DOCX and plain-text resumes are supported")
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        raise ToolFailure("unsupported_file", "old .doc files are not supported; save it as .docx or PDF and resend")
    if b"\x00" in data[:4096]:
        raise ToolFailure("unsupported_file", "only PDF, DOCX and plain-text resumes are supported")
    return "txt"


def save_upload(settings: Settings, data: bytes) -> tuple[str, str]:
    """Returns (upload_id, kind)."""
    if not data:
        raise ToolFailure("empty_file", "the upload was empty")
    kind = _kind(data)
    digest = hashlib.sha256(data).hexdigest()
    folder = settings.data_dir / "uploads"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{digest}.{kind}"
    if not path.exists():
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    return digest, kind


def upload_path(settings: Settings, upload_id: str) -> Path:
    uid = upload_id.strip().lower()
    if not UPLOAD_ID.fullmatch(uid):
        raise ToolFailure("bad_upload_id", "upload_id is not one this server issued; pass the id from the conversation")
    for kind in KINDS:
        path = settings.data_dir / "uploads" / f"{uid}.{kind}"
        if path.exists():
            return path
    raise ToolFailure("upload_not_found", "no upload with that id; ask the user to attach the file again")
