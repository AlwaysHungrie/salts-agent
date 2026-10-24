"""People are folders: DATA_DIR/people/<person_id>/. entries.json is what the person added, each text or link one
entry they can delete on its own; changing it calls no model. save_profile is the only step that does: the model
writes the profile from the entries, it is embedded, and profile.json (profile, links, their texts) and
embedding.npy are what search and get_person read. So a change reaches search when it is saved."""

import hashlib
import json
import logging
import re
import shutil
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

from .errors import ToolFailure
from .models import Entry, MyInfo, Person, Profile
from .prompts import render
from .services import Services

log = logging.getLogger(__name__)

_ID = re.compile(r"[0-9a-f]{32}")


def people_dir(svc: Services) -> Path:
    return svc.settings.data_dir / "people"


def person_dir(svc: Services, person_id: str) -> Path:
    if not _ID.fullmatch(person_id or ""):
        raise ToolFailure("invalid_input", "person_id is not a valid id")
    return people_dir(svc) / person_id


def render_profile(p: Profile, links: list[str]) -> str:
    """What search indexes and embeds and what my_info shows as the saved profile."""
    def line(label: str, value) -> str | None:
        return f"- {label}: {value}" if value not in (None, "", []) else None

    facts = [line("Name", p.name), line("Location", p.location), line("Skills", ", ".join(p.skills)),
             line("Links", " ".join(links))]
    return "\n".join([f"# {p.headline}", "", *[f for f in facts if f], "", p.summary.strip()]) + "\n"


def _write(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)


def _entries(folder: Path) -> list[dict]:
    path = folder / "entries.json"
    return json.loads(path.read_text(encoding="utf-8"))["entries"] if path.is_file() else []


def saved(folder: Path) -> dict | None:
    path = folder / "profile.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def _digest(entries: list[dict]) -> str:
    return hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()


def _link(raw: str, limit: int) -> str:
    url = raw.strip()
    parts = urlparse(url if "://" in url else f"https://{url}")
    if parts.scheme not in ("http", "https") or "." not in parts.netloc or len(url) > limit:
        raise ToolFailure("invalid_input", f"not a web link: {url[:80]}")
    return parts.geturl()


def add_info(svc: Services, person_id: str, text: str | None = None, links: list[str] | None = None) -> MyInfo:
    """Add a text about the person and/or links, each its own entry. Free; search sees it after save_profile."""
    s = svc.settings
    text = (text or "").strip()
    links = [_link(raw, s.max_link_chars) for raw in links or [] if raw.strip()]
    if not text and not links:
        raise ToolFailure("invalid_input", "nothing to add: pass text, links or both")
    if len(text) > s.max_text_chars:
        raise ToolFailure("invalid_input", f"the text is over {s.max_text_chars} characters; split it up")
    folder = person_dir(svc, person_id)
    entries = _entries(folder)
    known = {e["value"] for e in entries if e["kind"] == "link"}
    new = ([{"kind": "text", "value": text}] if text else []) + [
        {"kind": "link", "value": url} for url in dict.fromkeys(links) if url not in known]
    if len(entries) + len(new) > s.max_entries:
        raise ToolFailure("invalid_input", f"a profile holds at most {s.max_entries} entries; delete some first")
    today = date.today().isoformat()
    entries += [{"entry_id": uuid.uuid4().hex[:8], **e, "added": today} for e in new]
    _write(folder / "entries.json", json.dumps({"entries": entries}, indent=1, ensure_ascii=False))
    log.info("person %s added %d entries", person_id, len(new))
    return my_info(svc, person_id)


def delete_info(svc: Services, person_id: str, entry_ids: list[str]) -> MyInfo:
    """Delete some of the person's entries. Free; search drops them after save_profile."""
    folder = person_dir(svc, person_id)
    entries = _entries(folder)
    wanted = {i.strip() for i in entry_ids if i.strip()}
    if not wanted:
        raise ToolFailure("invalid_input", "pass the entry_ids to delete (my_info lists them)")
    if missing := wanted - {e["entry_id"] for e in entries}:
        raise ToolFailure("not_found", f"no entry of yours with id {', '.join(sorted(missing))}")
    entries = [e for e in entries if e["entry_id"] not in wanted]
    _write(folder / "entries.json", json.dumps({"entries": entries}, indent=1, ensure_ascii=False))
    log.info("person %s deleted %d entries", person_id, len(wanted))
    return my_info(svc, person_id)


def my_info(svc: Services, person_id: str) -> MyInfo:
    folder = person_dir(svc, person_id)
    entries = _entries(folder)
    published = saved(folder)
    changed = _digest(entries) != published["entries_sha"] if published else bool(entries)
    return MyInfo(person_id=person_id, entries=[Entry(**e) for e in entries],
                  saved_profile=published["profile_md"] if published else None,
                  saved_at=published["saved_at"] if published else None, unsaved_changes=changed)


async def save_profile(svc: Services, person_id: str) -> MyInfo:
    """Write the profile from the entries and embed it, so search shows the entries as they are now. With no entries
    left, the person leaves search. Nothing changed since the last save: no model call."""
    folder = person_dir(svc, person_id)
    entries = _entries(folder)
    published = saved(folder)
    if not entries:
        if folder.is_dir():
            shutil.rmtree(folder)
            log.info("person %s removed from search (no entries)", person_id)
        return my_info(svc, person_id)
    digest = _digest(entries)
    if published and published["entries_sha"] == digest:
        return my_info(svc, person_id)

    texts = "\n\n".join(f'<entry kind="{e["kind"]}">\n{e["value"]}\n</entry>' for e in entries)
    system, user = render("profile", entries=texts)
    profile = await svc.llm.structured(system, user, Profile, name="person_profile")
    links = [e["value"] for e in entries if e["kind"] == "link"]
    profile_md = render_profile(profile, links)
    [vec] = await svc.embedder.embed([profile_md])

    # Every model call is done: only now does anything reach the disk.
    buf = folder / "embedding.npy.tmp"
    with buf.open("wb") as f:
        np.save(f, np.asarray(vec, dtype=np.float32))
    buf.replace(folder / "embedding.npy")
    _write(folder / "profile.json", json.dumps({
        "profile": profile.model_dump(), "profile_md": profile_md, "links": links,
        "about": [e["value"] for e in entries if e["kind"] == "text"], "entries_sha": digest,
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}, indent=1, ensure_ascii=False))
    log.info("person %s profile saved", person_id)
    return my_info(svc, person_id)


def delete_person(svc: Services, person_id: str) -> None:
    folder = person_dir(svc, person_id)
    if not folder.is_dir():
        raise ToolFailure("not_found", "there is nothing stored for you")
    shutil.rmtree(folder)
    log.info("person %s deleted", person_id)


def person_from(person_id: str, published: dict) -> Person:
    p = published["profile"]
    return Person(person_id=person_id, name=p["name"], headline=p["headline"], location=p["location"],
                  skills=p["skills"], summary=p["summary"], links=published["links"], about=published["about"],
                  saved_at=published["saved_at"])


def get_person(svc: Services, person_id: str) -> Person:
    """Anyone's saved profile, as search shows it, with everything they wrote."""
    published = saved(person_dir(svc, person_id))
    if published is None:
        raise ToolFailure("not_found", "no saved profile with that id")
    return person_from(person_id, published)
