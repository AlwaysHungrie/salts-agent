"""Who is calling. Every caller sends a secret in the X-Find-Humans-Secret header, minted with SECRET_SIGNING_KEY:
`fh1.<id>.<signature>`, the signature an HMAC of the id. Whoever mints secrets (the app that sets up each user's
agent) holds the key; the agent holds only its user's own secret, so nothing it can show or send gives access to
anyone else's profile or to the server as a whole. The caller's person_id is derived from the id. The secret itself
is never stored or logged. There is no recovery yet: a lost secret is a lost profile."""

import base64
import hashlib
import hmac
from collections.abc import Mapping

from .config import get_settings
from .errors import ToolFailure

SECRET_HEADER = "x-find-humans-secret"
SIGNED_PREFIX = "fh1"
MIN_ID_CHARS = 16


def person_id(secret_id: str) -> str:
    return hashlib.sha256(f"find-humans:{secret_id}".encode()).hexdigest()[:32]


def _signature(key: str, secret_id: str) -> bytes:
    # Labelled with the format and purpose, so a later format or use of the key never shares a signature.
    digest = hmac.new(key.encode(), f"{SIGNED_PREFIX}:secret:{secret_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=")


def mint(key: str, secret_id: str) -> str:
    """A signed secret for `secret_id`."""
    return f"{SIGNED_PREFIX}.{secret_id}.{_signature(key, secret_id).decode()}"


def verified_id(key: str, secret: str) -> str | None:
    """The id inside a signed secret, or None when it was not minted with `key`."""
    try:
        raw = secret.encode("ascii")
    except UnicodeEncodeError:
        return None
    prefix, _, rest = raw.partition(b".")
    secret_id, _, signature = rest.rpartition(b".")
    if prefix != SIGNED_PREFIX.encode() or len(secret_id) < MIN_ID_CHARS:
        return None
    if not hmac.compare_digest(signature, _signature(key, secret_id.decode())):
        return None
    return secret_id.decode()


def header(headers: Mapping[str, str] | None) -> str:
    """The secret header's value, or "" when there is none."""
    if not headers:
        return ""
    # Starlette headers are case-insensitive; plain dicts (tests) may not be.
    secret = headers.get(SECRET_HEADER)
    if secret is None:
        secret = next((v for k, v in headers.items() if k.lower() == SECRET_HEADER), None)
    return (secret or "").strip()


def caller(headers: Mapping[str, str] | None) -> str:
    """The calling person's id, from their secret header."""
    secret = header(headers)
    if not secret:
        raise ToolFailure("missing_secret", f"changing your own profile needs your secret in the {SECRET_HEADER} "
                          "header, which the app that set up this connection provides")
    key = get_settings().secret_signing_key
    secret_id = verified_id(key, secret) if key else None
    if secret_id is None:
        raise ToolFailure("invalid_input", f"the {SECRET_HEADER} secret was not issued for this server")
    return person_id(secret_id)
