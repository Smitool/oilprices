"""Download US crude oil imports from the EIA API and build site/data/imports.json.

Runs on GitHub Actions (weekly). Needs the free EIA API key in the repository
secret EIA_API_KEY. Uses only the Python standard library.

What it does
1. Asks the EIA API which facet codes mean "Country" (origin) and "Port"
   (destination), so it never double-counts regions, states or PADDs.
2. Downloads every monthly row from START onwards, page by page.
3. Adds map coordinates: origins at each country's main export hub,
   destinations at the port (or the state's centre if the port is unknown).
4. Writes a compact JSON file for the map, and a plain-HTML summary of the
   latest month into site/imports.html so search engines can read it.

If the download fails, the existing files are kept and the job still deploys.
"""

import calendar
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "site" / "data" / "imports.json"
PAGE = ROOT / "site" / "imports.html"
SITEMAP = ROOT / "site" / "sitemap.xml"
API = "https://api.eia.gov/v2/crude-oil-imports"
START = os.environ.get("IMPORTS_START", "2025-01")
PAGE_SIZE = 5000

# --------------------------------------------------------------------------
# Origin countries: [longitude, latitude] of the main crude export hub.
# Keys are normalised names (see norm()). Aliases point to the same entry.
# --------------------------------------------------------------------------
COUNTRIES = {
    "canada": ("Canada", -111.3, 52.7),            # Hardisty, Alberta
    "mexico": ("Mexico", -93.2, 18.4),             # Dos Bocas / Bay of Campeche
    "saudi arabia": ("Saudi Arabia", 50.16, 26.64),  # Ras Tanura
    "iraq": ("Iraq", 48.8, 29.7),                  # Basrah terminal
    "kuwait": ("Kuwait", 48.15, 29.07),
    "united arab emirates": ("United Arab Emirates", 56.33, 25.12),
    "qatar": ("Qatar", 51.55, 25.9),
    "oman": ("Oman", 58.5, 23.63),
    "bahrain": ("Bahrain", 50.6, 26.1),
    "iran": ("Iran", 50.3, 29.23),
    "yemen": ("Yemen", 45.0, 12.8),
    "nigeria": ("Nigeria", 7.15, 4.43),
    "angola": ("Angola", 12.3, -6.9),
    "cameroon": ("Cameroon", 9.4, 3.8),
    "gabon": ("Gabon", 8.8, -0.7),
    "congo brazzaville": ("Congo (Brazzaville)", 11.84, -4.95),
    "congo kinshasa": ("Congo (Kinshasa)", 12.35, -5.93),
    "equatorial guinea": ("Equatorial Guinea", 8.78, 3.75),
    "ghana": ("Ghana", -1.75, 4.9),
    "cote divoire": ("Côte d'Ivoire", -4.0, 5.3),
    "chad": ("Chad", 9.9, 2.9),                    # exported via Kribi, Cameroon
    "niger": ("Niger", 2.4, 6.35),                 # exported via Benin
    "libya": ("Libya", 18.7, 30.6),
    "algeria": ("Algeria", 6.9, 36.9),
    "egypt": ("Egypt", 32.35, 29.6),
    "tunisia": ("Tunisia", 10.2, 36.8),
    "sudan": ("Sudan", 37.2, 19.6),
    "south sudan": ("South Sudan", 37.2, 19.6),    # exported via Port Sudan
    "senegal": ("Senegal", -17.4, 14.7),
    "mauritania": ("Mauritania", -16.0, 18.1),
    "south africa": ("South Africa", 18.4, -33.9),
    "brazil": ("Brazil", -45.0, -24.5),            # Santos basin
    "colombia": ("Colombia", -75.7, 9.4),          # Coveñas
    "ecuador": ("Ecuador", -79.7, 0.97),           # Esmeraldas
    "guyana": ("Guyana", -57.5, 7.5),
    "venezuela": ("Venezuela", -64.8, 10.1),
    "trinidad and tobago": ("Trinidad and Tobago", -61.5, 10.3),
    "argentina": ("Argentina", -62.27, -38.78),
    "peru": ("Peru", -81.3, -4.6),
    "chile": ("Chile", -71.6, -33.0),
    "bolivia": ("Bolivia", -63.2, -17.8),
    "suriname": ("Suriname", -55.2, 5.8),
    "belize": ("Belize", -88.5, 17.3),
    "guatemala": ("Guatemala", -90.5, 15.5),
    "bahamas": ("Bahamas", -78.7, 26.5),
    "panama": ("Panama", -79.5, 9.0),
    "aruba": ("Aruba", -70.0, 12.5),
    "curacao": ("Curaçao", -68.9, 12.1),
    "netherlands antilles": ("Netherlands Antilles", -68.9, 12.1),
    "dominican republic": ("Dominican Republic", -69.9, 18.5),
    "jamaica": ("Jamaica", -76.8, 18.0),
    "barbados": ("Barbados", -59.6, 13.1),
    "virgin islands": ("Virgin Islands", -64.8, 17.7),
    "norway": ("Norway", 5.03, 60.8),
    "united kingdom": ("United Kingdom", -1.2, 57.4),
    "netherlands": ("Netherlands", 4.1, 51.95),
    "denmark": ("Denmark", 8.0, 55.5),
    "germany": ("Germany", 8.1, 53.5),
    "france": ("France", 5.0, 43.4),
    "italy": ("Italy", 15.2, 37.2),
    "spain": ("Spain", -3.0, 36.7),
    "belgium": ("Belgium", 4.3, 51.3),
    "sweden": ("Sweden", 11.9, 57.7),
    "finland": ("Finland", 26.0, 60.4),
    "estonia": ("Estonia", 24.7, 59.4),
    "lithuania": ("Lithuania", 21.1, 55.7),
    "latvia": ("Latvia", 21.0, 56.5),
    "poland": ("Poland", 18.6, 54.4),
    "portugal": ("Portugal", -8.9, 37.95),
    "greece": ("Greece", 23.6, 37.95),
    "albania": ("Albania", 19.5, 41.0),
    "turkey": ("Turkey", 35.9, 36.85),             # Ceyhan
    "cyprus": ("Cyprus", 33.0, 34.7),
    "israel": ("Israel", 34.6, 31.8),
    "russia": ("Russia", 28.6, 60.35),             # Primorsk
    "kazakhstan": ("Kazakhstan", 37.8, 44.7),      # CPC terminal, Novorossiysk
    "azerbaijan": ("Azerbaijan", 35.9, 36.85),     # BTC pipeline, Ceyhan
    "georgia": ("Georgia", 41.65, 42.15),
    "australia": ("Australia", 115.9, -21.7),
    "indonesia": ("Indonesia", 101.4, 1.7),
    "malaysia": ("Malaysia", 100.3, 5.4),
    "brunei": ("Brunei", 114.9, 4.9),
    "china": ("China", 121.5, 31.2),
    "vietnam": ("Vietnam", 107.1, 10.3),
    "thailand": ("Thailand", 100.9, 13.1),
    "papua new guinea": ("Papua New Guinea", 147.2, -9.4),
    "timor leste": ("Timor-Leste", 125.6, -8.6),
    "india": ("India", 72.9, 19.0),
    "singapore": ("Singapore", 103.8, 1.3),
    "south korea": ("South Korea", 129.3, 35.5),
    "japan": ("Japan", 139.8, 35.5),
    "philippines": ("Philippines", 121.0, 14.6),
    "new zealand": ("New Zealand", 174.3, -39.1),
    "mongolia": ("Mongolia", 106.9, 47.9),
}
ALIASES = {
    "congo": "congo brazzaville",
    "republic of the congo": "congo brazzaville",
    "republic of congo": "congo brazzaville",
    "democratic republic of the congo": "congo kinshasa",
    "democratic republic of congo": "congo kinshasa",
    "dem rep congo": "congo kinshasa",
    "ivory coast": "cote divoire",
    "korea south": "south korea",
    "korea republic of": "south korea",
    "uk": "united kingdom",
    "great britain": "united kingdom",
    "russian federation": "russia",
    "uae": "united arab emirates",
    "viet nam": "vietnam",
    "east timor": "timor leste",
    "burma": "myanmar",
    "turkiye": "turkey",
}

# --------------------------------------------------------------------------
# US ports of entry: "CITY|ST" -> [longitude, latitude]. Unknown ports fall
# back to the state's centre (STATES) and are marked approximate.
# --------------------------------------------------------------------------
PORTS = {
    # Texas
    "PORT ARTHUR|TX": (-93.93, 29.87), "HOUSTON|TX": (-95.27, 29.73), "TEXAS CITY|TX": (-94.90, 29.38),
    "CORPUS CHRISTI|TX": (-97.40, 27.81), "FREEPORT|TX": (-95.31, 28.95), "BEAUMONT|TX": (-94.10, 30.08),
    "GALVESTON|TX": (-94.80, 29.30), "SABINE|TX": (-93.87, 29.73), "SABINE PASS|TX": (-93.87, 29.73),
    "PORT LAVACA|TX": (-96.63, 28.62), "INGLESIDE|TX": (-97.21, 27.82), "BROWNSVILLE|TX": (-97.40, 25.95),
    "NEDERLAND|TX": (-93.99, 29.97), "BAYTOWN|TX": (-94.98, 29.74), "DEER PARK|TX": (-95.12, 29.70),
    "PASADENA|TX": (-95.20, 29.72), "EL PASO|TX": (-106.44, 31.76), "LAREDO|TX": (-99.50, 27.51),
    "VICTORIA|TX": (-97.00, 28.80), "SAN ANTONIO|TX": (-98.49, 29.42), "DALLAS FORT WORTH|TX": (-97.04, 32.90),
    # Louisiana
    "LAKE CHARLES|LA": (-93.22, 30.23), "NEW ORLEANS|LA": (-90.07, 29.95), "MORGAN CITY|LA": (-91.20, 29.70),
    "BATON ROUGE|LA": (-91.19, 30.45), "GRAMERCY|LA": (-90.69, 30.05), "GARYVILLE|LA": (-90.62, 30.06),
    "CHALMETTE|LA": (-89.96, 29.94), "BELLE CHASSE|LA": (-90.00, 29.85), "ST ROSE|LA": (-90.32, 29.95),
    "SAINT ROSE|LA": (-90.32, 29.95), "CONVENT|LA": (-90.83, 30.02), "NORCO|LA": (-90.41, 29.99),
    "MERAUX|LA": (-89.92, 29.93), "DESTREHAN|LA": (-90.37, 29.94), "GRETNA|LA": (-90.05, 29.91),
    "PORT FOURCHON|LA": (-90.20, 29.11), "LOOP|LA": (-90.03, 28.88), "LOUISIANA OFFSHORE OIL PORT|LA": (-90.03, 28.88),
    "LAFAYETTE|LA": (-92.02, 30.22), "VENICE|LA": (-89.35, 29.28), "PLAQUEMINE|LA": (-91.23, 30.29),
    # Gulf, other
    "PASCAGOULA|MS": (-88.56, 30.35), "GULFPORT|MS": (-89.09, 30.36), "MOBILE|AL": (-88.04, 30.69),
    "TAMPA|FL": (-82.45, 27.95), "PORT EVERGLADES|FL": (-80.12, 26.09), "JACKSONVILLE|FL": (-81.66, 30.33),
    "MIAMI|FL": (-80.19, 25.77), "PANAMA CITY|FL": (-85.66, 30.16),
    # East coast
    "PHILADELPHIA|PA": (-75.17, 39.95), "MARCUS HOOK|PA": (-75.42, 39.82), "CHESTER|PA": (-75.36, 39.85),
    "PAULSBORO|NJ": (-75.24, 39.83), "PERTH AMBOY|NJ": (-74.27, 40.51), "LINDEN|NJ": (-74.24, 40.62),
    "NEWARK|NJ": (-74.15, 40.70), "BAYONNE|NJ": (-74.11, 40.67), "CAMDEN|NJ": (-75.12, 39.94),
    "WESTVILLE|NJ": (-75.13, 39.87), "DELAWARE CITY|DE": (-75.59, 39.58), "WILMINGTON|DE": (-75.55, 39.74),
    "NEW YORK|NY": (-74.01, 40.70), "NEW YORK CITY|NY": (-74.01, 40.70), "ALBANY|NY": (-73.75, 42.65),
    "BUFFALO|NY": (-78.88, 42.89), "OGDENSBURG|NY": (-75.49, 44.69), "CHAMPLAIN|NY": (-73.45, 44.99),
    "MASSENA|NY": (-74.89, 44.93), "PORTLAND|ME": (-70.25, 43.66), "BALTIMORE|MD": (-76.58, 39.27),
    "NORFOLK|VA": (-76.29, 36.85), "YORKTOWN|VA": (-76.51, 37.24), "BOSTON|MA": (-71.05, 42.36),
    "PROVIDENCE|RI": (-71.40, 41.82), "NEW HAVEN|CT": (-72.92, 41.30), "SAVANNAH|GA": (-81.10, 32.08),
    "CHARLESTON|SC": (-79.93, 32.78), "WILMINGTON|NC": (-77.95, 34.21),
    # West coast and Pacific
    "LOS ANGELES|CA": (-118.26, 33.74), "LONG BEACH|CA": (-118.22, 33.75), "EL SEGUNDO|CA": (-118.42, 33.92),
    "SAN FRANCISCO|CA": (-122.39, 37.79), "RICHMOND|CA": (-122.37, 37.93), "MARTINEZ|CA": (-122.13, 38.02),
    "BENICIA|CA": (-122.16, 38.05), "RODEO|CA": (-122.27, 38.03), "CARSON|CA": (-118.26, 33.83),
    "SAN PEDRO|CA": (-118.29, 33.74), "WILMINGTON|CA": (-118.26, 33.78), "OAKLAND|CA": (-122.28, 37.80),
    "SANTA BARBARA|CA": (-119.70, 34.42), "SAN DIEGO|CA": (-117.17, 32.71), "PORT HUENEME|CA": (-119.21, 34.15),
    "ANACORTES|WA": (-122.61, 48.51), "FERNDALE|WA": (-122.59, 48.85), "TACOMA|WA": (-122.41, 47.27),
    "SEATTLE|WA": (-122.34, 47.60), "BLAINE|WA": (-122.75, 49.00), "SUMAS|WA": (-122.26, 49.00),
    "LYNDEN|WA": (-122.45, 48.95), "PORT ANGELES|WA": (-123.43, 48.12), "KALAMA|WA": (-122.85, 46.01),
    "PORTLAND|OR": (-122.68, 45.52), "NIKISKI|AK": (-151.38, 60.68), "KENAI|AK": (-151.26, 60.55),
    "ANCHORAGE|AK": (-149.89, 61.22), "VALDEZ|AK": (-146.35, 61.13), "HONOLULU|HI": (-157.87, 21.31),
    "BARBERS POINT|HI": (-158.11, 21.30), "KAPOLEI|HI": (-158.09, 21.33),
    # Northern border (mostly pipeline crude from Canada)
    "PEMBINA|ND": (-97.24, 48.97), "PORTAL|ND": (-102.55, 48.99), "NECHE|ND": (-97.55, 48.98),
    "NOONAN|ND": (-103.01, 48.89), "WALHALLA|ND": (-97.92, 48.92), "SHERWOOD|ND": (-101.63, 48.96),
    "SWEETGRASS|MT": (-111.96, 48.99), "SWEET GRASS|MT": (-111.96, 48.99), "PORT OF MORGAN|MT": (-107.83, 49.00),
    "MORGAN|MT": (-107.83, 49.00), "RAYMOND|MT": (-104.58, 48.99), "WHITLASH|MT": (-111.26, 48.99),
    "HAVRE|MT": (-109.68, 48.55), "WILDHORSE|MT": (-110.18, 49.0), "TURNER|MT": (-108.39, 48.84),
    "NOYES|MN": (-97.20, 49.00), "INTERNATIONAL FALLS|MN": (-93.41, 48.60), "WARROAD|MN": (-95.31, 48.90),
    "DULUTH|MN": (-92.10, 46.78), "SUPERIOR|WI": (-92.10, 46.72), "DETROIT|MI": (-83.05, 42.33),
    "PORT HURON|MI": (-82.42, 42.97), "MARYSVILLE|MI": (-82.48, 42.91), "SAULT STE MARIE|MI": (-84.35, 46.50),
    "SAULT SAINTE MARIE|MI": (-84.35, 46.50), "CHICAGO|IL": (-87.63, 41.88), "TOLEDO|OH": (-83.54, 41.65),
    "CLEVELAND|OH": (-81.69, 41.50), "ERIE|PA": (-80.09, 42.13), "DERBY LINE|VT": (-72.10, 45.00),
    "HIGHGATE SPRINGS|VT": (-73.08, 45.01), "HOULTON|ME": (-67.84, 46.13), "CALAIS|ME": (-67.28, 45.19),
    "EASTPORT|ID": (-116.18, 48.99), "PORTHILL|ID": (-116.50, 48.99),
}

STATES = {  # abbreviation: (name, lon, lat) approximate centre
    "AL": ("Alabama", -86.8, 32.8), "AK": ("Alaska", -150.0, 61.4), "AZ": ("Arizona", -111.7, 34.3),
    "AR": ("Arkansas", -92.4, 34.9), "CA": ("California", -119.5, 37.2), "CO": ("Colorado", -105.5, 39.0),
    "CT": ("Connecticut", -72.7, 41.6), "DE": ("Delaware", -75.5, 39.0), "DC": ("District of Columbia", -77.0, 38.9),
    "FL": ("Florida", -81.7, 28.1), "GA": ("Georgia", -83.4, 32.7), "HI": ("Hawaii", -157.5, 21.1),
    "ID": ("Idaho", -114.6, 44.4), "IL": ("Illinois", -89.2, 40.0), "IN": ("Indiana", -86.3, 39.9),
    "IA": ("Iowa", -93.5, 42.1), "KS": ("Kansas", -98.4, 38.5), "KY": ("Kentucky", -85.3, 37.5),
    "LA": ("Louisiana", -91.9, 31.0), "ME": ("Maine", -69.2, 45.3), "MD": ("Maryland", -76.8, 39.0),
    "MA": ("Massachusetts", -71.8, 42.3), "MI": ("Michigan", -84.7, 43.6), "MN": ("Minnesota", -94.3, 46.3),
    "MS": ("Mississippi", -89.7, 32.7), "MO": ("Missouri", -92.5, 38.4), "MT": ("Montana", -109.6, 47.0),
    "NE": ("Nebraska", -99.8, 41.5), "NV": ("Nevada", -116.6, 39.3), "NH": ("New Hampshire", -71.6, 43.7),
    "NJ": ("New Jersey", -74.7, 40.2), "NM": ("New Mexico", -106.1, 34.4), "NY": ("New York", -75.5, 42.9),
    "NC": ("North Carolina", -79.4, 35.6), "ND": ("North Dakota", -100.5, 47.5), "OH": ("Ohio", -82.8, 40.3),
    "OK": ("Oklahoma", -97.5, 35.6), "OR": ("Oregon", -120.6, 43.9), "PA": ("Pennsylvania", -77.8, 40.9),
    "RI": ("Rhode Island", -71.5, 41.7), "SC": ("South Carolina", -80.9, 33.9), "SD": ("South Dakota", -100.2, 44.4),
    "TN": ("Tennessee", -86.3, 35.9), "TX": ("Texas", -99.3, 31.5), "UT": ("Utah", -111.7, 39.3),
    "VT": ("Vermont", -72.7, 44.1), "VA": ("Virginia", -78.8, 37.5), "WA": ("Washington", -120.5, 47.4),
    "WV": ("West Virginia", -80.6, 38.6), "WI": ("Wisconsin", -89.9, 44.6), "WY": ("Wyoming", -107.5, 43.0),
    "PR": ("Puerto Rico", -66.5, 18.2), "VI": ("U.S. Virgin Islands", -64.8, 17.7), "GU": ("Guam", 144.8, 13.4),
}
STATE_BY_NAME = {norm_name.upper(): abbr for abbr, (norm_name, _, _) in STATES.items()}


def norm(s):
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = s.replace("cote d ivoire", "cote divoire")
    return re.sub(r"\s+", " ", s).strip()


def country_point(name):
    key = norm(name)
    key = ALIASES.get(key, key)
    hit = COUNTRIES.get(key)
    if hit:
        return hit
    return None


def parse_port(name):
    """'PORT ARTHUR, TX' / 'Port Arthur, Texas' -> ('PORT ARTHUR', 'TX')."""
    raw = name.strip()
    city, state = raw, ""
    if "," in raw:
        city, state = raw.rsplit(",", 1)
    else:
        m = re.match(r"^(.*)\s+([A-Za-z]{2})$", raw)
        if m:
            city, state = m.group(1), m.group(2)
    state = state.strip().upper().replace(".", "")
    if state not in STATES:
        state = STATE_BY_NAME.get(state, "")
    city = re.sub(r"[^A-Z0-9 ]+", " ", city.upper())
    city = re.sub(r"\s+", " ", city).strip()
    return city, state


def port_point(name):
    city, state = parse_port(name)
    for key in (f"{city}|{state}", f"{city.replace('SAINT ', 'ST ')}|{state}", f"{city.replace('ST ', 'SAINT ')}|{state}"):
        if key in PORTS:
            lon, lat = PORTS[key]
            return state, lon, lat, False
    if state in STATES:
        _, lon, lat = STATES[state]
        return state, lon, lat, True
    return state, -98.6, 39.8, True  # centre of the contiguous US


# --------------------------------------------------------------------------
# EIA API
# --------------------------------------------------------------------------
def get(url, attempts=4):
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # network hiccups, rate limits
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"EIA request failed: {last}")


def facet_codes(key, facet, want):
    """Return the facet id whose name matches `want` (e.g. 'country', 'port')."""
    url = f"{API}/facet/{facet}?" + urllib.parse.urlencode({"api_key": key})
    try:
        facets = get(url)["response"]["facets"]
    except Exception as e:
        print(f"Could not list facet {facet}: {e}", file=sys.stderr)
        return None
    names = {f["id"]: (f.get("name") or "").strip().lower() for f in facets}
    print(f"{facet} values: {names}")
    for fid, nm in names.items():
        if nm == want:
            return fid
    for fid, nm in names.items():
        if want in nm and not any(x in nm for x in ("state", "padd", "region", "world")):
            return fid
    return None


def fetch_rows(key):
    origin_code = facet_codes(key, "originType", "country") or "CTY"
    dest_code = facet_codes(key, "destinationType", "port") or "PT"
    print(f"Using originType={origin_code}, destinationType={dest_code}")
    rows, offset, total = [], 0, None
    while total is None or offset < total:
        params = [
            ("api_key", key), ("frequency", "monthly"), ("data[0]", "quantity"),
            ("facets[originType][]", origin_code), ("facets[destinationType][]", dest_code),
            ("start", START), ("sort[0][column]", "period"), ("sort[0][direction]", "desc"),
            ("offset", str(offset)), ("length", str(PAGE_SIZE)),
        ]
        resp = get(f"{API}/data/?" + urllib.parse.urlencode(params))["response"]
        total = int(resp.get("total", 0))
        batch = resp.get("data", [])
        rows.extend(batch)
        print(f"  fetched {len(rows)} / {total}")
        if not batch:
            break
        offset += PAGE_SIZE
    return rows


# --------------------------------------------------------------------------
# Build the map data
# --------------------------------------------------------------------------
def build(rows):
    agg = defaultdict(float)
    origins, ports, grades = {}, {}, {}
    units = None
    unknown_c, approx_p = set(), set()

    for r in rows:
        try:
            q = float(r.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
        if q <= 0:
            continue
        period = str(r.get("period", ""))[:7]
        oname = (r.get("originName") or "").strip()
        dname = (r.get("destinationName") or "").strip()
        gid = (r.get("gradeId") or r.get("gradeName") or "ALL").strip()
        if not (period and oname and dname):
            continue
        units = units or r.get("quantity-units")
        grades.setdefault(gid, (r.get("gradeName") or gid).strip())

        if oname not in origins:
            hit = country_point(oname)
            if hit:
                origins[oname] = {"name": hit[0], "lon": hit[1], "lat": hit[2]}
            else:
                origins[oname] = {"name": oname.title() if oname.isupper() else oname, "lon": None, "lat": None}
                unknown_c.add(oname)
        if dname not in ports:
            state, lon, lat, approx = port_point(dname)
            city, _ = parse_port(dname)
            label = f"{city.title()}, {state}" if state else dname.title()
            ports[dname] = {"name": label, "state": state, "lon": lon, "lat": lat, "approx": approx}
            if approx:
                approx_p.add(dname)
        agg[(period, oname, dname, gid)] += q

    periods = sorted({k[0] for k in agg})
    o_list = sorted(origins, key=lambda k: origins[k]["name"])
    p_list = sorted(ports, key=lambda k: ports[k]["name"])
    g_order = ["LSW", "LSO", "MED", "HSW", "HSO"]
    g_list = sorted(grades, key=lambda g: (g_order.index(g) if g in g_order else 99, grades[g]))
    oi = {k: i for i, k in enumerate(o_list)}
    pi = {k: i for i, k in enumerate(p_list)}
    gi = {k: i for i, k in enumerate(g_list)}
    ti = {k: i for i, k in enumerate(periods)}

    data = {
        "updated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": "U.S. Energy Information Administration, Form EIA-814 (company-level imports)",
        "units": units or "thousand barrels",
        "periods": periods,
        "grades": [{"id": g, "name": grades[g]} for g in g_list],
        "origins": [origins[k] for k in o_list],
        "ports": [ports[k] for k in p_list],
        "rows": [[ti[p], oi[o], pi[d], gi[g], round(v, 3)] for (p, o, d, g), v in sorted(agg.items())],
    }
    if unknown_c:
        print("Countries without coordinates (add them to COUNTRIES):", sorted(unknown_c), file=sys.stderr)
    if approx_p:
        print("Ports shown at state centre (add them to PORTS):", sorted(approx_p), file=sys.stderr)
    return data


# --------------------------------------------------------------------------
# Plain-HTML summary for search engines
# --------------------------------------------------------------------------
def fmt_barrels(b):
    if b >= 1e9:
        return f"{b / 1e9:.2f} billion"
    if b >= 1e6:
        return f"{b / 1e6:.1f} million"
    return f"{b:,.0f}"


def summary_html(data):
    if not data["periods"]:
        return ""
    last = len(data["periods"]) - 1
    period = data["periods"][last]
    y, m = map(int, period.split("-"))
    days = calendar.monthrange(y, m)[1]
    month_name = f"{calendar.month_name[m]} {y}"
    mult = 1000 if "thousand" in data["units"].lower() else 1

    by_origin, by_port = defaultdict(float), defaultdict(float)
    for t, o, p, g, q in data["rows"]:
        if t == last:
            by_origin[o] += q * mult
            by_port[p] += q * mult
    total = sum(by_origin.values())
    if total <= 0:
        return ""
    top = sorted(by_origin.items(), key=lambda x: -x[1])
    top_ports = sorted(by_port.items(), key=lambda x: -x[1])[:5]
    oname = lambda i: html.escape(data["origins"][i]["name"])
    pname = lambda i: html.escape(data["ports"][i]["name"])

    parts = [f"{oname(i)} ({v / total:.0%})" for i, v in top[:3]]
    lead3 = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
    per_day = total / days
    per_day_txt = f"{per_day / 1e6:.2f} million" if per_day >= 1e6 else f"{round(per_day, -3):,.0f}"
    port_names = [pname(i) for i, _ in top_ports[:3]]
    ports_txt = port_names[0] if len(port_names) == 1 else "; ".join(port_names[:-1]) + "; and " + port_names[-1]
    out = [
        f'<p class="summary-lead">In {month_name}, the United States imported '
        f"<strong>{fmt_barrels(total)} barrels</strong> of crude oil, about "
        f"{per_day_txt} barrels per day, from {len(top)} countries. "
        f"The largest suppliers were {lead3}. The busiest ports of entry were {ports_txt}.</p>",
        f'<table class="summary-table"><caption>Top suppliers of crude oil to the US, {month_name}</caption>',
        '<thead><tr><th scope="col">Country</th><th scope="col">Barrels</th>'
        '<th scope="col">Barrels per day</th><th scope="col">Share</th></tr></thead><tbody>',
    ]
    for i, v in top[:10]:
        out.append(
            f'<tr><th scope="row">{oname(i)}</th><td>{fmt_barrels(v)}</td>'
            f"<td>{round(v / days, -2):,.0f}</td><td>{v / total:.1%}</td></tr>"
        )
    out.append("</tbody></table>")
    return "\n".join(out)


def write_summary(data):
    if not PAGE.exists():
        return
    page = PAGE.read_text(encoding="utf-8")
    start, end = "<!-- SUMMARY:START -->", "<!-- SUMMARY:END -->"
    if start not in page or end not in page:
        return
    a = page.index(start) + len(start)
    b = page.index(end)
    page = page[:a] + "\n" + summary_html(data) + "\n" + page[b:]
    PAGE.write_text(page, encoding="utf-8")


def write_dates(data):
    """Tell search engines the imports page changed: sitemap lastmod + Dataset dates."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if PAGE.exists() and data["periods"]:
        page = PAGE.read_text(encoding="utf-8")
        page = re.sub(r'"dateModified": "[^"]*"', f'"dateModified": "{today}"', page)
        page = re.sub(r'"temporalCoverage": "[^"]*"', f'"temporalCoverage": "{data["periods"][0]}/{data["periods"][-1]}"', page)
        PAGE.write_text(page, encoding="utf-8")
    if SITEMAP.exists():
        sm = SITEMAP.read_text(encoding="utf-8")
        sm = re.sub(r"(<loc>https://oilprices\.io/imports\.html</loc><lastmod>)[^<]*(</lastmod>)", rf"\g<1>{today}\g<2>", sm)
        SITEMAP.write_text(sm, encoding="utf-8")


def set_output(changed):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
    print(f"changed={changed}")


def main():
    key = os.environ.get("EIA_API_KEY", "").strip()
    if not key:
        print("EIA_API_KEY is not set; skipping the imports update.")
        set_output(False)
        return 0
    try:
        rows = fetch_rows(key)
        data = build(rows)
    except Exception as e:
        print(f"Imports update failed, keeping the previous data: {e}", file=sys.stderr)
        set_output(False)
        return 0
    if not data["rows"]:
        print("No rows returned; keeping the previous data.", file=sys.stderr)
        set_output(False)
        return 0

    old = None
    if OUT_JSON.exists():
        try:
            old = json.loads(OUT_JSON.read_text())
        except Exception:
            old = None
    if old and {k: v for k, v in old.items() if k != "updated"} == {k: v for k, v in data.items() if k != "updated"}:
        set_output(False)
        return 0

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    write_summary(data)
    write_dates(data)
    print(f"Wrote {len(data['rows'])} rows for {len(data['periods'])} months.")
    set_output(True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
