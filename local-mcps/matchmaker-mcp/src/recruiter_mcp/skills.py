"""Skill normalization: lowercase + strip punctuation -> alias lookup (exact, then spacing/dot variants, then without a
version suffix) -> title-cased fallback, which is learned so every later spelling of that skill gets the same name.
`expand` adds umbrella skills implied by specific ones (AWS Lambda -> AWS)."""

import csv
import re
from pathlib import Path

import asyncpg

SEEDS = Path(__file__).resolve().parents[2] / "seeds"
SEED_PATH = SEEDS / "skill_synonyms.csv"
PARENTS_PATH = SEEDS / "skill_parents.csv"

# Keep characters that carry meaning in skill names (c++, c#, .net, node.js).
_STRIP = re.compile(r"[^\w+#. ]")
_SPACES = re.compile(r"\s+")
# "python 3.11", "angular 14", "java v8": a version after a space.
_VERSION = re.compile(r"^(.+?)\s+v?\d+(?:\.\d+)*(?:\.x|x)?$")


def alias_key(raw: str) -> str:
    s = _STRIP.sub(" ", raw.lower())
    s = _SPACES.sub(" ", s).strip(" .")
    return s


def compact_key(key: str) -> str:
    """'node js', 'nodejs' and 'node.js' -> 'nodejs'."""
    return re.sub(r"[ .]", "", key)


def _title(raw: str) -> str:
    raw = _SPACES.sub(" ", raw).strip()
    # Leave acronyms and mixed-case names (AWS, PostgreSQL, iOS) as written.
    if any(c.isupper() for c in raw):
        return raw
    return raw.title()


def load_seed(path: Path = SEED_PATH) -> dict[str, str]:
    with path.open(newline="", encoding="utf-8") as f:
        return {alias_key(row["alias"]): row["canonical"] for row in csv.DictReader(f)}


def load_parents(path: Path = PARENTS_PATH) -> dict[str, list[str]]:
    parents: dict[str, list[str]] = {}
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            parents.setdefault(row["skill"], []).append(row["implies"])
    return parents


class SkillNormalizer:
    def __init__(self, synonyms: dict[str, str], parents: dict[str, list[str]] | None = None) -> None:
        self.synonyms = {alias_key(k): v for k, v in synonyms.items()}
        # Canonical names map to themselves so "postgresql" -> "PostgreSQL".
        for canonical in list(self.synonyms.values()):
            self.synonyms.setdefault(alias_key(canonical), canonical)
        self._compact: dict[str, str] = {}
        for key, canonical in self.synonyms.items():
            self._compact.setdefault(compact_key(key), canonical)
        self.parents = load_parents() if parents is None else parents
        # Skills first seen since the last save_learned: alias key -> canonical.
        self.learned: dict[str, str] = {}

    def _lookup(self, key: str) -> str | None:
        found = self.synonyms.get(key) or self._compact.get(compact_key(key))
        if found is None and (m := _VERSION.match(key)):
            base = m.group(1)
            found = self.synonyms.get(base) or self._compact.get(compact_key(base))
        return found

    def normalize(self, raw: str) -> str | None:
        key = alias_key(raw)
        if not key:
            return None
        found = self._lookup(key)
        if found:
            return found
        canonical = _title(raw)
        self.synonyms[key] = canonical
        self._compact.setdefault(compact_key(key), canonical)
        self.learned[key] = canonical
        return canonical

    def normalize_requirement(self, raw: str) -> str | None:
        """Like normalize, but keeps alternatives as one requirement: "tally or sap" -> "Tally or SAP".
        Splits on " or " and spaced " / " only, so "CI/CD" and "PL/SQL" stay whole."""
        raw = re.sub(r"\s*\([^)]*\)", "", raw)  # "React (production)" -> "React"
        alts = [a for a in (self.normalize(p) for p in re.split(r"\s+or\s+|\s+/\s+", raw)) if a]
        if len(alts) > 1:
            return " or ".join(dict.fromkeys(alts))
        return alts[0] if alts else None

    def normalize_requirements(self, raws: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for raw in raws:
            n = self.normalize_requirement(raw)
            if n and n.lower() not in seen:
                seen.add(n.lower())
                out.append(n)
        return out

    def normalize_all(self, raws: list[str]) -> list[str]:
        """Normalized, de-duplicated, input order preserved."""
        seen: set[str] = set()
        out: list[str] = []
        for raw in raws:
            n = self.normalize(raw)
            if n and n.lower() not in seen:
                seen.add(n.lower())
                out.append(n)
        return out

    def expand(self, skills: list[str]) -> list[str]:
        """Skills plus every umbrella skill they imply, appended: [Django, AWS Lambda] -> [..., Python, AWS]."""
        out = list(skills)
        have = {s.lower() for s in out}
        i = 0
        while i < len(out):
            for parent in self.parents.get(out[i], []):
                if parent.lower() not in have:
                    have.add(parent.lower())
                    out.append(parent)
            i += 1
        return out


async def save_learned(conn: asyncpg.Connection | asyncpg.Pool, normalizer: SkillNormalizer) -> int:
    """Persist skills first seen since the last call, so the vocabulary (and its spelling) survives restarts."""
    if not normalizer.learned:
        return 0
    items = list(normalizer.learned.items())
    normalizer.learned.clear()
    try:
        await conn.executemany(
            "INSERT INTO skill_synonyms (alias, canonical, source) VALUES ($1, $2, 'learned')"
            " ON CONFLICT (alias) DO NOTHING",
            items,
        )
    except BaseException:
        normalizer.learned.update(items)
        raise
    return len(items)
