"""Hybrid search over everyone: BM25 on words (profile + resume + cover letter) and cosine similarity on meaning
(the query's embedding against each profile's), merged by reciprocal rank fusion. One embedding call per search,
no chat call. The same person filed twice (same email or phone, or near-identical resumes) is listed once, at their
better place, with the other ids under `duplicates`. Judging fit is a separate step, page by page (judge.py)."""

import json
import logging
import re
import zlib
from collections import Counter
from dataclasses import dataclass

import bm25s
import numpy as np
import Stemmer

from .errors import ToolFailure
from .models import Candidate, Page
from .people import KINDS, people_dir
from .services import Services

log = logging.getLogger(__name__)

_STEMMER = Stemmer.Stemmer("english")
# Near-identical resumes: Jaccard of word 5-grams. Measured on the benchmark pool, versions of one resume share
# 0.5 or more and different people almost never reach 0.4.
DUPLICATE_JACCARD = 0.5
_SAMPLE = 4  # keep 1 in 4 shingles (by hash): the Jaccard estimate holds and comparisons are 4x cheaper
_COMMON = 50  # a shingle in more files than this is boilerplate and shows nothing about who wrote it
_MIN_SHINGLES = 20  # fewer sampled shingles (under ~100 words) is too little text to call two files one person


def tokenize(texts: list[str]) -> list[list[str]]:
    return bm25s.tokenize(texts, stopwords="en", stemmer=_STEMMER, return_ids=False, show_progress=False)


@dataclass
class Index:
    """Everyone's searchable text and profile vectors, built from the folders. `signature` is every indexed file's
    mtime, so a changed, added or removed person rebuilds it."""

    signature: tuple
    ids: list[str]
    names: list[str | None]
    profiles: list[str]
    bm25: bm25s.BM25 | None
    vectors: np.ndarray  # (people, dim), unit length
    group: list[int]  # the same person filed more than once shares one group number


def _files(folder) -> list:
    return [folder / "person.json", folder / "profile.md", folder / "embedding.npy",
            *(folder / f"{k}.txt" for k in KINDS)]


def _signature(svc: Services) -> tuple:
    root = people_dir(svc)
    if not root.is_dir():
        return ()
    sig = []
    for folder in sorted(p for p in root.iterdir() if (p / "person.json").is_file()):
        sig.append((folder.name, *(f.stat().st_mtime_ns if f.exists() else 0 for f in _files(folder))))
    return tuple(sig)


def shingles(text: str) -> set[int]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    grams = (zlib.crc32(" ".join(words[i:i + 5]).encode()) for i in range(max(0, len(words) - 4)))
    return {g for g in grams if g % _SAMPLE == 0}


def _contact(value: str | None, digits: bool = False) -> str | None:
    if not value:
        return None
    v = re.sub(r"\D", "", value)[-10:] if digits else value.strip().lower()
    return v if len(v) >= 6 else None


def duplicate_groups(resumes: list[str], emails: list[str | None], phones: list[str | None]) -> list[int]:
    """One group number per person; the same email, the same phone or near-identical resumes join groups."""
    parent = list(range(len(resumes)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def join(a: int, b: int) -> None:
        parent[find(a)] = find(b)

    for values in ([_contact(e) for e in emails], [_contact(p, digits=True) for p in phones]):
        first: dict[str, int] = {}
        for i, v in enumerate(values):
            if v is not None:
                join(i, first.setdefault(v, i))
    sets = [sh if len(sh) >= _MIN_SHINGLES else set() for sh in map(shingles, resumes)]
    postings: dict[int, list[int]] = {}
    for i, sh in enumerate(sets):
        for g in sh:
            postings.setdefault(g, []).append(i)
    for i, sh in enumerate(sets):
        shared = Counter(j for g in sh if len(postings[g]) <= _COMMON for j in postings[g] if j > i)
        for j, n in shared.items():
            if n / (len(sh) + len(sets[j]) - n) >= DUPLICATE_JACCARD:
                join(i, j)
    return [find(i) for i in range(len(resumes))]


def _build(svc: Services, signature: tuple) -> Index:
    root = people_dir(svc)
    ids, names, profiles, corpus, vectors, resumes, emails, phones = [], [], [], [], [], [], [], []
    for entry in signature:
        folder = root / entry[0]
        profile = (folder / "profile.md").read_text(encoding="utf-8")
        docs = [(folder / f"{k}.txt").read_text(encoding="utf-8") for k in KINDS if (folder / f"{k}.txt").is_file()]
        meta = json.loads((folder / "person.json").read_text(encoding="utf-8"))
        ids.append(entry[0])
        names.append(meta.get("name"))
        emails.append(meta.get("email"))
        phones.append(meta.get("phone"))
        profiles.append(profile)
        resumes.append("\n\n".join(docs))
        corpus.append("\n\n".join([profile, *docs]))
        vectors.append(np.load(folder / "embedding.npy"))
    bm25 = None
    if corpus:
        bm25 = bm25s.BM25()
        bm25.index(tokenize(corpus), show_progress=False)
    dim = svc.settings.embed_dim
    matrix = np.vstack(vectors).astype(np.float32) if vectors else np.zeros((0, dim), np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    log.info("search index built: %d people", len(ids))
    return Index(signature, ids, names, profiles, bm25, matrix / np.where(norms == 0, 1, norms),
                 duplicate_groups(resumes, emails, phones))


def index(svc: Services) -> Index:
    sig = _signature(svc)
    if svc.index is None or svc.index.signature != sig:
        svc.index = _build(svc, sig)
    return svc.index


def fuse(keyword: list[int], meaning: list[int], k: int) -> list[int]:
    """Reciprocal rank fusion. `keyword`: people with any query word, best first; `meaning`: everyone, best first.
    Returns everyone, best first; ties keep the meaning order."""
    score: dict[int, float] = {}
    for rank, i in enumerate(keyword, 1):
        score[i] = score.get(i, 0.0) + 1.0 / (k + rank)
    for rank, i in enumerate(meaning, 1):
        score[i] = score.get(i, 0.0) + 1.0 / (k + rank)
    place = {i: r for r, i in enumerate(meaning)}
    return sorted(score, key=lambda i: (-score[i], place.get(i, len(place))))


async def search(svc: Services, query: str, offset: int = 0, limit: int | None = None,
                 query_vector: list[float] | None = None) -> Page:
    """Everyone in the pool, ranked for `query`, one page at a time. `query_vector` skips embedding the query
    (a posted job's own embedding)."""
    query = query.strip()
    if not query:
        raise ToolFailure("invalid_input", "the query is empty")
    if offset < 0:
        raise ToolFailure("invalid_input", "offset must be 0 or more")
    limit = limit or svc.settings.page_size
    idx = index(svc)
    if not idx.ids:
        return Page(query=query, total=0, offset=offset, candidates=[], next_offset=None)

    words = idx.bm25.get_scores(tokenize([query])[0])
    keyword = [int(i) for i in np.argsort(-words, kind="stable") if words[i] > 0]
    if query_vector is None:
        [query_vector] = await svc.embedder.embed([query])
    q = np.asarray(query_vector, dtype=np.float32)
    sims = idx.vectors @ (q / (np.linalg.norm(q) or 1.0))
    meaning = [int(i) for i in np.argsort(-sims, kind="stable")]

    order, members = [], {}
    for i in fuse(keyword, meaning, svc.settings.rrf_k):  # the same person once, at their best place
        g = idx.group[i]
        if g not in members:
            order.append(i)
            members[g] = []
        else:
            members[g].append(idx.ids[i])
    keyword_rank = {i: r for r, i in enumerate(keyword, 1)}
    meaning_rank = {i: r for r, i in enumerate(meaning, 1)}
    window = order[offset:offset + limit]
    candidates = [Candidate(position=offset + n + 1, person_id=idx.ids[i], name=idx.names[i],
                            keyword_rank=keyword_rank.get(i), meaning_rank=meaning_rank[i], profile=idx.profiles[i],
                            duplicates=members[idx.group[i]])
                  for n, i in enumerate(window)]
    end = offset + len(window)
    return Page(query=query, total=len(order), offset=offset, candidates=candidates,
                next_offset=end if end < len(order) else None)
