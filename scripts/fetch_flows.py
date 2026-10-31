"""Download the annual US petroleum balance from the EIA API, for the
"Where US oil goes" flow chart.

Data (EIA API v2, annual, United States, thousand barrels a day):
  petroleum/sum/snd   supply and disposition of crude oil and petroleum products
    products: EP00 all crude oil and petroleum products, EPC0 crude oil,
              EPL0 natural gas liquids and liquid refinery gases, EPM0F finished
              motor gasoline, EPD0 distillate fuel oil, EPJK kerosene-type jet fuel
    processes: FPF field production, IM0 imports, EEX exports, VPP product
              supplied, YPR refinery and blender net production, YIR refinery and
              blender net input, YNP renewable fuels and oxygenate plant net production
  total-energy        Monthly Energy Review, primary energy consumption
    TETCBUS total, PMTCBUS petroleum, NNTCBUS natural gas (trillion Btu)

Runs on GitHub Actions with the free EIA API key in the repository secret
EIA_API_KEY. Uses only the standard library. Writes site/data/flows.json and the
marked sections of site/tools/where-us-oil-goes.html, only when EIA has new data.

For a local test without a key, set FLOWS_SAMPLE to a JSON file {"rows": [...], "mer": [...]}.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "site" / "data" / "flows.json"
PAGE = ROOT / "site" / "tools" / "where-us-oil-goes.html"
SITEMAP = ROOT / "site" / "sitemap.xml"
PAGE_URL = "https://oilprices.io/tools/where-us-oil-goes.html"
API_SND = "https://api.eia.gov/v2/petroleum/sum/snd/data/"
API_MER = "https://api.eia.gov/v2/total-energy/data/"
PRODUCTS = ["EP00", "EPC0", "EPL0", "EPM0F", "EPD0", "EPJK", "EPOOR"]
PROCESSES = ["FPF", "IM0", "EEX", "VPP", "YPR", "YIR", "YNP"]
MSN = ["TETCBUS", "PMTCBUS", "NNTCBUS"]
YEARS_BACK = 12


def get(url, attempts=4):
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            last = f"HTTP {e.code}: {body}"
            if 400 <= e.code < 500 and e.code != 429:
                break
            time.sleep(5 * (i + 1))
        except Exception as e:
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"EIA request failed: {last}")


def fetch_all(api, params):
    rows, offset = [], 0
    while True:
        p = params + [("offset", str(offset)), ("length", "5000")]
        resp = get(api + "?" + urllib.parse.urlencode(p)).get("response", {})
        batch = resp.get("data", [])
        rows.extend(batch)
        offset += len(batch)
        if not batch or offset >= int(resp.get("total") or 0):
            return rows


def fetch(key, start):
    base = [("api_key", key), ("frequency", "annual"), ("data[0]", "value"), ("start", str(start)),
            ("sort[0][column]", "period"), ("sort[0][direction]", "desc")]
    snd = []
    for prod in PRODUCTS:
        try:
            # US totals are area "NUS"; US imports and exports are filed under "NUS-Z00" (US to/from the world),
            # so no area filter here; the rows are filtered in table()
            rows = fetch_all(API_SND, base + [("facets[product][]", prod)] + [("facets[process][]", p) for p in PROCESSES])
        except Exception as e:
            print(f"::warning::EIA data for {prod} not loaded: {e}")
            continue
        rows = [r for r in rows if r.get("process") in PROCESSES]
        trade = sorted({str(r.get("duoarea")) for r in rows if r.get("process") in ("IM0", "EEX")})
        print(f"{prod}: {len(rows)} rows; import/export areas: {', '.join(trade[:6]) or 'none'}")
        snd.extend(rows)
    try:
        mer = fetch_all(API_MER, base + [("facets[msn][]", m) for m in MSN])
    except Exception as e:
        print(f"::warning::Energy mix not updated: {e}")
        mer = []
    return snd, mer


def table(rows):
    """{(product, process, year): thousand barrels a day}, keeping only the per-day rows."""
    out = {}
    for r in rows:
        if str(r.get("units", "")).upper().replace(" ", "") not in ("MBBL/D", "MBBLD"):
            continue
        area = str(r.get("duoarea", "NUS")).upper()
        if area != "NUS" and not area.startswith("NUS-Z"):
            continue
        try:
            v = float(r.get("value"))
        except (TypeError, ValueError):
            continue
        y = str(r.get("period", ""))[:4]
        if re.fullmatch(r"\d{4}", y):
            out[(r.get("product"), r.get("process"), y)] = v
    return out


def mix_table(rows):
    out = {}
    for r in rows:
        try:
            v = float(r.get("value"))
        except (TypeError, ValueError):
            continue
        y = str(r.get("period", ""))[:4]
        out.setdefault(y, {})[r.get("msn")] = v
    res = {}
    for y, m in out.items():
        tot = m.get("TETCBUS")
        if tot and m.get("PMTCBUS") and m.get("NNTCBUS"):
            pet, gas = m["PMTCBUS"] / tot * 100, m["NNTCBUS"] / tot * 100
            res[y] = {"petroleum": round(pet, 1), "gas": round(gas, 1), "other": round(100 - pet - gas, 1)}
    return res


REQUIRED = [("EP00", "FPF"), ("EPC0", "FPF"), ("EPL0", "FPF"), ("EPC0", "IM0"), ("EP00", "IM0"),
            ("EPC0", "EEX"), ("EPL0", "EEX"), ("EP00", "EEX"), ("EP00", "VPP"),
            ("EPM0F", "VPP"), ("EPD0", "VPP"), ("EPJK", "VPP"), ("EPL0", "VPP")]


def build_year(t, y):
    missing = [f"{p}/{q}" for p, q in REQUIRED if (p, q, y) not in t]
    if missing:
        print(f"{y}: skipped, missing {', '.join(missing)}")
        return None
    g = lambda p, q: t.get((p, q, y), 0) / 1000
    bio = g("EP00", "YNP") or g("EPOOR", "YNP")
    gain = g("EP00", "YPR") - g("EP00", "YIR") if (("EP00", "YPR", y) in t and ("EP00", "YIR", y) in t) else 0
    r = lambda v: round(max(0.0, v), 3)
    use = {"gas": g("EPM0F", "VPP"), "dsl": g("EPD0", "VPP"), "jet": g("EPJK", "VPP"), "hgl": g("EPL0", "VPP")}
    use["other"] = g("EP00", "VPP") - sum(use.values())
    return {
        "in": {"crude": r(g("EPC0", "FPF")), "ngl": r(g("EPL0", "FPF")), "impcrude": r(g("EPC0", "IM0")),
               "impfuel": r(g("EP00", "IM0") - g("EPC0", "IM0")), "bio": r(bio),
               "gain": r(gain)},
        "out": {"xcrude": r(g("EPC0", "EEX")), "xhgl": r(g("EPL0", "EEX")),
                "xfuel": r(g("EP00", "EEX") - g("EPC0", "EEX") - g("EPL0", "EEX"))},
        "use": {k: r(v) for k, v in use.items()},
        "totals": {"produced": r(g("EP00", "FPF")), "imported": r(g("EP00", "IM0")),
                   "used": r(g("EP00", "VPP")), "exported": r(g("EP00", "EEX"))},
    }


def f1(v):
    return f"{v:,.1f}"


def pct(a, b):
    return (a - b) / b * 100 if b else 0


def now_html(y, d, prev=None):
    t, u = d["totals"], d["use"]
    net = t["exported"] - t["imported"]
    crude_ref = d["in"]["crude"] - d["out"]["xcrude"]
    p1 = (f"<p>In {y}, the United States produced <strong>{f1(t['produced'])} million barrels per day</strong> (bpd) of crude oil and natural gas liquids, "
          f"of which {f1(d['in']['crude'])} million was crude oil. It imported {f1(t['imported'])} million bpd, used <strong>{f1(t['used'])} million bpd</strong> "
          f"at home and exported {f1(t['exported'])} million, "
          + (f"{f1(net)} million bpd more than it imported." if net > 0 else f"{f1(-net)} million bpd less than it imported."))
    if prev:
        pt = prev[1]["totals"]
        p1 += (f" Production was {'up' if t['produced'] >= pt['produced'] else 'down'} {abs(pct(t['produced'], pt['produced'])):.1f}% on {prev[0]} "
               f"and US oil use {'up' if t['used'] >= pt['used'] else 'down'} {abs(pct(t['used'], pt['used'])):.1f}%.")
    out = [p1 + "</p>",
           f"<p>Gasoline was the largest single use, at {f1(u['gas'])} million barrels per day, {u['gas'] / t['used'] * 100:.0f}% of all the oil the "
           f"country used. Diesel and heating oil came next at {f1(u['dsl'])} million, then propane, ethane and butane at {f1(u['hgl'])} million. "
           f"Of the {f1(d['in']['crude'])} million barrels per day of crude pumped from US wells, {f1(d['out']['xcrude'])} million was exported "
           f"and the rest, about {f1(crude_ref)} million, went to refineries.</p>"]
    return "\n".join(out)


def table_html(years):
    rows = []
    for y in sorted(years, reverse=True):
        t = years[y]["totals"]
        net = t["exported"] - t["imported"]
        rows.append(f'<tr><th scope="row">{y}</th><td>{f1(t["produced"])}</td><td>{f1(t["imported"])}</td>'
                    f'<td>{f1(t["used"])}</td><td>{f1(t["exported"])}</td><td>{"+" if net >= 0 else "−"}{f1(abs(net))}</td></tr>')
    return ('<table class="summary-table"><caption>US crude oil and petroleum products, million barrels a day</caption>'
            '<thead><tr><th scope="col">Year</th><th scope="col">Produced</th><th scope="col">Imported</th>'
            '<th scope="col">Used</th><th scope="col">Exported</th><th scope="col">Net exports</th></tr></thead><tbody>\n'
            + "\n".join(rows) + "\n</tbody></table>")


def faq_html(y, d):
    t, u, i, o = d["totals"], d["use"], d["in"], d["out"]
    net = t["exported"] - t["imported"]
    return "\n".join([
        "<h3>How much oil does the US produce per day?</h3>",
        f"<p>{f1(t['produced'])} million barrels per day in {y}: {f1(i['crude'])} million barrels of crude oil and {f1(i['ngl'])} million barrels "
        f"of natural gas liquids, according to the U.S. Energy Information Administration.</p>",
        "<h3>How much oil does the US use per day?</h3>",
        f"<p>{f1(t['used'])} million barrels per day in {y}, or about {t['used'] * 42:,.0f} million gallons a day. That counts all petroleum "
        f"products, from gasoline and diesel to propane and asphalt.</p>",
        "<h3>How much oil does the US import?</h3>",
        f"<p>{f1(t['imported'])} million barrels per day in {y}: {f1(i['impcrude'])} million barrels of crude oil and {f1(i['impfuel'])} million "
        f"barrels of fuels and other products.</p>",
        "<h3>How much oil does the US export?</h3>",
        f"<p>{f1(t['exported'])} million barrels per day in {y}: {f1(o['xcrude'])} million barrels of crude oil, {f1(o['xhgl'])} million of gas "
        f"liquids such as propane, and {f1(o['xfuel'])} million of fuels such as diesel and gasoline.</p>",
        "<h3>Does the US export more oil than it imports?</h3>",
        (f"<p>Yes. In {y} the US exported {f1(t['exported'])} million barrels per day of crude oil and petroleum products and imported "
         f"{f1(t['imported'])} million, making it a net exporter of {f1(net)} million barrels per day. It still imports crude oil, "
         f"because many refineries are built for heavier grades than most US wells produce.</p>" if net > 0 else
         f"<p>No. In {y} the US imported {f1(t['imported'])} million barrels per day and exported {f1(t['exported'])} million.</p>"),
        "<h3>What is most US oil used for?</h3>",
        f"<p>Driving. Gasoline for cars, SUVs and pickups took {f1(u['gas'])} million barrels per day in {y}, "
        f"{u['gas'] / t['used'] * 100:.0f}% of all US oil use. Diesel for trucks, trains, ships and farms took {f1(u['dsl'])} million, "
        f"and jet fuel {f1(u['jet'])} million.</p>",
    ])


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
    now = datetime.now(timezone.utc)
    today = os.environ.get("FLOWS_TODAY") or now.strftime("%Y-%m-%d")
    sample = os.environ.get("FLOWS_SAMPLE")
    key = os.environ.get("EIA_API_KEY", "").strip()
    try:
        if sample:
            raw = json.loads(Path(sample).read_text())
            snd, mer = raw["rows"], raw.get("mer", [])
        elif key:
            snd, mer = fetch(key, now.year - YEARS_BACK)
        else:
            print("EIA_API_KEY is not set; skipping the flows update.")
            set_output(False)
            return 0
        t = table(snd)
        print(f"{len(snd)} rows from EIA, {len(t)} usable values")
    except Exception as e:
        print(f"Flows update failed, keeping the previous data: {e}", file=sys.stderr)
        set_output(False)
        return 0

    try:
        old = json.loads(OUT_JSON.read_text())
    except Exception:
        old = None
    mixes = mix_table(mer)
    years = {}
    for y in sorted({k[2] for k in t}):
        d = build_year(t, y)
        if not d:
            continue
        mix = mixes.get(y) or ((old or {}).get("years", {}).get(y) or {}).get("mix")
        if mix:
            d["mix"] = mix
        years[y] = d
    if not years:
        print("No complete year in the EIA response; keeping the previous data.", file=sys.stderr)
        set_output(False)
        return 0

    latest = max(years)
    data = {
        "source": "U.S. Energy Information Administration: petroleum supply and disposition (annual) and Monthly Energy Review",
        "units": "million barrels a day",
        "latest": latest,
        "years": years,
    }
    if old == data:
        print(f"No new flows data (latest year {latest}).")
        set_output(False)
        return 0

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, separators=(",", ":")))
    if PAGE.exists():
        page = PAGE.read_text(encoding="utf-8")
        d = years[latest]
        ys = sorted(years)
        prev = (ys[-2], years[ys[-2]]) if len(ys) > 1 else None
        for name, content in (("FLOWNOW", now_html(latest, d, prev)), ("FLOWTABLE", table_html(years)), ("FLOWFAQ", faq_html(latest, d))):
            page = replace_block(page, name, content)
        page = re.sub(r"(<title>[^<]*\()\d{4}(\))", rf"\g<1>{latest}\g<2>", page)
        page = re.sub(r'(<meta name="description" content="[^"]*? in )\d{4}(,)', rf"\g<1>{latest}\g<2>", page)
        page = re.sub(r'(<meta property="og:title" content="[^"]*? in )\d{4}(")', rf"\g<1>{latest}\g<2>", page)
        page = re.sub(r"<!-- FLOWYEAR -->\d{4}<!-- /FLOWYEAR -->", f"<!-- FLOWYEAR -->{latest}<!-- /FLOWYEAR -->", page)
        page = re.sub(r'"dateModified": "[^"]*"', f'"dateModified": "{today}"', page)
        PAGE.write_text(page, encoding="utf-8")
    if SITEMAP.exists():
        sm = SITEMAP.read_text(encoding="utf-8")
        sm = re.sub(rf"(<loc>{re.escape(PAGE_URL)}</loc><lastmod>)[^<]*(</lastmod>)", rf"\g<1>{today}\g<2>", sm)
        SITEMAP.write_text(sm, encoding="utf-8")
    print(f"Wrote flows data for {len(years)} years, latest {latest}.")
    set_output(True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
