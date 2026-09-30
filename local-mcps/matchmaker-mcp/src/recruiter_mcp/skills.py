"""Skill normalization: lowercase + strip punctuation -> alias lookup -> title-cased fallback."""

import csv
import re
from pathlib import Path

SEED_PATH = Path(__file__).resolve().parents[2] / "seeds" / "skill_synonyms.csv"

# Keep characters that carry meaning in skill names (c++, c#, .net, node.js).
_STRIP = re.compile(r"[^\w+#. ]")
_SPACES = re.compile(r"\s+")


def alias_key(raw: str) -> str:
    s = _STRIP.sub(" ", raw.lower())
    s = _SPACES.sub(" ", s).strip(" .")
    return s


def _title(raw: str) -> str:
    raw = _SPACES.sub(" ", raw).strip()
    # Leave acronyms and mixed-case names (AWS, PostgreSQL, iOS) as written.
    if any(c.isupper() for c in raw):
        return raw
    return raw.title()


def load_seed(path: Path = SEED_PATH) -> dict[str, str]:
    with path.open(newline="", encoding="utf-8") as f:
        return {alias_key(row["alias"]): row["canonical"] for row in csv.DictReader(f)}


class SkillNormalizer:
    def __init__(self, synonyms: dict[str, str]) -> None:
        self.synonyms = {alias_key(k): v for k, v in synonyms.items()}
        # Canonical names map to themselves so "postgresql" -> "PostgreSQL".
        for canonical in list(self.synonyms.values()):
            self.synonyms.setdefault(alias_key(canonical), canonical)

    def normalize(self, raw: str) -> str | None:
        key = alias_key(raw)
        if not key:
            return None
        return self.synonyms.get(key) or _title(raw)

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
