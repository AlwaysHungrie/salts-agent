import pytest

from recruiter_mcp.errors import ToolFailure
from recruiter_mcp.ingest import (
    build_headline,
    embedding_text,
    load_original,
    normalize_email,
    normalize_name,
    phone_key,
    rank_skills,
    text_sha256,
)
from recruiter_mcp.models import CandidateProfile, Role

MB = 1024 * 1024


def test_phone_key_matches_formats():
    assert phone_key("+91 98765 43210") == phone_key("098765-43210") == "9876543210"
    assert phone_key("12345") is None
    assert phone_key(None) is None


def test_normalize_email():
    assert normalize_email("  Priya.Sharma@Example.COM ") == "priya.sharma@example.com"
    assert normalize_email("<a@b.co>") == "a@b.co"
    assert normalize_email("not an email") is None
    assert normalize_email(None) is None


def test_text_hash_ignores_whitespace_and_case():
    assert text_sha256("Priya  Sharma\n\nPython") == text_sha256("priya sharma python")
    assert text_sha256("a") != text_sha256("b")


def test_load_original_validations(tmp_path):
    assert load_original(None, MB) is None
    (tmp_path / "cv.docx").write_bytes(b"PK")
    (tmp_path / "fake.pdf").write_bytes(b"hello")
    cases = [
        (str(tmp_path / "missing.pdf"), "file_not_found"),
        (str(tmp_path / "cv.docx"), "unsupported_file_type"),
        ("relative/cv.pdf", "invalid_input"),
        (str(tmp_path / "fake.pdf"), "invalid_input"),
    ]
    for path, code in cases:
        with pytest.raises(ToolFailure) as e:
            load_original(path, MB)
        assert e.value.code == code, path


def test_load_original_size_limit(tmp_path):
    big = tmp_path / "big.pdf"
    big.write_bytes(b"%PDF" + b"0" * MB)
    with pytest.raises(ToolFailure) as e:
        load_original(str(big), MB)
    assert e.value.code == "file_too_large"


def test_load_original_reads_pdf_path(tmp_path):
    p = tmp_path / "CV.PDF"
    p.write_bytes(b"%PDF-1.4 test")
    a = load_original(f'"{p}"', MB)  # quoted, as copied from a file manager
    assert a.mime == "application/pdf" and a.ext == "pdf" and a.data == b"%PDF-1.4 test"


def _profile(**kw):
    base = dict(
        name="X", email=None, phone=None, location=None, willing_to_relocate=None, preferred_locations=[],
        current_title="Backend Engineer",
        roles=[Role(title="Backend Engineer", company="Acme", start="2020-01", end="present",
                    highlights=["Built AWS services in Python"])],
        skills=[], education=[], certifications=[], industries=[], notice_period_days=None,
        current_ctc=None, expected_ctc=None, languages=[], summary="Backend engineer.",
    )
    base.update(kw)
    return CandidateProfile(**base)


def test_rank_skills_puts_evidenced_skills_first():
    assert rank_skills(_profile(), ["Go", "Docker", "Python", "AWS"]) == ["Python", "AWS", "Go", "Docker"]


def test_headline_and_embedding_text():
    p = _profile()
    assert build_headline(p, 6.2, ["Python", "AWS", "Go", "X"]) == "Backend Engineer, 6.2 yrs, Python/AWS/Go"
    assert build_headline(p.model_copy(update={"current_title": None}), None, []) == "Backend Engineer"
    text = embedding_text(p, ["Python", "AWS"])
    assert "Skills: Python, AWS" in text and "Backend Engineer at Acme" in text


def test_normalize_name():
    assert normalize_name("  KARAN   MALHOTRA ") == "Karan Malhotra"
    assert normalize_name("priya sharma") == "Priya Sharma"
    assert normalize_name("Ronan McDonald") == "Ronan McDonald"
    assert normalize_name("") is None and normalize_name(None) is None


def test_derive_drops_region_preferences_and_marks_remote_only():
    from recruiter_mcp.ingest import derive
    from recruiter_mcp.skills import SkillNormalizer, load_seed

    n = SkillNormalizer(load_seed())
    d = derive(_profile(location="Noida", willing_to_relocate=True,
                        preferred_locations=["Anywhere in India", "India"]), n)
    assert (d.location_key, d.willing_to_relocate, d.preferred_location_keys) == ("noida", True, [])
    d = derive(_profile(location="Pune", preferred_locations=["Bangalore", "Pan India"]), n)
    assert d.preferred_location_keys == ["bengaluru"]
    assert derive(_profile(location=None, preferred_locations=["Remote"]), n).location_key == "remote"
    assert derive(_profile(location=None, preferred_locations=["Remote", "Pune"]), n).location_key is None
