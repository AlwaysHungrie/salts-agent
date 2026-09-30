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
    "work from home": "remote",
    "wfh": "remote",
    "anywhere": "remote",
}

# A job in the metro accepts candidates anywhere in it.
METROS = {
    "mumbai": {"mumbai", "thane", "navi mumbai"},
    "delhi": {"delhi", "gurugram", "noida", "ghaziabad", "faridabad"},
    "bengaluru": {"bengaluru"},
    "pune": {"pune", "pimpri chinchwad"},
    "hyderabad": {"hyderabad"},
    "chennai": {"chennai"},
    "kolkata": {"kolkata"},
}


def location_key(raw: str | None) -> str | None:
    """'Pune, Maharashtra, India' -> 'pune'; 'Remote (India)' -> 'remote'."""
    if not raw:
        return None
    s = raw.lower()
    if "remote" in s:
        return "remote"
    s = re.split(r"[,/(|;-]", s)[0]
    s = re.sub(r"[^a-z ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r" (east|west|north|south|central|city)$", "", s)
    if not s:
        return None
    return ALIASES.get(s, s)


def expand_job_locations(locations: list[str]) -> list[str]:
    """Job location strings -> every candidate location_key that satisfies them."""
    keys: set[str] = set()
    for loc in locations:
        k = location_key(loc)
        if not k or k == "remote":
            continue
        keys.add(k)
        for metro, members in METROS.items():
            if k == metro or k in members:
                keys |= members if k == metro else {k}
    return sorted(keys)
