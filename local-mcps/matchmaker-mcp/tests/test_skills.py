from recruiter_mcp.skills import SkillNormalizer, alias_key, compact_key, load_parents, load_seed, save_learned

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


def test_spacing_dot_and_version_variants_find_the_known_skill():
    assert N.normalize("NodeJS") == N.normalize("Node JS") == N.normalize("node.js") == "Node.js"
    assert N.normalize("Next JS") == "Next.js"
    assert N.normalize("Python 3.11") == "Python"
    assert N.normalize("Angular 14") == "Angular"
    assert N.normalize("SQL") == N.normalize("sql") == "SQL"
    assert N.normalize("S3") == "AWS S3"  # no space before the digit: not a version


def test_unknown_skill_is_learned_with_one_spelling():
    n = SkillNormalizer(load_seed())
    first = n.normalize("Kafka streams")
    assert n.normalize("kafka Streams") == n.normalize("KAFKA-STREAMS") == n.normalize("KafkaStreams") == first
    assert n.learned == {"kafka streams": first}
    n.normalize("Python")
    assert len(n.learned) == 1  # known skills are not learned


def test_expand_adds_implied_umbrella_skills_once():
    assert N.expand(["Django", "AWS Lambda"]) == ["Django", "AWS Lambda", "Python", "AWS"]
    assert N.expand(["Express.js"]) == ["Express.js", "Node.js", "JavaScript"]  # transitive
    assert N.expand(["Python", "Flask"]) == ["Python", "Flask"]
    assert N.expand(N.normalize_all(["EKS"])) == ["Amazon EKS", "AWS", "Kubernetes"]


def test_parents_and_seed_agree():
    canonical = set(load_seed().values())
    names = {s for child, ps in load_parents().items() for s in (child, *ps)}
    assert names <= canonical, names - canonical


def test_seed_variant_keys_do_not_collide():
    by_compact: dict[str, set[str]] = {}
    for alias, canonical in load_seed().items():
        by_compact.setdefault(compact_key(alias), set()).add(canonical)
    assert {k: v for k, v in by_compact.items() if len(v) > 1} == {}


async def test_learned_skills_persist_and_reload(svc):
    from recruiter_mcp.services import load_normalizer

    svc.normalizer.normalize("Temporal Workflows")
    assert await save_learned(svc.pool, svc.normalizer) == 1 and svc.normalizer.learned == {}
    row = await svc.pool.fetchrow("SELECT canonical, source FROM skill_synonyms WHERE alias = 'temporal workflows'")
    assert dict(row) == {"canonical": "Temporal Workflows", "source": "learned"}
    reloaded = await load_normalizer(svc.pool)
    assert reloaded.normalize("temporal workflows") == "Temporal Workflows" and reloaded.learned == {}
