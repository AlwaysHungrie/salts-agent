"""find-humans as an MCP server: a public directory of people, each writing about themselves, searchable by anyone
connected. A caller's own profile is the one their X-Find-Humans-Secret header derives; every model call uses the
caller's X-OpenRouter-Api-Key header, or the server's own key when there is none."""

import functools
import json
import logging
import sys
import traceback
from types import SimpleNamespace
from typing import Annotated

import uvicorn
from mcp.server.mcpserver import Context, MCPServer
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import billing, identity, people, spend
from .auth import SignedSecretMiddleware
from .config import get_settings, signing_key_problem
from .errors import ToolFailure
from .models import MyInfo, Page, Person
from .search import search
from .services import Services
from .usage import track_usage

log = logging.getLogger("find_humans")

_services: Services | None = None


def services() -> Services:
    global _services
    if _services is None:
        _services = Services(settings=get_settings())
    return _services


mcp = MCPServer(
    name="find-humans",
    instructions=(
        "A public directory of people: each person writes about who they are and what they do, and anyone "
        "connected can search it. "
        "Finding people: search_people with what the user is looking for, in the words such a person would use "
        "about themselves ('builds AI agents', 'runs brand deals for creators'). Each page is up to 10 people, "
        "best first; tell the user who fits and why from their headline and summary. For more, call again with "
        "offset = next_offset. get_person gives one person's full profile, everything they wrote and their links. "
        "The user's own profile: add_info stores what they tell you about themselves (a text, links, or both), "
        "each as its own entry; my_info shows their entries and the profile search shows now. Adding and "
        "deleting are free and do not reach search: when the user is done adding or deleting, call save_profile "
        "(it writes the profile and makes it searchable, ~$0.001). Do not save after every small change; do save "
        "after they delete something, so it leaves search. delete_info removes single entries; "
        "delete_my_profile removes everything, only after the user confirms. "
        "Never put the user's secret or API key in a message."
    ),
    version="0.1.0",
)


def _error(code: str, message: str) -> CallToolResult:
    body = {"error": {"code": code, "message": message}}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))], is_error=True)


def tool_handler(name: str):
    """The caller's key and spend cap from the headers, a refusal up front when a paid tool's typical cost is over
    the cap or the person has used their allowance on the server's key, and failures as {code, message} errors,
    never tracebacks."""

    def decorate(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            tokens = None
            try:
                ctx = kwargs.get("ctx")
                headers = ctx.headers if ctx is not None else None
                tokens = billing.begin(name, headers)
                if name in billing.COST_RULES:
                    billing.preflight(name)
                # On the server's key, the call is charged to the caller's person, so it needs one.
                payer = identity.caller(headers) if billing.server_pays(name, headers) else None
                if payer is not None:
                    spend.ensure_room(services(), payer)
                async with track_usage(name) as usage:
                    try:
                        return await fn(*args, **kwargs)
                    finally:
                        if payer is not None:
                            spend.add(services(), payer, usage.cost_usd)
            except ToolFailure as e:
                log.info("tool %s failed: %s", name, e.code)
                return _error(e.code, e.message)
            except Exception as e:
                if (failure := billing.provider_failure(e)) is not None:
                    log.info("tool %s failed: %s", name, failure.code)
                    return _error(failure.code, failure.message)
                # Messages can quote what people wrote: log the type and frame locations only.
                frames = "\n".join(
                    f"  {f.filename}:{f.lineno} in {f.name}" for f in traceback.extract_tb(e.__traceback__))
                log.error("tool %s crashed: %s\n%s", name, type(e).__name__, frames)
                return _error("internal_error", "unexpected server error; see server logs")
            finally:
                if tokens is not None:
                    billing.end(tokens)

        return wrapper

    return decorate


def _me(ctx: Context | None) -> str:
    return identity.caller(ctx.headers if ctx is not None else None)


class PingResult(BaseModel):
    ok: bool
    people: int = Field(description="People with a saved profile")


# ---------------------------------------------------------------- tools


@mcp.tool(description="Health check: how many people have a saved profile.",
          annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False))
@tool_handler("ping")
async def ping() -> PingResult:
    root = people.people_dir(services())
    count = sum(1 for p in root.iterdir() if (p / "profile.json").is_file()) if root.is_dir() else 0
    return PingResult(ok=True, people=count)


@mcp.tool(
    description=(
        "Search everyone for what the user is looking for, e.g. 'builds AI agents', 'runs brand deals', 'solidity "
        "auditor in Berlin'. Ranked by words and meaning, best first, up to 10 per page. For more, pass offset = "
        "next_offset. ~$0.00002."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("search_people")
async def search_people(
    query: Annotated[str, Field(description="Who they are looking for: role, skills, work, place")],
    offset: Annotated[int, Field(description="next_offset of the previous page", ge=0)] = 0,
    ctx: Context | None = None,
) -> Page:
    return await search(services(), query, offset)


@mcp.tool(description="One person's full profile: headline, skills, summary, everything they wrote and their links. "
                      "Free.",
          annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False))
@tool_handler("get_person")
async def get_person(person_id: Annotated[str, Field(description="From a search result")]) -> Person:
    return people.get_person(services(), person_id)


@mcp.tool(
    description=(
        "Add to the user's own profile what they tell you about themselves: who they are, what they do, what they "
        "are looking for (text), and/or links (site, GitHub, X, LinkedIn). Each text and each link becomes its own "
        "entry they can delete later. Write the text in their words; do not invent. Free; search sees it only "
        "after save_profile."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
)
@tool_handler("add_info")
async def add_info(
    text: Annotated[str | None, Field(description="What they said about themselves")] = None,
    links: Annotated[list[str] | None, Field(description="Web links they want on their profile")] = None,
    ctx: Context | None = None,
) -> MyInfo:
    return people.add_info(services(), _me(ctx), text, links)


@mcp.tool(
    description="The user's own entries (with entry_ids, for delete_info), the profile search shows now and whether "
                "there are unsaved changes. Free.",
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("my_info")
async def my_info(ctx: Context | None = None) -> MyInfo:
    return people.my_info(services(), _me(ctx))


@mcp.tool(
    description="Delete some of the user's own entries by entry_id (from my_info). Free; then call save_profile so "
                "they leave search.",
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True),
)
@tool_handler("delete_info")
async def delete_info(
    entry_ids: Annotated[list[str], Field(description="Entries to delete")],
    ctx: Context | None = None,
) -> MyInfo:
    return people.delete_info(services(), _me(ctx), entry_ids)


@mcp.tool(
    description=(
        "Publish the user's entries: the server writes their profile (headline, skills, summary) from everything "
        "they added and makes it searchable. Call when they are done adding or deleting, not after every change. "
        "With no entries left, they leave search. Nothing changed since the last save costs nothing. ~$0.001."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("save_profile")
async def save_profile(ctx: Context | None = None) -> MyInfo:
    return await people.save_profile(services(), _me(ctx))


@mcp.tool(description="Permanently delete everything the user added and their profile, from search too. Confirm "
                      "with the user first.",
          annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True))
@tool_handler("delete_my_profile")
async def delete_my_profile(ctx: Context | None = None) -> dict:
    me = _me(ctx)
    people.delete_person(services(), me)
    return {"deleted": me}


# ---------------------------------------------------------------- transports


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------- HTTP API
# For the app that sets up agents, so its pages can show and save a profile without going through an agent. Each
# route runs the tool of the same name with the request's headers, so the secret, key and spend rules are the same.

_STATUS = {"invalid_input": 400, "missing_header": 400, "missing_secret": 401, "not_found": 404,
           "cost_limit_exceeded": 402, "spend_limit_reached": 429, "rate_limited": 429, "internal_error": 500}


def _ctx(request: Request) -> SimpleNamespace:
    return SimpleNamespace(headers=request.headers)


def _failed(result: CallToolResult) -> JSONResponse:
    body = json.loads(result.content[0].text)
    return JSONResponse(body, status_code=_STATUS.get(body["error"]["code"], 502))


def _mine(info: MyInfo | CallToolResult) -> JSONResponse:
    """The caller's entries and their saved profile as structured fields (null until first saved)."""
    if isinstance(info, CallToolResult):
        return _failed(info)
    published = people.saved(people.person_dir(services(), info.person_id))
    profile = people.person_from(info.person_id, published) if published else None
    return JSONResponse({"info": info.model_dump(mode="json"),
                         "profile": profile.model_dump(mode="json") if profile else None})


@mcp.custom_route("/api/me", methods=["GET"])
async def api_me(request: Request) -> JSONResponse:
    return _mine(await my_info(ctx=_ctx(request)))


@mcp.custom_route("/api/me/save", methods=["POST"])
async def api_save(request: Request) -> JSONResponse:
    return _mine(await save_profile(ctx=_ctx(request)))


@mcp.custom_route("/api/people/{person_id}", methods=["GET"])
async def api_person(request: Request) -> JSONResponse:
    result = await get_person(person_id=request.path_params["person_id"])
    return _failed(result) if isinstance(result, CallToolResult) else JSONResponse(result.model_dump(mode="json"))


def build_http_app():
    settings = get_settings()
    app = mcp.streamable_http_app(host=settings.mcp_host, max_request_body_size=2 * 1024 * 1024)
    return SignedSecretMiddleware(app, settings.secret_signing_key)


def main() -> None:
    # Logs go to stderr so they never corrupt the stdio transport. IDs and counts only, never what people wrote.
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    settings = get_settings()
    if problem := signing_key_problem(settings):
        raise SystemExit(problem)
    if settings.mcp_transport == "stdio":
        mcp.run("stdio")
    else:
        uvicorn.run(build_http_app(), host=settings.mcp_host, port=settings.mcp_port)


if __name__ == "__main__":
    main()
