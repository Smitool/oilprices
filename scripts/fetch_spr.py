"""Download US Strategic Petroleum Reserve stocks (and the two figures the
estimates need) from the EIA API, for the SPR tracker page.

Series (EIA weekly petroleum supply, route petroleum/sum/sndw):
  WCSSTUS1  SPR ending stocks of crude oil, thousand barrels
  WRPUPUS2  US product supplied of petroleum products (total oil use), thousand barrels a day
  WCRNTUS2  US net imports of crude oil, thousand barrels a day

Runs on GitHub Actions (EIA publishes these on Wednesdays). Needs the free EIA
API key in the repository secret EIA_API_KEY. Uses only the standard library.
Writes site/data/spr.json and the marked sections of
site/tools/strategic-petroleum-reserve.html, only when EIA has new data.

For a local test without a key, set SPR_SAMPLE to a JSON file {"rows": [...]}.
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "site" / "data" / "spr.json"
PAGE = ROOT / "site" / "tools" / "strategic-petroleum-reserve.html"
SITEMAP = ROOT / "site" / "sitemap.xml"
PAGE_URL = "https://oilprices.io/tools/strategic-petroleum-reserve.html"
API = "https://api.eia.gov/v2/petroleum/sum/sndw/data/"
SERIES = {"WCSSTUS1": "level", "WRPUPUS2": "consumption", "WCRNTUS2": "netImports"}
CAPACITY = 714.0  # million barrels, authorized storage capacity (DOE)
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]


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
    rows = []
    for code, limit in (("WCSSTUS1", None), ("WRPUPUS2", 12), ("WCRNTUS2", 12)):
        offset = 0
        while True:
            length = 5000 if limit is None else limit
            params = [("api_key", key), ("frequency", "weekly"), ("data[0]", "value"), ("facets[series][]", code),
                      ("sort[0][column]", "period"), ("sort[0][direction]", "desc"),
                      ("offset", str(offset)), ("length", str(length))]
            resp = get(API + "?" + urllib.parse.urlencode(params)).get("response", {})
            batch = resp.get("data", [])
            rows.extend(batch)
            offset += len(batch)
            if limit is not None or not batch or offset >= int(resp.get("total") or 0):
                break
    return rows


def to_series(rows):
    out = {k: {} for k in SERIES.values()}
    for r in rows:
        which = SERIES.get(str(r.get("series", "")))
        try:
            v = float(r.get("value"))
        except (TypeError, ValueError):
            continue
        k = str(r.get("period", ""))[:10]
        if which and re.fullmatch(r"\d{4}-\d{2}-\d{2}", k):
            out[which][k] = round(v)
    return {k: sorted(v.items()) for k, v in out.items()}


def month_year(k):
    return f"{MONTHS[int(k[5:7]) - 1]} {k[:4]}"


def long_date(k):
    return f"{int(k[8:10])} {MONTHS[int(k[5:7]) - 1]} {k[:4]}"


def mb(v):
    return f"{v / 1000:,.1f}"


def year_ends(level):
    ends = {}
    for k, v in level:
        ends[k[:4]] = (k, v)  # the last week of each year wins
    return ends


def refill_pace(level):
    """The most recent calendar year in which the reserve grew: (year, million barrels a month)."""
    ends = year_ends(level)
    years = sorted(ends)
    for i in range(len(years) - 2, 0, -1):
        y, prev = years[i], years[i - 1]
        gain = (ends[y][1] - ends[prev][1]) / 1000
        if gain > 1:
            return {"year": int(y), "rate": round(gain / 12, 1)}
    return None


def low_since(level):
    k, cur = level[-1]
    for pk, pv in reversed(level[:-1]):
        if pv <= cur:
            gap = (datetime.strptime(k, "%Y-%m-%d") - datetime.strptime(pk, "%Y-%m-%d")).days
            return None if gap < 120 else month_year(pk)
    return "record"


def avg4(rows):
    vals = [v for _, v in rows[-4:]]
    return sum(vals) / len(vals) if vals else None


def now_html(s):
    level = s["level"]
    k, v = level[-1]
    year_ago = [pv for pk, pv in level if pk <= f"{int(k[:4]) - 1}{k[4:]}"]
    since = low_since(level)
    use, imp = avg4(s["consumption"]), avg4(s["netImports"])
    parts = [f"In the week ending {long_date(k)}, the Strategic Petroleum Reserve held <strong>{mb(v)} million barrels</strong> of crude oil, "
             f"{v / 10 / CAPACITY:.1f}% of its authorized capacity of 714 million barrels."]
    if year_ago:
        d = v - year_ago[-1]
        parts.append(f" That is {mb(abs(d))} million barrels {'more' if d > 0 else 'less'} than a year earlier.")
    if since == "record":
        parts.append(" It is the lowest level on record.")
    elif since:
        parts.append(f" It is the lowest level since {since}.")
    out = ["<p>" + "".join(parts) + "</p>"]
    if use:
        txt = (f"<p>At the average rate the United States used oil over the past four weeks, {use / 1000:.1f} million barrels a day, "
               f"the reserve would cover about <strong>{v / use:.0f} days</strong> of total US oil use on its own")
        if imp and imp > 0:
            txt += f", or about {v / imp:.0f} days of US net crude oil imports ({imp / 1000:.1f} million barrels a day)"
        out.append(txt + ".</p>")
    return "\n".join(out)


def why_html(s):
    level = s["level"]
    ends = year_ends(level)
    peak_k, peak_v = max(level, key=lambda p: p[1])
    k, v = level[-1]
    out = [f"<p>The reserve peaked at {mb(peak_v)} million barrels in {month_year(peak_k)}. Since then it has been drawn down by "
           f"mandated sales ordered by Congress, by a 180-million-barrel emergency sale in 2022 after Russia invaded Ukraine, and by the "
           f"2026 emergency release: after the Strait of Hormuz was closed in March 2026, the United States committed 172 million barrels "
           f"to a 400-million-barrel release coordinated by the International Energy Agency, mostly as exchanges that companies must repay "
           f"with extra barrels.</p>"]
    y0 = str(int(k[:4]) - 1)
    if y0 in ends:
        d = v - ends[y0][1]
        out.append(f"<p>Since the end of {y0}, the reserve has {'gained' if d > 0 else 'lost'} {mb(abs(d))} million barrels.</p>")
    return "\n".join(out)


def years_html(s):
    ends = year_ends(s["level"])
    years = sorted(ends, reverse=True)[:16]
    rows = []
    last_year = years[0]
    for y in years:
        k, v = ends[y]
        prev = ends.get(str(int(y) - 1))
        change = "–" if not prev else (("+" if v >= prev[1] else "−") + mb(abs(v - prev[1])))
        label = f"{y} (latest week)" if y == last_year else y
        rows.append(f'<tr><th scope="row">{label}</th><td>{mb(v)}</td><td>{v / 10 / CAPACITY:.0f}%</td><td>{change}</td></tr>')
    return ('<table class="summary-table"><caption>SPR crude oil stocks at the end of each year, million barrels</caption>'
            '<thead><tr><th scope="col">Year</th><th scope="col">Stocks</th><th scope="col">Full</th><th scope="col">Change in the year</th></tr></thead><tbody>\n'
            + "\n".join(rows) + "\n</tbody></table>")


def faq_html(s):
    k, v = s["level"][-1]
    use = avg4(s["consumption"])
    out = [f"<h3>How much oil is in the Strategic Petroleum Reserve?</h3>",
           f"<p>{mb(v)} million barrels in the week ending {long_date(k)}, according to the U.S. Energy Information Administration. "
           f"That is {v / 10 / CAPACITY:.0f}% of the reserve's authorized capacity of 714 million barrels.</p>",
           "<h3>How long would the SPR last?</h3>"]
    if use:
        out.append(f"<p>On its own, about {v / use:.0f} days of total US oil use, at the recent rate of {use / 1000:.1f} million barrels a day. "
                   f"In practice the reserve is meant to fill gaps in supply, not replace it: at its maximum design release rate of 4.4 million "
                   f"barrels a day, the current stock would last about {v / 1000 / 4.4:.0f} days.</p>")
    pace = refill_pace(s["level"])
    if pace:
        gap = CAPACITY - v / 1000
        months = gap / pace["rate"]
        out += ["<h3>How long would it take to refill the SPR?</h3>",
                f"<p>Refilling the remaining {gap:,.0f} million barrels at the {pace['year']} pace of about {pace['rate']:.1f} million barrels a month "
                f"would take around {months / 12:.0f} years. Exchange returns due from the 2026 release will add oil back faster for a while, "
                f"and the barrel above lets you try other paces.</p>"]
    return "\n".join(out)


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
    today = os.environ.get("SPR_TODAY") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sample = os.environ.get("SPR_SAMPLE")
    key = os.environ.get("EIA_API_KEY", "").strip()
    try:
        if sample:
            rows = json.loads(Path(sample).read_text())["rows"]
        elif key:
            rows = fetch(key)
        else:
            print("EIA_API_KEY is not set; skipping the SPR update.")
            set_output(False)
            return 0
        s = to_series(rows)
    except Exception as e:
        print(f"SPR update failed, keeping the previous data: {e}", file=sys.stderr)
        set_output(False)
        return 0
    for name in ("consumption", "netImports"):
        if not s[name]:
            print(f"::warning::No {name} rows from EIA; the matching estimate will show a dash.")
    if len(s["level"]) < 104:
        print("Not enough SPR rows returned; keeping the previous data.", file=sys.stderr)
        set_output(False)
        return 0

    data = {
        "source": "U.S. Energy Information Administration, weekly petroleum supply (WCSSTUS1, WRPUPUS2, WCRNTUS2)",
        "capacity": CAPACITY,
        "level": [[k, v] for k, v in s["level"]],
        "consumption": [[k, v] for k, v in s["consumption"][-8:]],
        "netImports": [[k, v] for k, v in s["netImports"][-8:]],
        "pace": refill_pace(s["level"]),
    }
    try:
        old = json.loads(OUT_JSON.read_text())
    except Exception:
        old = None
    if old == data:
        print(f"No new SPR data (latest week {s['level'][-1][0]}).")
        set_output(False)
        return 0

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, separators=(",", ":")))
    if PAGE.exists():
        page = PAGE.read_text(encoding="utf-8")
        for name, content in (("SPRNOW", now_html(s)), ("SPRWHY", why_html(s)), ("SPRYEARS", years_html(s)), ("SPRFAQ", faq_html(s))):
            page = replace_block(page, name, content)
        page = re.sub(r'"dateModified": "[^"]*"', f'"dateModified": "{today}"', page)
        PAGE.write_text(page, encoding="utf-8")
    if SITEMAP.exists():
        sm = SITEMAP.read_text(encoding="utf-8")
        sm = re.sub(rf"(<loc>{re.escape(PAGE_URL)}</loc><lastmod>)[^<]*(</lastmod>)", rf"\g<1>{today}\g<2>", sm)
        SITEMAP.write_text(sm, encoding="utf-8")
    print(f"Wrote SPR data to week {s['level'][-1][0]}: {s['level'][-1][1]:,} thousand barrels.")
    set_output(True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
