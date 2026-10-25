"""Download official Brent and WTI spot prices from the EIA API and write them
into the home page as plain text, so visitors and search engines can read them.

Runs on GitHub Actions (Thursday and Friday mornings, after EIA's weekly
Wednesday release). Needs the free EIA API key in the repository secret
EIA_API_KEY. Uses only the Python standard library.

What it does
1. Downloads the latest daily and weekly spot prices for Europe Brent (RBRTE)
   and WTI Cushing (RWTC).
2. Saves them to site/data/prices.json.
3. Rewrites the marked sections of site/index.html (the price section and one
   FAQ answer), the page's dateModified, and the sitemap date, but only when
   EIA has published new numbers.

If the download fails, the existing files are kept and the job still deploys.
For a local test without a key, set PRICES_SAMPLE to a JSON file with the
same rows the API returns.
"""

import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "site" / "data" / "prices.json"
PAGE = ROOT / "site" / "index.html"
SITEMAP = ROOT / "site" / "sitemap.xml"
API = "https://api.eia.gov/v2/petroleum/pri/spt/data/"
SERIES = {"RBRTE": "brent", "RWTC": "wti"}
PRODUCTS = {"EPCBRENT": "brent", "EPCWTI": "wti"}  # fallback if the series facet is missing
DAILY_ROWS = 10
WEEKLY_ROWS = 6


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


def fetch(key, frequency, length):
    base = [
        ("api_key", key), ("frequency", frequency), ("data[0]", "value"),
        ("sort[0][column]", "period"), ("sort[0][direction]", "desc"),
        ("offset", "0"), ("length", str(length)),
    ]
    rows = get(API + "?" + urllib.parse.urlencode(base + [("facets[series][]", s) for s in SERIES]))
    rows = rows.get("response", {}).get("data", [])
    if not rows:  # older API layouts: filter by product instead
        rows = get(API + "?" + urllib.parse.urlencode(base + [("facets[product][]", p) for p in PRODUCTS]))
        rows = rows.get("response", {}).get("data", [])
    return rows


def to_table(rows):
    """API rows -> {'YYYY-MM-DD': {'brent': 115.22, 'wti': 107.89}}"""
    out = {}
    for r in rows:
        which = SERIES.get(str(r.get("series", "")).upper()) or PRODUCTS.get(str(r.get("product", "")).upper())
        if not which:
            continue
        try:
            value = round(float(r.get("value")), 2)
        except (TypeError, ValueError):
            continue
        period = str(r.get("period", ""))[:10]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", period):
            continue
        out.setdefault(period, {})[which] = value
    return out


# --------------------------------------------------------------------------
# Numbers and text
# --------------------------------------------------------------------------
def d(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def long_date(s, weekday=True):
    x = d(s)
    text = f"{x.day} {x.strftime('%B')} {x.year}"
    return f"{x.strftime('%A')} {text}" if weekday else text


def short_date(s):
    x = d(s)
    return f"{x.strftime('%a')} {x.day} {x.strftime('%b')}"


def money(v):
    return f"${v:,.2f}"


def latest(daily, which):
    for day in sorted(daily, reverse=True):
        if which in daily[day]:
            return day, daily[day][which]
    return None, None


def week_before(daily, which, day):
    """Value on the last trading day at least 7 calendar days before `day`."""
    cutoff = d(day) - timedelta(days=7)
    for k in sorted(daily, reverse=True):
        if d(k) <= cutoff and which in daily[k]:
            return k, daily[k][which]
    return None, None


def change_text(now, then):
    diff = now - then
    pct = diff / then * 100 if then else 0
    if abs(diff) < 0.005:
        return "flat", "unchanged in a week"
    arrow, cls = ("▲", "up") if diff > 0 else ("▼", "down")
    return cls, f"{arrow} {money(abs(diff))} ({abs(pct):.1f}%) in a week"


def build(daily, weekly):
    b_day, b_now = latest(daily, "brent")
    w_day, w_now = latest(daily, "wti")
    if not (b_day and w_day):
        return None
    last_day = max(b_day, w_day)
    b_prev_day, b_prev = week_before(daily, "brent", b_day)
    w_prev_day, w_prev = week_before(daily, "wti", w_day)

    # Spread: latest day on which both benchmarks have a price
    both = [k for k in sorted(daily, reverse=True) if "brent" in daily[k] and "wti" in daily[k]]
    s_day = both[0] if both else None
    spread = daily[s_day]["brent"] - daily[s_day]["wti"] if s_day else None
    s_prev = None
    if s_day:
        cutoff = d(s_day) - timedelta(days=7)
        prev = [k for k in both if d(k) <= cutoff]
        if prev:
            s_prev = daily[prev[0]]["brent"] - daily[prev[0]]["wti"]

    return {
        "last_day": last_day,
        "brent": {"day": b_day, "value": b_now, "prev": b_prev, "prev_day": b_prev_day},
        "wti": {"day": w_day, "value": w_now, "prev": w_prev, "prev_day": w_prev_day},
        "spread": {"day": s_day, "value": spread, "prev": s_prev},
        "daily": [[k, daily[k].get("brent"), daily[k].get("wti")] for k in sorted(daily, reverse=True)[:DAILY_ROWS]],
        "weekly": [[k, weekly[k].get("brent"), weekly[k].get("wti")] for k in sorted(weekly, reverse=True)[:WEEKLY_ROWS]],
    }


def cell(v):
    return money(v) if v is not None else "–"


def lead_sentence(s):
    b, w = s["brent"], s["wti"]
    if b["day"] == w["day"]:
        first = (f"On {long_date(b['day'])}, Brent crude closed at <strong>{money(b['value'])}</strong> a barrel "
                 f"and WTI at <strong>{money(w['value'])}</strong>")
        if s["spread"]["value"] is not None and s["spread"]["day"] == b["day"]:
            first += f", a gap of {money(s['spread']['value'])}"
        first += "."
    else:
        first = (f"Brent crude last closed at <strong>{money(b['value'])}</strong> a barrel on {long_date(b['day'])}, "
                 f"and WTI at <strong>{money(w['value'])}</strong> on {long_date(w['day'])}.")
    moves = []
    for name, x in (("Brent", b), ("WTI", w)):
        if x["prev"]:
            pct = (x["value"] - x["prev"]) / x["prev"] * 100
            if abs(pct) < 0.05:
                moves.append(f"{name} was unchanged")
            else:
                moves.append(f"{name} {'rose' if pct > 0 else 'fell'} {abs(pct):.1f}%")
    second = f" Over the past week, {' and '.join(moves)}." if moves else ""
    return first + second


def stat(label, x, prev_label=None):
    if x["value"] is None:
        return ""
    if prev_label:
        cls, txt = "flat", prev_label
    elif x["prev"]:
        cls, txt = change_text(x["value"], x["prev"])
    else:
        cls, txt = "flat", ""
    return (f'<div><dt>{label}</dt><dd class="official-price">{money(x["value"])}</dd>'
            f'<dd class="official-chg {cls}">{txt}</dd></div>')


def section_html(s, retrieved):
    sp = s["spread"]
    spread_note = f"{money(sp['prev'])} a week earlier" if sp["prev"] is not None else ""
    out = [
        f'<p class="official-lead">{lead_sentence(s)}</p>',
        '<dl class="official-stats">',
        stat("Brent", s["brent"]),
        stat("WTI", s["wti"]),
        stat("Brent–WTI spread", sp, spread_note or " "),
        "</dl>",
        '<div class="official-tables">',
        '<table class="summary-table"><caption>Daily spot prices, US dollars per barrel</caption>',
        '<thead><tr><th scope="col">Date</th><th scope="col">Brent</th><th scope="col">WTI</th><th scope="col">Spread</th></tr></thead><tbody>',
    ]
    for day, b, w in s["daily"]:
        spread = money(b - w) if b is not None and w is not None else "–"
        out.append(f'<tr><th scope="row"><time datetime="{day}">{short_date(day)}</time></th>'
                   f"<td>{cell(b)}</td><td>{cell(w)}</td><td>{spread}</td></tr>")
    out.append("</tbody></table>")
    if s["weekly"]:
        out += [
            '<table class="summary-table"><caption>Weekly averages, US dollars per barrel</caption>',
            '<thead><tr><th scope="col">Week ending</th><th scope="col">Brent</th><th scope="col">WTI</th></tr></thead><tbody>',
        ]
        for day, b, w in s["weekly"]:
            out.append(f'<tr><th scope="row"><time datetime="{day}">{short_date(day)}</time></th>'
                       f"<td>{cell(b)}</td><td>{cell(w)}</td></tr>")
        out.append("</tbody></table>")
    out += [
        "</div>",
        f'<p class="official-note">Source: U.S. Energy Information Administration, spot prices to {long_date(s["last_day"], weekday=False)}; '
        "original data: Refinitiv, an LSEG business. "
        "EIA publishes these official spot prices once a week, on Wednesdays, so they run a few days behind the live prices "
        "at the top of the page. This section updates automatically the next morning.</p>",
    ]
    return "\n".join(x for x in out if x)


def faq_html(s):
    b, w = s["brent"], s["wti"]
    when = (f"on {long_date(b['day'], weekday=False)}" if b["day"] == w["day"]
            else f"on {long_date(b['day'], weekday=False)} and {long_date(w['day'], weekday=False)}")
    return (f"<p>The live Brent and WTI prices are shown at the top of this page, with the change since the previous close. "
            f"The latest official spot prices from the US Energy Information Administration were "
            f"<strong>{money(b['value'])}</strong> a barrel for Brent and <strong>{money(w['value'])}</strong> for WTI, {when}.</p>")


# --------------------------------------------------------------------------
# Write files
# --------------------------------------------------------------------------
def replace_block(page, name, content):
    start, end = f"<!-- {name}:START -->", f"<!-- {name}:END -->"
    if start not in page or end not in page:
        print(f"Markers {name} not found in index.html; skipped.", file=sys.stderr)
        return page
    a = page.index(start) + len(start)
    b = page.index(end)
    return page[:a] + "\n" + content + "\n" + page[b:]


def write_page(s, today):
    page = PAGE.read_text(encoding="utf-8")
    page = replace_block(page, "PRICES", section_html(s, today))
    page = replace_block(page, "FAQPRICE", faq_html(s))
    page = re.sub(r'"dateModified": "[^"]*"', f'"dateModified": "{today}"', page)
    page = re.sub(r'(<time class="official-updated" datetime=")[^"]*(">)[^<]*(</time>)',
                  rf"\g<1>{today}\g<2>{long_date(today, weekday=False)}\g<3>", page)
    PAGE.write_text(page, encoding="utf-8")
    if SITEMAP.exists():
        sm = SITEMAP.read_text(encoding="utf-8")
        sm = re.sub(r"(<loc>https://oilprices\.io/</loc><lastmod>)[^<]*(</lastmod>)", rf"\g<1>{today}\g<2>", sm)
        SITEMAP.write_text(sm, encoding="utf-8")


def set_output(changed):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
    print(f"changed={changed}")


def main():
    today = os.environ.get("PRICES_TODAY") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sample = os.environ.get("PRICES_SAMPLE")
    key = os.environ.get("EIA_API_KEY", "").strip()
    try:
        if sample:
            raw = json.loads(Path(sample).read_text())
            daily_rows, weekly_rows = raw["daily"], raw["weekly"]
        elif key:
            daily_rows = fetch(key, "daily", 120)
            weekly_rows = fetch(key, "weekly", 30)
        else:
            print("EIA_API_KEY is not set; skipping the price update.")
            set_output(False)
            return 0
        daily, weekly = to_table(daily_rows), to_table(weekly_rows)
        s = build(daily, weekly)
    except Exception as e:
        print(f"Price update failed, keeping the previous data: {e}", file=sys.stderr)
        set_output(False)
        return 0
    if not s:
        print("No Brent/WTI rows returned; keeping the previous data.", file=sys.stderr)
        set_output(False)
        return 0

    data = {
        "updated": today,
        "source": "U.S. Energy Information Administration, spot prices (original data: Refinitiv, an LSEG business)",
        "units": "US dollars per barrel",
        "daily": [[k, daily[k].get("brent"), daily[k].get("wti")] for k in sorted(daily)],
        "weekly": [[k, weekly[k].get("brent"), weekly[k].get("wti")] for k in sorted(weekly)],
    }
    old = None
    if OUT_JSON.exists():
        try:
            old = json.loads(OUT_JSON.read_text())
        except Exception:
            old = None
    if old and {k: v for k, v in old.items() if k != "updated"} == {k: v for k, v in data.items() if k != "updated"}:
        print(f"No new EIA prices (latest {s['last_day']}).")
        set_output(False)
        return 0

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, separators=(",", ":")))
    write_page(s, today)
    print(f"Wrote prices to {s['last_day']}: Brent {s['brent']['value']}, WTI {s['wti']['value']}.")
    set_output(True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
