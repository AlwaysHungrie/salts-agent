"""Per-request OpenRouter key and spend caps.

Over HTTP, every paid tool call must carry the client's own key (X-OpenRouter-Api-Key) and the maximum spend it
approves (that tool's X-Cost-Approved-* header). On stdio (no headers) the key and optional caps come from settings.
A call whose estimated cost exceeds the cap is rejected before any model call; a call whose actual spend reaches the
cap is stopped before its next model call.
"""

import contextvars
import math
from collections.abc import Mapping
from dataclasses import dataclass

import asyncpg
import openai

from .config import Settings
from .errors import ToolFailure

API_KEY_HEADER = "x-openrouter-api-key"


@dataclass(frozen=True)
class CostRule:
    header: str
    setting: str  # Settings attribute used when the header is absent
    default_estimate: float  # USD per unit, before any usage history exists
    what: str


COST_RULES = {
    "ingest_resume": CostRule("x-cost-approved-resume-ingestion", "cost_approved_resume_ingestion", 0.002,
                              "resume ingestion"),
    "match_job": CostRule("x-cost-approved-job-match", "cost_approved_job_match", 0.03, "job match"),
    "search_candidates": CostRule("x-cost-approved-search", "cost_approved_search", 0.00002, "search"),
    # Cap for the whole folder run; estimates are per file.
    "ingest_folder": CostRule("x-cost-approved-folder-ingestion", "cost_approved_folder_ingestion", 0.0035,
                              "folder ingestion"),
}
# Usage rows are tagged by tool; folder files are tagged per file, so their average is a per-file cost.
HISTORY_WINDOW = 20

# Errors that stop a whole operation (retrying the next file or candidate would fail the same way).
FATAL_CODES = {"invalid_api_key", "insufficient_credits", "key_forbidden", "cost_limit_exceeded", "config_error"}


@dataclass
class Budget:
    tool: str
    approved_usd: float
    what: str
    spent_usd: float = 0.0

    def charge(self, cost_usd: float | None) -> None:
        self.spent_usd += cost_usd or 0.0

    def ensure(self) -> None:
        if self.spent_usd >= self.approved_usd:
            raise ToolFailure(
                "cost_limit_exceeded",
                f"{self.what} stopped: spent ${self.spent_usd:.4f} of the ${self.approved_usd:.4f} approved. "
                f"Ask the user to approve a higher limit to continue.",
            )


_api_key: contextvars.ContextVar[str | None] = contextvars.ContextVar("openrouter_api_key", default=None)
_budget: contextvars.ContextVar[Budget | None] = contextvars.ContextVar("budget", default=None)


def current_api_key() -> str | None:
    return _api_key.get()


def current_budget() -> Budget | None:
    return _budget.get()


def charge(cost_usd: float | None) -> None:
    if (b := _budget.get()) is not None:
        b.charge(cost_usd)


def ensure_budget() -> None:
    """Call before every paid model call."""
    if (b := _budget.get()) is not None:
        b.ensure()


def _header(headers: Mapping[str, str] | None, name: str) -> str | None:
    if not headers:
        return None
    # Starlette headers are case-insensitive; plain dicts (tests) may not be.
    value = headers.get(name)
    if value is None:
        value = next((v for k, v in headers.items() if k.lower() == name), None)
    return value.strip() if value and value.strip() else None


def _parse_usd(raw: str, source: str) -> float:
    try:
        v = float(raw.strip().lstrip("$"))
    except ValueError:
        raise ToolFailure("invalid_input", f"{source} must be a number of US dollars, got {raw!r}") from None
    if not math.isfinite(v) or v < 0:
        raise ToolFailure("invalid_input", f"{source} must be a non-negative number of US dollars")
    return v


def begin(tool: str, headers: Mapping[str, str] | None, settings: Settings) -> list[contextvars.Token]:
    """Set this call's API key and budget. Returns tokens for `end`.

    `headers` is None on stdio: key and caps come from settings. Over HTTP (headers present), a paid tool requires
    both X-OpenRouter-Api-Key and its own X-Cost-Approved-* header; settings are not used as a fallback."""
    rule = COST_RULES.get(tool)
    key, budget = None, None
    if rule and headers is not None:
        missing = [h for h in (API_KEY_HEADER, rule.header) if _header(headers, h) is None]
        if missing:
            raise ToolFailure(
                "missing_header",
                f"{rule.what} needs the header(s) {', '.join(missing)} over HTTP. Ask the user to add them to this "
                f"MCP server's connection settings",
            )
        key = _header(headers, API_KEY_HEADER)
        budget = Budget(tool, _parse_usd(_header(headers, rule.header), rule.header), rule.what)
    elif rule and (setting := getattr(settings, rule.setting)) is not None:
        budget = Budget(tool, float(setting), rule.what)
    return [_api_key.set(key), _budget.set(budget)]


def end(tokens: list[contextvars.Token]) -> None:
    _budget.reset(tokens[1])
    _api_key.reset(tokens[0])


async def estimate(pool: asyncpg.Pool, tool: str) -> tuple[float, str]:
    """Typical cost of one unit of `tool`, from recent actual spend. Returns (usd, basis)."""
    rule = COST_RULES[tool]
    row = await pool.fetchrow(
        """SELECT avg(c) AS avg, count(*) AS n FROM (
             SELECT sum(cost_usd) AS c FROM usage WHERE tool = $1 AND cost_usd IS NOT NULL
             GROUP BY request_id ORDER BY max(created_at) DESC LIMIT $2) t""",
        tool, HISTORY_WINDOW,
    )
    if row and row["n"]:
        return float(row["avg"]), f"average of the last {row['n']} runs"
    return rule.default_estimate, "default estimate"


async def preflight(pool: asyncpg.Pool, tool: str, units: int = 1) -> float | None:
    """Reject before spending anything if the estimate exceeds the approved amount. Returns the estimate."""
    budget = _budget.get()
    # A folder run's cap covers the whole run; the per-resume pipeline inside it is not checked separately.
    if budget is None or budget.tool != tool or units <= 0:
        return None
    per_unit, basis = await estimate(pool, tool)
    total = per_unit * units
    if total > budget.approved_usd:
        per = f" (${per_unit:.4f} per file x {units} files)" if units > 1 else ""
        raise ToolFailure(
            "cost_limit_exceeded",
            f"{budget.what} not started: estimated cost ${total:.4f}{per}, {basis}, exceeds the "
            f"${budget.approved_usd:.4f} approved. Ask the user to approve at least ${total:.4f}.",
        )
    return total


def provider_failure(e: BaseException) -> ToolFailure | None:
    """Map an OpenRouter/OpenAI-client error to a ToolFailure the assistant can explain to the user."""
    if isinstance(e, ToolFailure):
        return e
    if isinstance(e, openai.APIStatusError):
        detail = _provider_message(e)
        if e.status_code == 401:
            return ToolFailure("invalid_api_key", f"OpenRouter rejected the API key (401): {detail}. "
                               "Check the key at https://openrouter.ai/settings/keys")
        if e.status_code == 402:
            return ToolFailure("insufficient_credits", f"OpenRouter account or key is out of credits (402): {detail}. "
                               "Add credits at https://openrouter.ai/settings/credits or raise the key's limit")
        if e.status_code == 403:
            return ToolFailure("key_forbidden", f"OpenRouter refused the request (403): {detail}")
        if e.status_code == 429:
            return ToolFailure("rate_limited", f"OpenRouter rate limit hit (429): {detail}. Try again shortly")
        if e.status_code >= 500:
            return ToolFailure("llm_unavailable", f"OpenRouter or the model provider failed ({e.status_code})")
    if isinstance(e, openai.APITimeoutError):
        return ToolFailure("llm_unavailable", "OpenRouter timed out")
    if isinstance(e, openai.APIConnectionError):
        return ToolFailure("llm_unavailable", "could not reach OpenRouter; check the network connection")
    return None


def _provider_message(e: openai.APIStatusError) -> str:
    """OpenRouter's own error text for key/credit/rate errors. These never quote request content."""
    msg = None
    if isinstance(e.body, dict):
        err = e.body.get("error")
        msg = e.body.get("message") or (err.get("message") if isinstance(err, dict) else err)
    return str(msg or e.message)[:300].rstrip(".")


def is_fatal(e: BaseException) -> bool:
    f = provider_failure(e)
    return f is not None and f.code in FATAL_CODES
