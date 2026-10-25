"""Download the weekly US average retail prices of regular gasoline and diesel
from the EIA API, for the fuel cost calculator.

Runs on GitHub Actions (EIA publishes these prices weekly, usually on Tuesday).
Needs the free EIA API key in the repository secret EIA_API_KEY.
Uses only the Python standard library.

Writes site/data/fuel.json (the last 10 years, for the calculator and its
history chart) and the marked sections of site/tools/fuel-cost-calculator.html
(this week's prices, prices by year, and FAQ answers), so the numbers are also
plain text that search engines can read. Only writes when EIA has new data.

For a local test without a key, set FUEL_SAMPLE to a JSON file {"weekly": [rows]}.
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "site" / "data" / "fuel.json"
PAGE = ROOT / "site" / "tools" / "fuel-cost-calculator.html"
SITEMAP = ROOT / "site" / "sitemap.xml"
PAGE_URL = "https://oilprices.io/tools/fuel-cost-calculator.html"
API = "https://api.eia.gov/v2/petroleum/pri/gnd/data/"
SERIES = {"EMM_EPMR_PTE_NUS_DPG": "gasoline", "EMD_EPD2D_PTE_NUS_DPG": "diesel"}
PRODUCTS = {"EPMR": "gasoline", "EPD2D": "diesel"}  # fallback filter: US (NUS), retail (PTE)
WEEKS = 530  # a little over 10 years
LITRES_PER_GALLON = 3.785411784


def get(url, attempts=4):
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"EIA request failed: {last}")


def fetch(key):
    base = [("api_key", key), ("frequency", "weekly"), ("data[0]", "value"),
            ("sort[0][column]", "period"), ("sort[0][direction]", "desc"),
            ("offset", "0"), ("length", str(WEEKS * 2 + 20))]
    rows = get(API + "?" + urllib.parse.urlencode(base + [("facets[series][]", s) for s in SERIES]))
    rows = rows.get("response", {}).get("data", [])
    if not rows:
        params = base + [("facets[duoarea][]", "NUS"), ("facets[process][]", "PTE")] + [("facets[product][]", p) for p in PRODUCTS]
        rows = get(API + "?" + urllib.parse.urlencode(params)).get("response", {}).get("data", [])
    return rows


def to_series(rows):
    out = {"gasoline": {}, "diesel": {}}
    for r in rows:
        which = SERIES.get(str(r.get("series", "")))
        if not which and str(r.get("duoarea", "NUS")) == "NUS" and str(r.get("process", "PTE")) == "PTE":
            which = PRODUCTS.get(str(r.get("product", "")))
        if not which:
            continue
        try:
            v = round(float(r.get("value")), 3)
        except (TypeError, ValueError):
            continue
        k = str(r.get("period", ""))[:10]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", k) and v > 0:
            out[which][k] = v
    return {w: sorted(s.items())[-WEEKS:] for w, s in out.items()}


def long_date(s):
    x = datetime.strptime(s, "%Y-%m-%d")
    return f"{x.day} {x.strftime('%B')} {x.year}"


def per_litre(v):
    return v / LITRES_PER_GALLON


def now_html(s):
    gk, gv = s["gasoline"][-1]
    dk, dv = s["diesel"][-1]
    cutoff = (datetime.strptime(gk, "%Y-%m-%d") - timedelta(days=364)).strftime("%Y-%m-%d")
    prev = [v for k, v in s["gasoline"] if k <= cutoff]
    year_ago = f" A year earlier, regular gasoline averaged ${prev[-1]:.2f}." if prev else ""
    return (f'<p class="fuel-now-lead">In the week of {long_date(gk)}, a gallon of regular gasoline cost '
            f'<strong>${gv:.2f}</strong> on average in the United States (<strong>${per_litre(gv):.2f}</strong> a litre), '
            f'and a gallon of diesel cost <strong>${dv:.2f}</strong> (${per_litre(dv):.2f} a litre).{year_ago}</p>\n'
            f'<p class="small-print">Source: U.S. Energy Information Administration, weekly retail prices, all formulations, '
            f'including taxes. EIA publishes new prices every week; this page updates the next day.</p>')


def years_html(s):
    years = {}
    for which in ("gasoline", "diesel"):
        for k, v in s[which]:
            years.setdefault(k[:4], {}).setdefault(which, []).append(v)
    last_year = max(years)
    rows = []
    for y in sorted(years, reverse=True):
        g, d = years[y].get("gasoline"), years[y].get("diesel")
        first_week = min(k for k, _ in s["gasoline"] if k.startswith(y)) if g else ""
        if not g or (y != last_year and first_week > f"{y}-01-14"):  # skip a partial first year
            continue
        label = f"{y} (to date)" if y == last_year else y
        gtxt = f"${sum(g) / len(g):.2f}" if g else "–"
        dtxt = f"${sum(d) / len(d):.2f}" if d else "–"
        rows.append(f'<tr><th scope="row">{label}</th><td>{gtxt}</td><td>{dtxt}</td></tr>')
    return ('<table class="summary-table"><caption>Average US retail price per gallon, by year</caption><thead><tr>'
            '<th scope="col">Year</th><th scope="col">Regular gasoline</th><th scope="col">Diesel</th></tr></thead><tbody>\n'
            + "\n".join(rows) + "\n</tbody></table>")


def faq_html(s):
    gk, gv = s["gasoline"][-1]
    cost_100mi = 100 / 30 * gv
    cost_100km = 7 * per_litre(gv)
    low = min(s["gasoline"], key=lambda p: p[1])
    high = max(s["gasoline"], key=lambda p: p[1])
    return (f"<h3>What is the average gas price in the US today?</h3>\n"
            f"<p>In the week of {long_date(gk)}, regular gasoline averaged <strong>${gv:.2f}</strong> a gallon across the United States, "
            f"according to the U.S. Energy Information Administration. Over the past 10 years, the weekly average has ranged from "
            f"${low[1]:.2f} (week of {long_date(low[0])}) to ${high[1]:.2f} (week of {long_date(high[0])}).</p>\n"
            f"<h3>How much does it cost to drive 100 miles?</h3>\n"
            f"<p>With a car that does 30 miles per gallon and gasoline at the US average of ${gv:.2f}, 100 miles uses 3.33 gallons "
            f"and costs about <strong>${cost_100mi:.2f}</strong>. In metric terms, a car using 7 litres per 100 km costs about "
            f"${cost_100km:.2f} per 100 km at the same price. Enter your own car and price above for an exact figure.</p>")


def replace_block(page, name, content):
    start, end = f"<!-- {name}:START -->", f"<!-- {name}:END -->"
    if start not in page or end not in page:
        print(f"Markers {name} not found; skipped.", file=sys.stderr)
        return page
    a, b = page.index(start) + len(start), page.index(end)
    return page[:a] + "\n" + content + "\n" + page[b:]


def set_output(changed):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
    print(f"changed={changed}")


def main():
    today = os.environ.get("FUEL_TODAY") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sample = os.environ.get("FUEL_SAMPLE")
    key = os.environ.get("EIA_API_KEY", "").strip()
    try:
        if sample:
            rows = json.loads(Path(sample).read_text())["weekly"]
        elif key:
            rows = fetch(key)
        else:
            print("EIA_API_KEY is not set; skipping the fuel price update.")
            set_output(False)
            return 0
        s = to_series(rows)
    except Exception as e:
        print(f"Fuel price update failed, keeping the previous data: {e}", file=sys.stderr)
        set_output(False)
        return 0
    if len(s["gasoline"]) < 52 or len(s["diesel"]) < 52:
        print("Not enough gasoline/diesel rows returned; keeping the previous data.", file=sys.stderr)
        set_output(False)
        return 0

    data = {
        "source": "U.S. Energy Information Administration, weekly US retail prices (regular gasoline and on-highway diesel), dollars per gallon",
        "gasoline": [[k, v] for k, v in s["gasoline"]],
        "diesel": [[k, v] for k, v in s["diesel"]],
    }
    try:
        old = json.loads(OUT_JSON.read_text())
    except Exception:
        old = None
    if old == data:
        print(f"No new EIA fuel prices (latest week {s['gasoline'][-1][0]}).")
        set_output(False)
        return 0

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, separators=(",", ":")))
    if PAGE.exists():
        page = PAGE.read_text(encoding="utf-8")
        page = replace_block(page, "FUELNOW", now_html(s))
        page = replace_block(page, "FUELYEARS", years_html(s))
        page = replace_block(page, "FUELFAQ", faq_html(s))
        page = re.sub(r'"dateModified": "[^"]*"', f'"dateModified": "{today}"', page)
        PAGE.write_text(page, encoding="utf-8")
    if SITEMAP.exists():
        sm = SITEMAP.read_text(encoding="utf-8")
        sm = re.sub(rf"(<loc>{re.escape(PAGE_URL)}</loc><lastmod>)[^<]*(</lastmod>)", rf"\g<1>{today}\g<2>", sm)
        SITEMAP.write_text(sm, encoding="utf-8")
    print(f"Wrote fuel prices to week {s['gasoline'][-1][0]}: gasoline ${s['gasoline'][-1][1]}, diesel ${s['diesel'][-1][1]}.")
    set_output(True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
