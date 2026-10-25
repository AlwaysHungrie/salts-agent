from starlette.types import ASGIApp, Receive, Scope, Send

from . import identity


class SignedSecretMiddleware:
    """Rejects HTTP requests without exactly one X-Find-Humans-Secret minted with `key`. `/healthz` is exempt.
    Each caller's own secret is their pass, so there is no shared token to hand out or leak."""

    def __init__(self, app: ASGIApp, key: str) -> None:
        self.app = app
        self.key = key

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] == "/healthz":
            await self.app(scope, receive, send)
            return
        name = identity.SECRET_HEADER.encode()
        sent = [value for key, value in scope["headers"] if key == name]
        # One copy only: the tools read the first, so a second could otherwise differ from what was checked here.
        secret = sent[0].decode("latin-1").strip() if len(sent) == 1 else ""
        if identity.verified_id(self.key, secret) is None:
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send(
                {
                    "type": "http.response.body",
                    "body": b'{"error":{"code":"unauthorized","message":"missing or invalid X-Find-Humans-Secret"}}',
                }
            )
            return
        await self.app(scope, receive, send)
