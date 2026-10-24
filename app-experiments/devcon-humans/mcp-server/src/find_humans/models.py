from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class LLMModel(BaseModel):
    """Base for models filled by the LLM. Strict JSON schema mode needs additionalProperties=false."""

    model_config = ConfigDict(extra="forbid")


# ---- filled by the model ----


class Profile(LLMModel):
    name: str | None
    headline: str = Field(description="What they do in at most 12 words, e.g. 'Builds AI agents for customer support'")
    location: str | None = Field(description="Where they are based, only when they say")
    skills: list[str] = Field(description="5-25 skills, roles, tools and domains under their common names, strongest "
                                          "first, including ones their work clearly implies")
    summary: str = Field(description="2-4 sentences, factual: what they do, for whom, notable work")
    page: str = Field(description="Their profile for people to read, in Markdown: short sections, each a bold label "
                                  "then a line or a few bullets, covering everything they wrote")


# ---- results ----


class Entry(BaseModel):
    entry_id: str
    kind: Literal["text", "link"]
    value: str
    added: str = Field(description="Date added, YYYY-MM-DD")


class MyInfo(BaseModel):
    person_id: str = Field(description="This person's public id, the one search results show")
    entries: list[Entry] = Field(description="Everything they have added, oldest first")
    saved_profile: str | None = Field(description="The profile search shows now; null until first saved")
    saved_at: str | None = None
    unsaved_changes: bool = Field(description="Entries changed since the last save; search still shows the saved "
                                              "profile until save_profile")


class Person(BaseModel):
    person_id: str
    name: str | None
    headline: str
    location: str | None
    skills: list[str]
    summary: str
    page: str | None = Field(description="Their profile as Markdown, everything they wrote; null for profiles "
                                         "saved before there was one")
    links: list[str]
    about: list[str] = Field(description="What they wrote about themselves, as saved")
    saved_at: str


class Hit(BaseModel):
    position: int = Field(description="Place in the ranked list, best first")
    person_id: str
    name: str | None
    headline: str
    location: str | None
    skills: list[str]
    summary: str
    page: str | None
    links: list[str]
    keyword_rank: int | None = Field(description="Place on words alone (BM25); null when no query word appears")
    meaning_rank: int = Field(description="Place on meaning alone (embeddings)")


class Page(BaseModel):
    query: str
    total: int = Field(description="Everyone with a saved profile, in ranked order")
    offset: int
    people: list[Hit]
    next_offset: int | None = Field(description="Pass as offset for the next page; null on the last page")
