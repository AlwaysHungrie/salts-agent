from recruiter_mcp.skills import SkillNormalizer, alias_key, load_seed

N = SkillNormalizer(load_seed())


def test_seed_is_large_and_clean():
    seed = load_seed()
    assert len(seed) >= 200
    assert all(k and v for k, v in seed.items())


def test_aliases_map_to_canonical():
    assert N.normalize("k8s") == "Kubernetes"
    assert N.normalize("ReactJS") == "React"
    assert N.normalize("react.js") == "React"
    assert N.normalize("postgres") == "PostgreSQL"
    assert N.normalize("JS") == "JavaScript"
    assert N.normalize("Amazon Web Services") == "AWS"
    assert N.normalize("Tally ERP") == "Tally"


def test_canonical_names_map_to_themselves():
    assert N.normalize("postgresql") == "PostgreSQL"
    assert N.normalize("kubernetes") == "Kubernetes"


def test_punctuation_and_spacing():
    assert N.normalize("  Node.JS ") == "Node.js"
    assert N.normalize("CI/CD") == "CI/CD"
    assert N.normalize("c++") == "C++"
    assert N.normalize("C#") == "C#"
    assert alias_key("Spring-Boot!") == "spring boot"


def test_unknown_skill_falls_back_to_title_case_or_as_written():
    assert N.normalize("apache flink") == "Apache Flink"
    assert N.normalize("dbt Cloud") == "dbt Cloud"  # has capitals: keep as written
    assert N.normalize("   ") is None


def test_normalize_all_dedupes_and_keeps_order():
    assert N.normalize_all(["k8s", "Python", "Kubernetes", "python3", "Go"]) == ["Kubernetes", "Python", "Go"]
