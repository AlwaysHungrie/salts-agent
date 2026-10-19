"""Write each resume of the Hugging Face resume/job fit set (cnamuangtoun/resume-job-description-fit, test split)
as its own text file, for the matchmaker's inbox. Usage: uv run python scripts/export_hf_resumes.py FOLDER"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.benchmarks.resume_job_fit import load  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    folder = Path(sys.argv[1]).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    resumes, _, _ = load()
    for sha, text in resumes.items():
        (folder / f"resume_{sha[:12]}.txt").write_text(text + "\n", encoding="utf-8")
    print(f"wrote {len(resumes)} resumes to {folder}")


if __name__ == "__main__":
    main()
