"""Location normalization for filtering: free text -> city key, with aliases and metro areas."""

import re

ALIASES = {
    "bangalore": "bengaluru",
    "bombay": "mumbai",
    "poona": "pune",
    "gurgaon": "gurugram",
    "new delhi": "delhi",
    "delhi ncr": "delhi",
    "ncr": "delhi",
    "madras": "chennai",
    "calcutta": "kolkata",
    "cochin": "kochi",
    "trivandrum": "thiruvananthapuram",
    "secunderabad": "hyderabad",
    "mysore": "mysuru",
    "mangalore": "mangaluru",
    "vizag": "visakhapatnam",
    "baroda": "vadodara",
    "pimpri": "pimpri chinchwad",
    "work from home": "remote",
    "wfh": "remote",
    "anywhere": "remote",
}

# A job anywhere in the metro accepts candidates anywhere in it.
METROS = {
    "mumbai": {"mumbai", "thane", "navi mumbai"},
    "delhi": {"delhi", "gurugram", "noida", "ghaziabad", "faridabad"},
    "bengaluru": {"bengaluru"},
    "pune": {"pune", "pimpri chinchwad"},
    "hyderabad": {"hyderabad"},
    "chennai": {"chennai"},
    "kolkata": {"kolkata"},
}

OTHER_CITIES = {
    "ahmedabad", "jaipur", "chandigarh", "mohali", "indore", "bhopal", "nagpur", "nashik", "surat", "vadodara",
    "lucknow", "kanpur", "coimbatore", "kochi", "thiruvananthapuram", "mysuru", "mangaluru", "visakhapatnam",
    "vijayawada", "bhubaneswar", "goa", "patna", "dehradun",
}

# A job "located" in a country or anywhere in it restricts no city.
REGIONS = {"india", "pan india", "anywhere in india", "across india", "all india", "any location", "multiple locations",
           "multiple cities", "asia", "apac", "sea", "south asia"}

KNOWN_CITIES = set(ALIASES.values()) | set(METROS) | set().union(*METROS.values()) | OTHER_CITIES


def _segment_key(seg: str) -> str | None:
    s = re.sub(r"[^a-z ]", " ", seg)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r" (east|west|north|south|central|city)$", "", s)
    return ALIASES.get(s, s) or None


def location_key(raw: str | None) -> str | None:
    """'Pune, Maharashtra, India' -> 'pune'; 'Andheri East, Mumbai' -> 'mumbai'; 'Remote (India)' -> 'remote'.
    The first segment that is a known city wins (resumes often lead with the neighbourhood); else the first."""
    if not raw:
        return None
    s = raw.lower()
    if "remote" in s:
        return "remote"
    # Plain hyphens join names ("Pimpri-Chinchwad"); spaced ones separate parts ("Mumbai - Andheri").
    s = re.sub(r"(?<=\w)-(?=\w)", " ", s)
    keys = [k for k in map(_segment_key, re.split(r"[,/(|;-]", s)) if k]
    if not keys:
        return None
    return next((k for k in keys if k in KNOWN_CITIES), keys[0])


def location_keys(raws: list[str]) -> list[str]:
    """Distinct keys of several location strings, input order kept."""
    return list(dict.fromkeys(k for k in map(location_key, raws) if k))


def expand_job_locations(locations: list[str]) -> list[str]:
    """Job location strings -> every candidate location_key that satisfies them. Countries and regions add none, so
    a job in "India" alone filters nothing."""
    keys: set[str] = set()
    for loc in locations:
        k = location_key(loc)
        if not k or k == "remote" or k in REGIONS:
            continue
        keys.add(k)
        for metro, members in METROS.items():
            if k == metro or k in members:
                keys |= members
    return sorted(keys)
