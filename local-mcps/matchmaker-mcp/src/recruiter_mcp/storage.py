"""Original resume files on local disk. Keys are relative paths: resumes/{candidate_id}/{Name}_Resume_{sha8}.{ext}."""

import os
import re
import shutil
import tempfile
import unicodedata
from pathlib import Path


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def resume_key(candidate_id: str, sha256: str, ext: str, name: str | None = None) -> str:
        """Readable file name for people opening it, e.g. Priya_Sharma_Resume_3f0c9a1b.pdf. The short hash keeps each
        version of someone's resume distinct; the candidate folder keeps people apart."""
        ascii_name = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
        slug = re.sub(r"[^A-Za-z0-9]+", "_", ascii_name).strip("_")[:60] or "Candidate"
        return f"resumes/{candidate_id}/{slug}_Resume_{sha256[:8]}.{ext}"

    def path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if not p.is_relative_to(self.root):
            raise ValueError("storage key escapes root")
        return p

    def put(self, key: str, data: bytes) -> Path:
        dest = self.path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp file then rename, so a crash never leaves a partial file.
        fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        return dest

    def get(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self.path(key).is_file()

    def delete(self, key: str) -> None:
        self.path(key).unlink(missing_ok=True)

    def delete_candidate(self, candidate_id: str) -> int:
        """Remove every stored file for a candidate (all versions). Returns how many files were removed."""
        d = self.path(f"resumes/{candidate_id}")
        if not d.is_dir():
            return 0
        count = sum(1 for p in d.rglob("*") if p.is_file())
        shutil.rmtree(d)
        return count
