"""Signed browser links, for a user in a chat app who cannot reach this computer's disk: a person's files to open or
download, and an upload page that drops resumes into the bulk inbox.

A link is `<public base>/share/<token>`. The token names what it opens and when it expires, signed with a key derived
from MCP_AUTH_TOKEN; the salts-tools gateway lets `/share/` through without the bearer header and this module checks
the signature instead. Replacing the salts-tools token voids every link. The public base comes from the
X-Forwarded-Host / X-Forwarded-Prefix headers the gateway adds, so links follow the tunnel's current address."""

import hashlib
import hmac
import html
import re
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings
from .documents import SUFFIXES
from .errors import ToolFailure
from .uploads import _kind

FILES, UPLOAD = "files", "upload"
_TOKEN = re.compile(r"(files|upload)-([0-9a-f]{32}|inbox)-(\d{1,12})-([0-9a-f]{32})")
# What a person's folder holds that is theirs to read: the originals, their text, notes and the profile.
_HIDDEN = {"person.json", "embedding.npy"}
_KIND_OF_SUFFIX = {".pdf": "pdf", ".docx": "docx", ".txt": "txt", ".md": "txt"}
MEDIA_TYPES = {".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
               ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
_UNSAFE = re.compile(r'[\x00-\x1f<>:"/\\|?*]')


def _key(settings: Settings) -> bytes:
    if not settings.mcp_auth_token:
        raise ToolFailure("no_public_address", "links need the server running under salts-tools")
    return hmac.new(settings.mcp_auth_token.encode(), b"matchmaker share links", hashlib.sha256).digest()


def _sign(settings: Settings, body: str) -> str:
    return hmac.new(_key(settings), body.encode(), hashlib.sha256).hexdigest()[:32]


def make_token(settings: Settings, kind: str, target: str, now: float | None = None) -> tuple[str, datetime]:
    """(token, expires_at). `target` is a person_id for FILES, "inbox" for UPLOAD."""
    exp = int((now if now is not None else time.time()) + settings.link_ttl_hours * 3600)
    body = f"{kind}-{target}-{exp}"
    return f"{body}-{_sign(settings, body)}", datetime.fromtimestamp(exp, UTC)


def read_token(settings: Settings, token: str, now: float | None = None) -> tuple[str, str] | None:
    """(kind, target) for a valid, unexpired token; None otherwise."""
    m = _TOKEN.fullmatch(token or "")
    if not m or not settings.mcp_auth_token:
        return None
    kind, target, exp, sig = m.groups()
    if not hmac.compare_digest(sig, _sign(settings, f"{kind}-{target}-{exp}")):
        return None
    if int(exp) < (now if now is not None else time.time()):
        return None
    if (kind == UPLOAD) != (target == "inbox"):
        return None
    return kind, target


def expiry(token: str) -> datetime:
    """When a token read_token accepted runs out."""
    return datetime.fromtimestamp(int(token.split("-")[2]), UTC)


def public_base(headers: Mapping[str, str] | None) -> str | None:
    """`https://<tunnel>/matchmaker`, from the headers the gateway adds; None when not reached through it."""
    h = {k.lower(): v for k, v in (headers or {}).items()}
    host = h.get("x-forwarded-host", "").strip()
    if not host or not re.fullmatch(r"[A-Za-z0-9.-]+(:\d+)?", host):
        return None
    proto = h.get("x-forwarded-proto", "https").split(",")[0].strip()
    prefix = h.get("x-forwarded-prefix", "").strip().rstrip("/")
    if proto not in ("http", "https") or not re.fullmatch(r"(/[a-z0-9-]+)*", prefix):
        return None
    return f"{proto}://{host}{prefix}"


def link(settings: Settings, headers: Mapping[str, str] | None, kind: str, target: str
         ) -> tuple[str, datetime] | None:
    """(url, expires_at), or None when the caller did not come through the tunnel."""
    base = public_base(headers)
    if base is None or not settings.mcp_auth_token:
        return None
    token, expires = make_token(settings, kind, target)
    return f"{base}/share/{token}", expires


# ---------------------------------------------------------------- files


def person_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir()
                  if p.is_file() and p.name not in _HIDDEN and not p.name.endswith(".tmp"))


def person_file(folder: Path, name: str) -> Path | None:
    return next((p for p in person_files(folder) if p.name == name), None)


# ---------------------------------------------------------------- uploads


def safe_name(name: str) -> str:
    """The file's own name, without folders or characters a file system refuses."""
    base = _UNSAFE.sub("_", Path(name.replace("\\", "/")).name).strip().lstrip(".")
    stem, suffix = Path(base).stem[:150], Path(base).suffix.lower()
    if suffix not in SUFFIXES:
        raise ToolFailure("unsupported_file", f"only {', '.join(SUFFIXES)} files can be uploaded")
    return f"{stem or 'resume'}{suffix}"


def save_to_inbox(inbox: Path, name: str, data: bytes) -> tuple[Path, bool]:
    """Writes the upload to inbox/<today>/<name>. (path, False) when the same bytes are already there; a different
    file with the same name gets " (2)", " (3)" ... added."""
    if not data:
        raise ToolFailure("empty_file", "the file is empty")
    name = safe_name(name)
    if _kind(data) != _KIND_OF_SUFFIX[Path(name).suffix]:
        raise ToolFailure("unsupported_file", f"{name} is not the kind of file its name says")
    folder = inbox / datetime.now(UTC).date().isoformat()
    folder.mkdir(parents=True, exist_ok=True)
    stem, suffix = Path(name).stem, Path(name).suffix
    n = 1
    while True:
        path = folder / (name if n == 1 else f"{stem} ({n}){suffix}")
        if not path.exists():
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
            return path, True
        if path.read_bytes() == data:
            return path, False
        n += 1


# ---------------------------------------------------------------- pages

PAGE_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                                "connect-src 'self'; form-action 'none'; frame-ancestors 'none'"),
}

_STYLE = """
:root { --bg: #fafaf9; --card: #fff; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #c2410c;
        --ok: #15803d; --bad: #b91c1c; color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --card: #292524; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #fb923c;
          --ok: #4ade80; --bad: #f87171; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 22px; margin: 0 0 4px; }
p.sub { color: var(--muted); margin: 0 0 24px; }
ul { list-style: none; padding: 0; margin: 0; background: var(--card); border: 1px solid var(--line);
     border-radius: 10px; overflow: hidden; }
li { padding: 12px 16px; border-top: 1px solid var(--line); display: flex; gap: 12px; align-items: baseline; }
li:first-child { border-top: 0; }
li .name { flex: 1; overflow-wrap: anywhere; }
li .meta { color: var(--muted); font-size: 14px; white-space: nowrap; }
a { color: var(--accent); }
.drop { display: block; border: 2px dashed var(--line); border-radius: 10px; padding: 32px 16px; text-align: center;
        background: var(--card); cursor: pointer; margin-bottom: 16px; }
.drop.over { border-color: var(--accent); }
.drop input { display: none; }
.row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card);
         color: var(--fg); cursor: pointer; }
#summary { margin: 0 0 12px; font-weight: 600; }
.ok { color: var(--ok); } .bad { color: var(--bad); }
"""


def page(title: str, body: str, script: str = "") -> str:
    return (f"<!doctype html><html lang='en'><head><meta charset='utf-8'>"
            f"<meta name='viewport' content='width=device-width, initial-scale=1'>"
            f"<meta name='robots' content='noindex'><title>{html.escape(title)}</title><style>{_STYLE}</style>"
            f"</head><body><main>{body}</main>{f'<script>{script}</script>' if script else ''}</body></html>")


def _size(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB" if n >= 1024 * 1024 else f"{max(1, round(n / 1024))} KB"


def files_page(token: str, name: str | None, headline: str, files: list[Path], expires: datetime) -> str:
    rows = "".join(
        f"<li><a class='name' href='{html.escape(token)}/f/{html.escape(f.name)}'>{html.escape(f.name)}</a>"
        f"<span class='meta'>{_size(f.stat().st_size)}</span></li>" for f in files)
    return page(f"{name or 'Candidate'}: files", (
        f"<h1>{html.escape(name or 'Candidate')}</h1><p class='sub'>{html.escape(headline)}</p>"
        f"<ul>{rows or '<li>No files on record.</li>'}</ul>"
        f"<p class='sub' style='margin-top:16px'>This link works until {expires:%d %b %Y, %H:%M} UTC.</p>"))


def upload_page(expires: datetime, max_bytes: int) -> str:
    accept = ",".join(SUFFIXES)
    body = (
        "<h1>Upload resumes</h1>"
        "<p class='sub'>PDF, Word .docx or text files. Pick as many as you like, or a whole folder. When the upload "
        "finishes, tell your agent and it adds them.</p>"
        f"<label class='drop' id='drop'><input id='files' type='file' multiple accept='{accept}'>"
        "<strong>Choose files</strong> or drop them here</label>"
        "<div class='row'><button id='folder' type='button'>Choose a folder</button>"
        "<input id='dir' type='file' webkitdirectory hidden></div>"
        "<p id='summary'></p><ul id='list' hidden></ul>"
        f"<p class='sub' style='margin-top:16px'>This link works until {expires:%d %b %Y, %H:%M} UTC. Each file can "
        f"be up to {max_bytes // (1024 * 1024)} MB.</p>")
    script = (
        f"const OK = {list(SUFFIXES)!r}, MAX = {max_bytes};"
        """
const url = location.pathname.replace(/\\/$/, '') + '/upload';
const $ = (id) => document.getElementById(id);
const list = $('list'), sum = $('summary'), drop = $('drop');
let done = 0, failed = 0, skipped = 0, total = 0, running = 0;
const queue = [];

function show() {
  const finished = done + failed + skipped === total;
  sum.textContent = `${done} uploaded` + (skipped ? `, ${skipped} already here` : '')
    + (failed ? `, ${failed} failed` : '') + ` of ${total}` + (finished ? '. Done: tell your agent.' : '');
}
function row(f) {
  const li = document.createElement('li'), name = document.createElement('span'), meta = document.createElement('span');
  name.className = 'name';
  name.textContent = f.webkitRelativePath || f.name;
  meta.className = 'meta';
  meta.textContent = 'waiting';
  li.append(name, meta);
  list.hidden = false;
  list.appendChild(li);
  return meta;
}
function mark(meta, text, ok) {
  meta.textContent = text;
  meta.className = 'meta ' + (ok ? 'ok' : 'bad');
}
function add(files) {
  for (const f of files) {
    const ext = (f.name.match(/\\.[^.]+$/) || [''])[0].toLowerCase();
    if (!OK.includes(ext) || f.name.startsWith('.')) continue;
    total++;
    queue.push([f, row(f)]);
  }
  show();
  pump();
}
async function send(f, meta) {
  if (f.size > MAX) { failed++; return mark(meta, 'too large', false); }
  meta.textContent = 'uploading';
  try {
    const r = await fetch(url + '?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { failed++; return mark(meta, (j.error && j.error.message) || 'error ' + r.status, false); }
    if (j.new === false) { skipped++; return mark(meta, 'already here', true); }
    done++;
    mark(meta, 'uploaded', true);
  } catch (e) {
    failed++;
    mark(meta, 'network error', false);
  }
}
function pump() {
  while (running < 3 && queue.length) {
    const [f, meta] = queue.shift();
    running++;
    send(f, meta).finally(() => { running--; show(); pump(); });
  }
}
$('files').onchange = (e) => add(e.target.files);
$('dir').onchange = (e) => add(e.target.files);
$('folder').onclick = () => $('dir').click();
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); };
""")
    return page("Upload resumes", body, script)


def gone_page() -> str:
    return page("Link expired", "<h1>This link has expired or is not valid</h1>"
                                "<p class='sub'>Ask your agent for a new one.</p>")
