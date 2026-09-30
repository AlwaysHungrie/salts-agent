"""LLM provider interface. Structured output via JSON schema, Pydantic validation, one retry on bad output."""

import base64
import json
import logging
import re
from typing import Protocol, TypeVar

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from .billing import ensure_budget
from .config import Settings
from .errors import ToolFailure
from .usage import UsageRecord, record

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

NO_KEY = "no OpenRouter API key: send the X-OpenRouter-Api-Key header or set LLM_API_KEY"


class LLM(Protocol):
    async def structured(
        self, system: str, user: str, schema: type[T], *, name: str, reasoning_effort: str | None = None
    ) -> T:
        """`system` is the stable, cacheable prefix; `user` is the per-call suffix.
        `reasoning_effort` overrides the configured default for this call."""
        ...


class OpenRouterLLM:
    def __init__(self, settings: Settings) -> None:
        if not settings.llm_api_key:
            raise ToolFailure("config_error", NO_KEY)
        self.model = settings.llm_model
        self.reasoning_effort = settings.llm_reasoning_effort
        # max_retries gives 2 retries with exponential backoff on 429/5xx/timeouts.
        self.client = AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            timeout=settings.llm_timeout_seconds,
            max_retries=2,
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
        ensure_budget()
        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": name, "strict": True, "schema": schema.model_json_schema()},
            },
            extra_body=extra,
        )
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


class OpenRouterVision:
    """Transcribes a PDF or image to plain text with a vision model. Used by bulk backfill, where no
    assistant is in the loop to read the file."""

    def __init__(self, settings: Settings) -> None:
        if not settings.llm_api_key:
            raise ToolFailure("config_error", NO_KEY)
        self.model = settings.vision_model
        self.client = AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            timeout=settings.vision_timeout_seconds,
            max_retries=2,
        )

    async def transcribe(self, data: bytes, mime: str, filename: str) -> str:
        from .prompts import render

        system, user = render("transcribe_resume", filename=filename)
        b64 = base64.b64encode(data).decode()
        if mime == "application/pdf":
            part = {"type": "file", "file": {"filename": filename, "file_data": f"data:{mime};base64,{b64}"}}
        elif mime.startswith("image/"):
            part = {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        else:
            raise ToolFailure("unsupported_file_type", f"vision transcription does not accept {mime}")
        ensure_budget()
        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": [{"type": "text", "text": user}, part]},
            ],
            extra_body={"usage": {"include": True}},
        )
        if resp.usage is not None:
            record(UsageRecord(kind="vision", model=self.model, input_tokens=resp.usage.prompt_tokens or 0,
                               output_tokens=resp.usage.completion_tokens or 0,
                               cost_usd=getattr(resp.usage, "cost", None)))
        text = (resp.choices[0].message.content or "") if resp.choices else ""
        # Models sometimes wrap output in a code fence despite the prompt.
        text = re.sub(r"^```[a-z]*\n|\n```$", "", text.strip())
        return text.strip()


def create_llm(settings: Settings) -> LLM:
    if settings.llm_provider == "openrouter":
        return OpenRouterLLM(settings)
    raise ToolFailure("config_error", f"unknown LLM_PROVIDER {settings.llm_provider}")
