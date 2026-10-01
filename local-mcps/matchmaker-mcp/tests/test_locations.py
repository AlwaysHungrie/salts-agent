from recruiter_mcp.locations import expand_job_locations, location_key, location_keys


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
