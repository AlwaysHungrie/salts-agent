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


# Country names and spellings -> one key. Matched against whole location segments only, so "us" never matches
# inside a word and two-letter state codes ("CA", "IN") are deliberately absent.
COUNTRY_ALIASES = {
    "india": "india", "bharat": "india", "pan india": "india", "all india": "india", "across india": "india",
    "anywhere in india": "india",
    "united states": "united states", "united states of america": "united states", "usa": "united states",
    "us": "united states", "u s": "united states", "u s a": "united states", "america": "united states",
    "united kingdom": "united kingdom", "uk": "united kingdom", "u k": "united kingdom", "england": "united kingdom",
    "scotland": "united kingdom", "great britain": "united kingdom", "britain": "united kingdom",
    "canada": "canada", "australia": "australia", "new zealand": "new zealand", "ireland": "ireland",
    "germany": "germany", "france": "france", "netherlands": "netherlands", "the netherlands": "netherlands",
    "spain": "spain", "portugal": "portugal", "italy": "italy", "switzerland": "switzerland", "sweden": "sweden",
    "norway": "norway", "denmark": "denmark", "finland": "finland", "poland": "poland", "austria": "austria",
    "belgium": "belgium", "singapore": "singapore", "malaysia": "malaysia", "indonesia": "indonesia",
    "thailand": "thailand", "vietnam": "vietnam", "philippines": "philippines", "japan": "japan",
    "south korea": "south korea", "korea": "south korea", "china": "china", "hong kong": "hong kong",
    "taiwan": "taiwan", "united arab emirates": "united arab emirates", "uae": "united arab emirates",
    "saudi arabia": "saudi arabia", "ksa": "saudi arabia", "qatar": "qatar", "oman": "oman", "kuwait": "kuwait",
    "bahrain": "bahrain", "israel": "israel", "pakistan": "pakistan", "bangladesh": "bangladesh",
    "sri lanka": "sri lanka", "nepal": "nepal", "brazil": "brazil", "mexico": "mexico", "argentina": "argentina",
    "south africa": "south africa", "nigeria": "nigeria", "kenya": "kenya", "egypt": "egypt",
}

INDIAN_STATES = {
    "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "gujarat", "haryana",
    "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra", "manipur", "meghalaya",
    "mizoram", "nagaland", "odisha", "orissa", "punjab", "rajasthan", "sikkim", "tamil nadu", "telangana", "tripura",
    "uttar pradesh", "uttarakhand", "west bengal", "jammu and kashmir", "ladakh", "puducherry", "pondicherry",
}

# Common cities outside India, so a resume giving only a city still gets a country.
FOREIGN_CITIES = {
    "san francisco": "united states", "new york": "united states", "nyc": "united states", "seattle": "united states",
    "austin": "united states", "boston": "united states", "chicago": "united states", "los angeles": "united states",
    "san jose": "united states", "mountain view": "united states", "palo alto": "united states",
    "sunnyvale": "united states", "bay area": "united states", "london": "united kingdom",
    "manchester": "united kingdom", "edinburgh": "united kingdom", "dublin": "ireland", "berlin": "germany",
    "munich": "germany", "amsterdam": "netherlands", "paris": "france", "zurich": "switzerland",
    "stockholm": "sweden", "toronto": "canada", "vancouver": "canada", "sydney": "australia",
    "melbourne": "australia", "dubai": "united arab emirates", "abu dhabi": "united arab emirates",
    "riyadh": "saudi arabia", "doha": "qatar", "kuala lumpur": "malaysia", "jakarta": "indonesia",
    "bangkok": "thailand", "tokyo": "japan", "seoul": "south korea", "tel aviv": "israel", "karachi": "pakistan",
    "lahore": "pakistan", "dhaka": "bangladesh", "colombo": "sri lanka", "kathmandu": "nepal",
}


def _words(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s.lower())).strip()


def country_key(raw: str) -> str:
    """A country as the caller wrote it -> its key: 'USA' -> 'united states'. Unknown names pass through lowercased."""
    s = _words(raw)
    return COUNTRY_ALIASES.get(s, s)


def location_countries(raw: str | None) -> list[str]:
    """Countries a location string places someone in: 'Remote (India, SEA)' -> ['india'];
    'Whitefield, Bangalore' -> ['india']; 'Berlin' -> ['germany']. Empty when nothing is recognised."""
    if not raw:
        return []
    s = re.sub(r"(?<=\w)-(?=\w)", " ", raw.lower())
    out: list[str] = []
    for seg in re.split(r"[,/()|;-]", s):
        seg = _words(seg)
        key = _segment_key(seg) if seg else None
        country = (
            COUNTRY_ALIASES.get(seg)
            or FOREIGN_CITIES.get(seg)
            or ("india" if seg in INDIAN_STATES or (key in KNOWN_CITIES and key != "remote") else None)
        )
        if country and country not in out:
            out.append(country)
    return out


def is_country(raw: str) -> bool:
    return _words(raw) in COUNTRY_ALIASES


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
