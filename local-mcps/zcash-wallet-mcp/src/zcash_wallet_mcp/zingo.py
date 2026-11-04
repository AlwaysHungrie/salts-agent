"""Running zingo-cli. Every tool goes through here: one process per call, in command mode."""

import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .errors import ToolFailure

log = logging.getLogger("zcash_wallet_mcp")

#: `confirmed_orchard_balance: 1_234_567_890` or `… : no view capability`, as `balance` prints them.
BALANCE_LINE = re.compile(r"^\s*(\w+_balance)\s*:\s*(.+?)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class Zingo:
    cli: Path
    wallet_dir: Path
    chain: str
    server: str | None
    timeout: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "Zingo":
        return cls(
            cli=settings.zingo_cli_bin,
            wallet_dir=settings.wallet_dir(),
            chain=settings.zingo_chain,
            server=settings.zingo_server,
            timeout=settings.zingo_timeout_seconds,
        )

    def argv(self, command: str, *args: str, network: bool) -> list[str]:
        """The whole command line. Session options come first: zingo-cli refuses them after a command.

        `network=False` is a local command (addresses, a new address), run `--offline` so a stored
        standing consent cannot quietly put it on the network. `network=True` consents to go online
        and waits for the sync, so a balance or a send sees the chain as it is.
        """
        argv = [str(self.cli), "--data-dir", str(self.wallet_dir), "--chain", self.chain]
        if network:
            # --server implies the consent --online asks for, so they are never both needed.
            argv += ["--server", self.server] if self.server else ["--online"]
            argv.append("--waitsync")
        else:
            argv.append("--offline")
        return [*argv, command, *args]

    def run(self, command: str, *args: str, network: bool) -> str:
        """`command`'s output on stdout. Raises ToolFailure for anything that went wrong."""
        argv = self.argv(command, *args, network=network)
        if not self._resolved():
            raise ToolFailure(
                "zingo_cli_missing",
                f"zingo-cli isn't at {self.cli}. Build it (https://github.com/zingolabs/zingolib) "
                "and set ZINGO_CLI_BIN to the binary.",
            )
        self.wallet_dir.mkdir(parents=True, exist_ok=True)
        log.info("zingo-cli %s", " ".join(argv[1:]))
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=self.timeout)
        except subprocess.TimeoutExpired:
            raise ToolFailure(
                "zingo_timeout", f"zingo-cli took longer than {self.timeout}s on `{command}` and was stopped."
            ) from None
        except OSError as e:
            raise ToolFailure("zingo_cli_missing", f"couldn't run zingo-cli at {self.cli}: {e}") from None
        if done.returncode != 0:
            raise ToolFailure("zingo_failed", _why(command, done))
        return done.stdout

    def run_json(self, command: str, *args: str, network: bool) -> object:
        """`command`'s output, decoded. Log lines printed before the JSON are skipped."""
        out = self.run(command, *args, network=network)
        start = min((i for i in (out.find("{"), out.find("[")) if i != -1), default=-1)
        if start != -1:
            try:
                return json.JSONDecoder().raw_decode(out, start)[0]
            except json.JSONDecodeError:
                pass
        raise ToolFailure("zingo_unreadable", f"zingo-cli's `{command}` output wasn't JSON: {_snippet(out)}")

    def _resolved(self) -> bool:
        parts = Path(self.cli).parts
        return bool(shutil.which(str(self.cli))) if len(parts) == 1 else Path(self.cli).is_file()


def parse_balance(out: str) -> dict[str, int | None]:
    """`balance`'s block of pools as zatoshis. A pool the wallet cannot view is None."""
    pools: dict[str, int | None] = {}
    for name, raw in BALANCE_LINE.findall(out):
        digits = raw.replace("_", "")
        pools[name] = int(digits) if digits.isdigit() else None
    if not pools:
        raise ToolFailure("zingo_unreadable", f"zingo-cli's `balance` output held no balances: {_snippet(out)}")
    return pools


def _why(command: str, done: subprocess.CompletedProcess) -> str:
    """The line of a failed run worth showing the agent: zingo-cli's own complaint, if it made one."""
    lines = [line.strip() for line in f"{done.stderr}\n{done.stdout}".splitlines() if line.strip()]
    said = next((line for line in lines if re.search(r"error|fail|refus|offline|insufficient", line, re.I)), "")
    return f"zingo-cli's `{command}` failed ({done.returncode}): {said or _snippet(' '.join(lines)) or 'no output'}"


def _snippet(text: str, limit: int = 300) -> str:
    one_line = " ".join(text.split())
    return one_line[:limit] + ("…" if len(one_line) > limit else "")
