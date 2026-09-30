"""Prompts live in prompts/*.md. A `<!-- user -->` line splits the stable system prefix from the
per-call user suffix, so the prefix can be cached by the provider."""

from functools import cache
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"
_SPLIT = "<!-- user -->"


@cache
def _load(name: str) -> tuple[str, str]:
    text = (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")
    system, _, user = text.partition(_SPLIT)
    return system.strip(), user.strip()


def _fill(template: str, values: dict[str, str]) -> str:
    # Plain replace, so braces inside resume/JD text are never treated as placeholders.
    for key, value in values.items():
        template = template.replace("{" + key + "}", value)
    return template


def render(name: str, **values: str) -> tuple[str, str]:
    system, user = _load(name)
    return _fill(system, values), _fill(user, values)
