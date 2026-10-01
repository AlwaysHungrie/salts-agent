from recruiter_mcp.locations import country_key, expand_job_locations, location_countries, location_key, location_keys


def test_city_found_after_neighbourhood_or_with_state():
    assert location_key("Andheri East, Mumbai") == "mumbai"
    assert location_key("Whitefield, Bangalore, India") == "bengaluru"
    assert location_key("Hinjewadi, Pune, Maharashtra") == "pune"
    assert location_key("Pune, Maharashtra, India") == "pune"
    assert location_key("Pimpri-Chinchwad") == "pimpri chinchwad"
    assert location_key("Mumbai - Andheri") == "mumbai"
    assert location_key("Remote (India)") == "remote"
    assert location_key("Springfield, IL") == "springfield"  # unknown city: first segment
    assert location_key("") is None and location_key(None) is None


def test_location_keys_dedupes():
    assert location_keys(["Bangalore", "Bengaluru", "Pune", ""]) == ["bengaluru", "pune"]


def test_job_in_a_metro_suburb_accepts_the_whole_metro():
    assert expand_job_locations(["Thane"]) == ["mumbai", "navi mumbai", "thane"]
    assert expand_job_locations(["Gurgaon"]) == ["delhi", "faridabad", "ghaziabad", "gurugram", "noida"]
    assert expand_job_locations(["Remote"]) == []


def test_country_or_region_restricts_no_city():
    assert expand_job_locations(["India"]) == []
    assert expand_job_locations(["Pan India", "Pune"]) == ["pimpri chinchwad", "pune"]


def test_location_countries_from_country_city_or_state():
    assert location_countries("Remote (India, SEA)") == ["india"]
    assert location_countries("Whitefield, Bangalore") == ["india"]
    assert location_countries("Sangli, Maharashtra") == ["india"]  # unknown town, known state
    assert location_countries("Berlin") == ["germany"]
    assert location_countries("San Francisco, CA, USA") == ["united states"]
    assert location_countries("Remote - US") == ["united states"]
    assert location_countries("Remote (India / UK)") == ["india", "united kingdom"]
    assert location_countries("Remote") == []
    assert location_countries("Springfield, IL") == []
    assert location_countries("Austin, Texas") == ["united states"]
    assert location_countries("") == [] and location_countries(None) == []


def test_country_key_normalises_spellings():
    assert country_key("USA") == "united states"
    assert country_key(" U.S. ") == "united states"
    assert country_key("India") == "india"
    assert country_key("Atlantis") == "atlantis"
