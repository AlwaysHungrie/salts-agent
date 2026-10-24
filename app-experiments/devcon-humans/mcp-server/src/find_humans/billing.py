"""Per-request OpenRouter key and spend cap.

A paid tool call uses the caller's own key (X-OpenRouter-Api-Key), or the server's OPENROUTER_API_KEY when the
caller sends none. With neither, paid tools are refused. The caller may also send Tool-Call-Max-Charge,
the most one tool call may spend in US dollars (no header: no cap). A call whose estimated cost exceeds it is refused
before any model call; a call whose actual spend reaches it is stopped before its next model call. Both answer
cost_limit_exceeded with the amounts, so the agent can tell the user what to raise.
"""

import contextvars
import math
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass

import openai

from .config import get_settings
from .errors import ToolFailure

API_KEY_HEADER = "x-openrouter-api-key"
MAX_CHARGE_HEADER = "tool-call-max-charge"


@dataclass(frozen=True)
class CostRule:
    default_estimate: float  # USD per call, before any usage history exists
    what: str


# Paid tools: they need the caller's key. Saving a profile is one chat call and one embedding; a search embeds the
# query.
COST_RULES = {
    "save_profile": CostRule(0.001, "saving a profile"),
    "search_people": CostRule(0.00002, "searching people"),
}

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
                f"{self.what} stopped: spent ${self.spent_usd:.4f}, which reached the ${self.approved_usd:.4f} "
                f"Tool-Call-Max-Charge. Work done so far is kept. Ask the user to raise Tool-Call-Max-Charge in "
                f"this MCP server's connection settings, then call again to continue.",
            )


_api_key: contextvars.ContextVar[str | None] = contextvars.ContextVar("openrouter_api_key", default=None)
_budget: contextvars.ContextVar[Budget | None] = contextvars.ContextVar("budget", default=None)


def current_api_key() -> str | None:
    return _api_key.get()


@contextmanager
def use_api_key(key: str) -> Iterator[None]:
    """Run a block with the caller's key, for callers that are not MCP requests (the evaluation scripts)."""
    token = _api_key.set(key)
    try:
        yield
    finally:
        _api_key.reset(token)


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


def begin(tool: str, headers: Mapping[str, str] | None) -> list[contextvars.Token]:
    """Set this call's API key and budget. Returns tokens for `end`.

    A paid tool needs X-OpenRouter-Api-Key or the server's own key; on stdio (`headers` is None) only the latter.
    Tool-Call-Max-Charge is optional and caps any tool call, paid or not."""
    rule = COST_RULES.get(tool)
    key = _header(headers, API_KEY_HEADER) or get_settings().openrouter_api_key or None
    if rule and headers is None and key is None:
        raise ToolFailure("missing_header", f"{rule.what} needs the caller's OpenRouter key in the "
                          f"{API_KEY_HEADER} header; this server has no key of its own. Connect over HTTP")
    if rule and key is None:
        raise ToolFailure("missing_header", f"{rule.what} needs the {API_KEY_HEADER} header (the caller's OpenRouter "
                          f"key). Ask the user to add it to this MCP server's connection settings")
    raw = _header(headers, MAX_CHARGE_HEADER)
    what = rule.what if rule else tool.replace("_", " ")
    budget = Budget(tool, _parse_usd(raw, "Tool-Call-Max-Charge"), what) if raw is not None else None
    return [_api_key.set(key), _budget.set(budget)]


def server_pays(tool: str, headers: Mapping[str, str] | None) -> bool:
    """Whether this call's model use goes on the server's own key: a paid tool with no caller key."""
    return tool in COST_RULES and _header(headers, API_KEY_HEADER) is None


def end(tokens: list[contextvars.Token]) -> None:
    _budget.reset(tokens[1])
    _api_key.reset(tokens[0])


def preflight(tool: str) -> float | None:
    """Refuse before spending anything if the tool's typical cost exceeds Tool-Call-Max-Charge."""
    if _budget.get() is None:
        return None
    usd = COST_RULES[tool].default_estimate
    require_within(usd, "typical cost")
    return usd


def require_within(estimate_usd: float, basis: str) -> None:
    """Refuse before spending anything (more) if `estimate_usd` would pass Tool-Call-Max-Charge."""
    budget = _budget.get()
    if budget is None or budget.spent_usd + estimate_usd <= budget.approved_usd:
        return
    total = budget.spent_usd + estimate_usd
    raise ToolFailure(
        "cost_limit_exceeded",
        f"{budget.what} not done: estimated cost ${total:.4f} ({basis}) is over the ${budget.approved_usd:.4f} "
        f"Tool-Call-Max-Charge. Nothing more was spent. Tell the user the estimate and ask them to raise "
        f"Tool-Call-Max-Charge to at least ${total:.2f} in this MCP server's connection settings, then call again.",
    )


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
