"""Backfill a folder of PDF resumes from the command line (same pipeline as the ingest_folder tool).

Each PDF is transcribed by VISION_MODEL and goes through the normal ingest pipeline with the original attached.
Other file types are ignored.

Safe to re-run: files ingested before and unchanged since (same path, size, mtime) are skipped without being read,
files whose bytes are already in the database are skipped before any model call, and failures are retried on the
next run up to --max-attempts. Progress is kept in the source_files table.

Usage:
  uv run python scripts/bulk_ingest.py ~/resumes --dry-run         # count files and estimate cost
  uv run python scripts/bulk_ingest.py ~/resumes --limit 5         # try a few first
  uv run python scripts/bulk_ingest.py ~/resumes                   # everything
  uv run python scripts/bulk_ingest.py C:\\Users\\me\\resumes --concurrency 8 --source ats
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

from recruiter_mcp.billing import estimate
from recruiter_mcp.bulk import BulkReport, FileResult, bulk_ingest, find_files, scan
from recruiter_mcp.config import get_settings
from recruiter_mcp.db import create_pool
from recruiter_mcp.migrate import migrate
from recruiter_mcp.services import Services, load_normalizer
from recruiter_mcp.storage import LocalStorage


def progress(done: int, total: int, r: FileResult) -> None:
    name = Path(r.path).name
    extra = f"  {r.error}" if r.error else (f"  ${r.cost_usd:.4f}" if r.cost_usd else "")
    print(f"[{done}/{total}] {r.status:<14} {r.seconds:5.1f}s  {name}{extra}", flush=True)


def print_summary(report: BulkReport) -> None:
    c = report.counts
    print("\n" + "=" * 60)
    print(f"{report.total_files} files in {report.elapsed_s:.0f}s  |  created {c['created']}  updated "
          f"{c['updated']}  unchanged {c['unchanged']}  duplicate {c['duplicate_file']}  failed {c['failed']}  "
          f"gave up {c['gave_up']}")
    print(f"cost ${report.cost_usd:.4f}")
    failed = [r for r in report.results if r.status in ("failed", "gave_up")]
    if failed:
        print("\nNeeds attention:")
        for r in failed:
            print(f"  {Path(r.path).name}: {r.error}  (attempts {r.attempts})")
        print("Re-run the same command to retry failures.")


async def main(args) -> int:
    folder = args.folder.expanduser().resolve()
    if not folder.is_dir():
        print(f"not a folder: {folder}", file=sys.stderr)
        return 2
    files = find_files(folder, recursive=not args.no_recursive)
    if args.limit:
        files = files[: args.limit]

    settings = get_settings()
    await migrate()
    pool = await create_pool()
    try:
        svc = Services(settings=settings, pool=pool, storage=LocalStorage(settings.data_dir),
                       normalizer=await load_normalizer(pool))
        sc = await scan(svc, files, args.max_attempts)
        per_file, basis = await estimate(pool, "ingest_folder")
        print(f"{len(files)} PDFs; {len(sc.skipped)} unchanged since an earlier run; {len(sc.pending)} to process "
              f"(~${len(sc.pending) * per_file:.2f} at most, {basis})")
        if args.dry_run:
            for f in sc.pending[:20]:
                print("  " + str(f.path.relative_to(folder)))
            if len(sc.pending) > 20:
                print(f"  ... and {len(sc.pending) - 20} more")
            return 0
        print(f"concurrency {args.concurrency}, vision model {settings.vision_model}")
        report = await bulk_ingest(svc, files, svc.vision.transcribe, concurrency=args.concurrency,
                                   max_attempts=args.max_attempts, source=args.source, on_result=progress,
                                   scanned=sc)
    finally:
        await pool.close()
    print_summary(report)
    if report.stopped_reason:
        print(f"\nSTOPPED EARLY: {report.stopped_reason}")
    if args.json:
        args.json.write_text(json.dumps([r.__dict__ for r in report.results], indent=2), encoding="utf-8")
    return 1 if report.counts["failed"] else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--concurrency", type=int, default=4, help="files processed at once (default 4)")
    ap.add_argument("--max-attempts", type=int, default=3, help="give up on a file after this many failures")
    ap.add_argument("--source", default="other", choices=["email", "upload", "ats", "other"])
    ap.add_argument("--limit", type=int, help="only the first N files (sorted by path)")
    ap.add_argument("--no-recursive", action="store_true", help="don't descend into subfolders")
    ap.add_argument("--dry-run", action="store_true", help="count files and estimate cost; no changes")
    ap.add_argument("--json", type=Path, help="write per-file results to this file")
    logging.basicConfig(level=logging.WARNING)
    sys.exit(asyncio.run(main(ap.parse_args())))
