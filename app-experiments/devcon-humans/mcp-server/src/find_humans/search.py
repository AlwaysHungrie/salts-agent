"""Hybrid search over every saved profile: BM25 on words (the profile and what the person wrote) and cosine
similarity on meaning (the query's embedding against each profile's), merged by reciprocal rank fusion. One
embedding call per search, no chat call. Unsaved entries are not searched."""

import logging
from dataclasses import dataclass

import bm25s
import numpy as np
import Stemmer

from .errors import ToolFailure
from .models import Hit, Page
from .people import people_dir, saved
from .services import Services

log = logging.getLogger(__name__)

_STEMMER = Stemmer.Stemmer("english")


def tokenize(texts: list[str]) -> list[list[str]]:
    return bm25s.tokenize(texts, stopwords="en", stemmer=_STEMMER, return_ids=False, show_progress=False)


@dataclass
class Index:
    """Every saved profile and its vector, built from the folders. `signature` is each saved file's mtime, so a
    saved, added or removed profile rebuilds it."""

    signature: tuple
    ids: list[str]
    profiles: list[dict]  # profile.json of each
    bm25: bm25s.BM25 | None
    vectors: np.ndarray  # (people, dim), unit length


def _signature(svc: Services) -> tuple:
    root = people_dir(svc)
    if not root.is_dir():
        return ()
    sig = []
    for folder in sorted(p for p in root.iterdir() if (p / "profile.json").is_file()):
        sig.append((folder.name, *((folder / f).stat().st_mtime_ns if (folder / f).exists() else 0
                                   for f in ("profile.json", "embedding.npy"))))
    return tuple(sig)


def _build(svc: Services, signature: tuple) -> Index:
    root = people_dir(svc)
    ids, profiles, corpus, vectors = [], [], [], []
    for entry in signature:
        folder = root / entry[0]
        published = saved(folder)
        ids.append(entry[0])
        profiles.append(published)
        corpus.append("\n\n".join([published["profile_md"], *published["about"]]))
        vectors.append(np.load(folder / "embedding.npy"))
    bm25 = None
    if corpus:
        bm25 = bm25s.BM25()
        bm25.index(tokenize(corpus), show_progress=False)
    dim = svc.settings.embed_dim
    matrix = np.vstack(vectors).astype(np.float32) if vectors else np.zeros((0, dim), np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    log.info("search index built: %d people", len(ids))
    return Index(signature, ids, profiles, bm25, matrix / np.where(norms == 0, 1, norms))


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


async def search(svc: Services, query: str, offset: int = 0, limit: int | None = None) -> Page:
    """Everyone with a saved profile, ranked for `query`, one page at a time."""
    query = query.strip()
    if not query:
        raise ToolFailure("invalid_input", "the query is empty")
    if offset < 0:
        raise ToolFailure("invalid_input", "offset must be 0 or more")
    limit = limit or svc.settings.page_size
    idx = index(svc)
    if not idx.ids:
        return Page(query=query, total=0, offset=offset, people=[], next_offset=None)

    words = idx.bm25.get_scores(tokenize([query])[0])
    keyword = [int(i) for i in np.argsort(-words, kind="stable") if words[i] > 0]
    [query_vector] = await svc.embedder.embed([query])
    q = np.asarray(query_vector, dtype=np.float32)
    sims = idx.vectors @ (q / (np.linalg.norm(q) or 1.0))
    meaning = [int(i) for i in np.argsort(-sims, kind="stable")]

    order = fuse(keyword, meaning, svc.settings.rrf_k)
    keyword_rank = {i: r for r, i in enumerate(keyword, 1)}
    meaning_rank = {i: r for r, i in enumerate(meaning, 1)}
    window = order[offset:offset + limit]
    people = []
    for n, i in enumerate(window):
        published = idx.profiles[i]
        p = published["profile"]
        people.append(Hit(position=offset + n + 1, person_id=idx.ids[i], name=p["name"], headline=p["headline"],
                          location=p["location"], skills=p["skills"], summary=p["summary"],
                          page=p.get("page"), links=published["links"],
                          keyword_rank=keyword_rank.get(i), meaning_rank=meaning_rank[i]))
    end = offset + len(window)
    return Page(query=query, total=len(order), offset=offset, people=people,
                next_offset=end if end < len(order) else None)
