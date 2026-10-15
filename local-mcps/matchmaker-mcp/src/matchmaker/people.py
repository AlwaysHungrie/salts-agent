"""People are folders: DATA_DIR/people/<person_id>/ holds each original file, its text, the admin's notes
(notes.txt, added to, never replaced), the profile the server writes (profile.md, no contact details), person.json
and the profile's embedding. Adding a document or a note rewrites the profile from all of the person's documents
in one model call."""

import hashlib
import json
import logging
import re
import shutil
import uuid
from datetime import date
from pathlib import Path

import numpy as np

from .documents import read_text
from .errors import ToolFailure
from .models import Person, PersonResult, Profile
from .prompts import render
from .services import Services

log = logging.getLogger(__name__)

DOC_KINDS = ("resume", "cover_letter")  # one of each, a new one replaces the old
KINDS = (*DOC_KINDS, "notes")  # every text a profile, search and the judge read
_ID = re.compile(r"[0-9a-f]{32}")
_BLANK = {"", "null", "none", "unknown", "n/a", "na", "-"}  # what models write for a missing name or contact


def _clean(value: str | None) -> str | None:
    return None if value is None or value.strip().lower() in _BLANK else value.strip()


def people_dir(svc: Services) -> Path:
    return svc.settings.data_dir / "people"


def person_dir(svc: Services, person_id: str) -> Path:
    if not _ID.fullmatch(person_id or ""):
        raise ToolFailure("invalid_input", "person_id is not a valid id")
    return people_dir(svc) / person_id


def render_profile(p: Profile) -> str:
    """profile.md: what search indexes and embeds and what a page shows. Contact details stay in person.json."""
    def line(label: str, value) -> str | None:
        return f"- {label}: {value}" if value not in (None, "", []) else None

    years = f"{p.years_experience:g} years" if p.years_experience is not None else "unknown"
    relocate = p.open_to_relocate + (f" ({p.relocation_note})" if p.relocation_note else "")
    facts = [
        line("Current title", p.current_title), line("Seniority", p.seniority),
        line("Location", p.location or "unknown"), line("Open to relocate", relocate),
        line("Work mode", p.work_mode), line("Experience", years),
        line("Work authorization", p.work_authorization), line("Notice period", p.notice_period),
        line("Languages", ", ".join(p.languages)), line("Education", p.education),
        line("Industries", ", ".join(p.industries)), line("Skills", ", ".join(p.skills)),
        line("Notes", "; ".join(p.notes)),
    ]
    return "\n".join([f"# {p.headline}", "", *[f for f in facts if f], "", p.summary.strip()]) + "\n"


def _write(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    if isinstance(data, bytes):
        tmp.write_bytes(data)
    else:
        tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)


def _meta(folder: Path) -> dict:
    return json.loads((folder / "person.json").read_text(encoding="utf-8"))


async def add_document(svc: Services, kind: str = "resume", *, text: str | None = None,
                       file_path: str | Path | None = None, person_id: str | None = None) -> PersonResult:
    """A resume or cover letter for a new person, or for `person_id` (replacing their earlier one of that kind).
    Send the file (`file_path`: PDF, DOCX, TXT, MD), its text, or both; the file's own text wins when it has one,
    and `text` is used for a file with none (a scanned PDF), whose original is still kept."""
    if kind not in DOC_KINDS:
        raise ToolFailure("invalid_input", f"kind must be one of {', '.join(DOC_KINDS)}")
    source = Path(file_path) if file_path else None
    if source is not None:
        try:
            text = read_text(source)
        except ToolFailure as e:
            if not (e.code == "invalid_input" and source.is_file() and (text or "").strip()):
                raise
    text = (text or "").strip()
    if not text:
        raise ToolFailure("invalid_input", "the document has no text")
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()

    if person_id is not None:
        folder = person_dir(svc, person_id)
        if not (folder / "person.json").is_file():
            raise ToolFailure("not_found", "no person with that id")
        meta = _meta(folder)
        if meta["documents"].get(kind, {}).get("sha256") == sha:
            return _result(meta, folder, "unchanged")
    else:
        person_id = uuid.uuid4().hex
        folder = person_dir(svc, person_id)
        meta = {"person_id": person_id, "documents": {}}

    docs = _texts(folder, meta, skip=kind) | {kind: text}
    profile, profile_md, vec = await _profile(svc, docs)

    # Every model call is done: only now does anything reach the disk.
    original = f"{kind}{source.suffix.lower()}" if source is not None else None
    for old in folder.glob(f"{kind}.*"):  # the replaced document's original
        if old.suffix != ".txt" and old.name != original:
            old.unlink()
    if source is not None:
        folder.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, folder / (original + ".tmp"))
        (folder / (original + ".tmp")).replace(folder / original)
    _write(folder / f"{kind}.txt", text)
    status = "updated" if meta["documents"] else "created"
    meta["documents"][kind] = {"sha256": sha, "original": original}
    _save(folder, meta, profile, profile_md, vec)
    log.info("person %s %s (%s)", person_id, status, kind)
    return _result(meta, folder, status)


async def add_note(svc: Services, person_id: str, text: str) -> PersonResult:
    """The admin's own fact about a person ("open to relocating to Berlin", "single, open to dating"), dated and
    added to their notes. Notes win over the documents when the profile is rewritten."""
    text = " ".join(text.split())
    if not text:
        raise ToolFailure("invalid_input", "the note is empty")
    folder = person_dir(svc, person_id)
    if not (folder / "person.json").is_file():
        raise ToolFailure("not_found", "no person with that id")
    meta = _meta(folder)
    notes_file = folder / "notes.txt"
    earlier = notes_file.read_text(encoding="utf-8").rstrip() if notes_file.is_file() else ""
    notes = (earlier + "\n" if earlier else "") + f"[{date.today().isoformat()}] {text}\n"
    profile, profile_md, vec = await _profile(svc, _texts(folder, meta, skip="notes") | {"notes": notes})
    _write(notes_file, notes)
    meta["documents"]["notes"] = {"sha256": hashlib.sha256(notes.encode("utf-8")).hexdigest(), "original": None}
    _save(folder, meta, profile, profile_md, vec)
    log.info("person %s note added", person_id)
    return _result(meta, folder, "updated")


def _texts(folder: Path, meta: dict, skip: str) -> dict[str, str]:
    return {k: (folder / f"{k}.txt").read_text(encoding="utf-8") for k in meta["documents"] if k != skip}


async def _profile(svc: Services, docs: dict[str, str]) -> tuple[Profile, str, list[float]]:
    documents = "\n\n".join(f'<document kind="{k}">\n{docs[k]}\n</document>' for k in KINDS if k in docs)
    system, user = render("profile", documents=documents)
    profile = await svc.llm.structured(system, user, Profile, name="person_profile")
    profile_md = render_profile(profile)
    [vec] = await svc.embedder.embed([profile_md])
    return profile, profile_md, vec


def _save(folder: Path, meta: dict, profile: Profile, profile_md: str, vec: list[float]) -> None:
    _write(folder / "profile.md", profile_md)
    buf = folder / "embedding.npy.tmp"
    with buf.open("wb") as f:
        np.save(f, np.asarray(vec, dtype=np.float32))
    buf.replace(folder / "embedding.npy")
    meta.update(name=_clean(profile.name), email=_clean(profile.email), phone=_clean(profile.phone),
                profile=profile.model_dump(exclude={"name", "email", "phone"}))
    _write(folder / "person.json", json.dumps(meta, indent=1, ensure_ascii=False))


def _result(meta: dict, folder: Path, status: str) -> PersonResult:
    return PersonResult(status=status, person_id=meta["person_id"], name=meta.get("name"),
                        headline=meta["profile"]["headline"], folder=str(folder))


def get_person(svc: Services, person_id: str) -> Person:
    folder = person_dir(svc, person_id)
    if not (folder / "person.json").is_file():
        raise ToolFailure("not_found", "no person with that id")
    meta = _meta(folder)
    return Person(person_id=person_id, name=meta.get("name"), email=meta.get("email"), phone=meta.get("phone"),
                  documents=[k for k in KINDS if k in meta["documents"]],
                  profile=(folder / "profile.md").read_text(encoding="utf-8"), folder=str(folder))


def delete_person(svc: Services, person_id: str) -> None:
    folder = person_dir(svc, person_id)
    if not (folder / "person.json").is_file():
        raise ToolFailure("not_found", "no person with that id")
    shutil.rmtree(folder)
