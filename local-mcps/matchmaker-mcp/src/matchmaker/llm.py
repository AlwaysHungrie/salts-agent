"""LLM provider interface. Structured output via JSON schema, Pydantic validation, one retry on bad output."""

import asyncio
import json
import logging
from typing import Protocol, TypeVar

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from .billing import ensure_budget
from .config import Settings
from .errors import ToolFailure
from .usage import UsageRecord, record

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

MAX_RETRIES = 2


def deadline(timeout: float) -> float:
    """Whole-request limit: every attempt the client may make (first try + MAX_RETRIES) at its own timeout."""
    return timeout * (MAX_RETRIES + 1)


async def within(coro, seconds: float, what: str):
    """Hard deadline over a request, retries included. The client's timeout is per read, and OpenRouter keeps a
    stalled request alive with keep-alive bytes, so without this a call can hang indefinitely (seen: 25+ min)."""
    try:
        return await asyncio.wait_for(coro, seconds)
    except TimeoutError:
        raise ToolFailure("llm_unavailable", f"{what} did not finish within {seconds:.0f}s") from None


class LLM(Protocol):
    async def structured(
        self, system: str, user: str, schema: type[T], *, name: str, reasoning_effort: str | None = None
    ) -> T:
        """`system` is the stable, cacheable prefix; `user` is the per-call suffix.
        `reasoning_effort` overrides the configured default for this call."""
        ...


_DEFAULT = object()


class OpenRouterLLM:
    def __init__(self, settings: Settings, api_key: str, model: str | None = None, *, reasoning_effort=_DEFAULT,
                 temperature: float | None = None, seed: int | None = None) -> None:
        """`reasoning_effort` None sends no reasoning setting (models without one); `temperature` and `seed` are
        sent only when set (reasoning models refuse a temperature)."""
        self.model = model or settings.llm_model
        self.reasoning_effort = settings.llm_reasoning_effort if reasoning_effort is _DEFAULT else reasoning_effort
        self.temperature, self.seed = temperature, seed
        self.deadline = deadline(settings.llm_timeout_seconds)
        # max_retries gives 2 retries with exponential backoff on 429/5xx/timeouts.
        self.client = AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=api_key,
            timeout=settings.llm_timeout_seconds,
            max_retries=MAX_RETRIES,
        )

    async def structured(
        self, system: str, user: str, schema: type[T], *, name: str, reasoning_effort: str | None = None
    ) -> T:
        system_content: str | list[dict] = system
        if self.model.startswith("anthropic/"):
            # Anthropic caches only at explicit breakpoints; OpenAI/Gemini cache prefixes automatically.
            system_content = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
        messages = [{"role": "system", "content": system_content}, {"role": "user", "content": user}]
        effort = reasoning_effort or self.reasoning_effort
        last_error: Exception | None = None
        for attempt in range(2):
            content = await self._call(messages, schema, name, effort)
            try:
                return schema.model_validate_json(content)
            except (ValidationError, json.JSONDecodeError) as e:
                last_error = e
                log.warning("llm output failed validation (schema=%s attempt=%d)", name, attempt + 1)
        raise ToolFailure("llm_invalid_output", f"model returned invalid {name} twice: {last_error}")

    async def _call(self, messages: list[dict], schema: type[BaseModel], name: str, effort: str | None) -> str:
        extra: dict = {
            # Only route to providers that honour response_format; report cost in usage.
            "provider": {"require_parameters": True},
            "usage": {"include": True},
        }
        if effort:
            extra["reasoning"] = {"effort": effort}
        sampling: dict = {}
        if self.temperature is not None:
            sampling["temperature"] = self.temperature
        if self.seed is not None:
            sampling["seed"] = self.seed
        ensure_budget()
        resp = await within(self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            **sampling,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": name, "strict": True, "schema": schema.model_json_schema()},
            },
            extra_body=extra,
        ), self.deadline, "the model")
        u = resp.usage
        if u is not None:
            details = getattr(u, "prompt_tokens_details", None)
            record(
                UsageRecord(
                    kind="llm",
                    model=self.model,
                    input_tokens=u.prompt_tokens or 0,
                    output_tokens=u.completion_tokens or 0,
                    cache_read_tokens=(getattr(details, "cached_tokens", 0) or 0) if details else 0,
                    cost_usd=getattr(u, "cost", None),
                )
            )
        content = resp.choices[0].message.content if resp.choices else None
        return content or ""


def create_llm(settings: Settings, api_key: str, model: str | None = None, **options) -> LLM:
    if settings.llm_provider == "openrouter":
        return OpenRouterLLM(settings, api_key, model, **options)
    raise ToolFailure("config_error", f"unknown LLM_PROVIDER {settings.llm_provider}")
