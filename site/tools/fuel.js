// Fuel cost calculator. Plain JavaScript, no libraries.
// US prices: /data/fuel.json, written weekly from EIA data by scripts/fetch_fuel.py.
(function () {
  "use strict";

  var L_PER_GAL = 3.785411784, L_PER_UKGAL = 4.54609, KM_PER_MI = 1.609344;
  var CO2_KG_PER_L = { gasoline: 8.887 / L_PER_GAL, diesel: 10.180 / L_PER_GAL }; // EPA: grams CO2 per gallon
  var DEFAULTS = { mi: 300, km: 500, mpg: 30, l100: 7, kml: 14, mpguk: 40 };
  var CURRENCIES = ["USD", "EUR", "GBP", "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "HKD", "HUF", "IDR", "ILS", "INR",
    "JPY", "KRW", "MXN", "MYR", "NGN", "NOK", "NZD", "PHP", "PLN", "RON", "SAR", "SEK", "SGD", "THB", "TRY", "AED", "ZAR"];
  var EURO = "AT BE HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES".split(" ");
  var REGION_CUR = { US: "USD", GB: "GBP", CA: "CAD", AU: "AUD", NZ: "NZD", CH: "CHF", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON",
    SE: "SEK", NO: "NOK", DK: "DKK", JP: "JPY", CN: "CNY", IN: "INR", BR: "BRL", MX: "MXN", ZA: "ZAR", TR: "TRY", AE: "AED",
    SA: "SAR", SG: "SGD", HK: "HKD", KR: "KRW", IL: "ILS", NG: "NGN", PH: "PHP", ID: "IDR", TH: "THB", MY: "MYR" };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var $ = function (id) { return document.getElementById(id); };
  var form = $("fc");
  if (!form) return;
  var el = {
    d: $("fc-distance"), du: $("fc-du"), rt: $("fc-round"), e: $("fc-eff"), eu: $("fc-eu"), c: $("fc-cur"), p: $("fc-price"),
    pu: $("fc-pu"), n: $("fc-people"), h: $("fc-hist"), total: $("fc-total"), person: $("fc-person"), fuelOut: $("fc-fuel"),
    per: $("fc-per"), perLabel: $("fc-per-label"), per100: $("fc-per100"), per100Label: $("fc-per100-label"), co2: $("fc-co2"),
    hint: $("fc-hint"), ref: $("fc-ref"), useUs: $("fc-use-us"), copy: $("fc-copy"), hist: $("fc-history"),
    histSummary: $("fc-hist-summary"), histNote: $("fc-hist-note")
  };
  var state = { fuel: "gasoline", touched: false, data: null, range: "10y" };

  // ---------- formatting ----------
  function money(v, cur) {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(v); }
    catch (e) { return cur + " " + v.toFixed(2); }
  }
  function num(v, digits) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v); }
  function symbol(cur) {
    try {
      var p = new Intl.NumberFormat("en", { style: "currency", currency: cur, currencyDisplay: "narrowSymbol" }).formatToParts(0);
      for (var i = 0; i < p.length; i++) if (p[i].type === "currency") return p[i].value;
    } catch (e) {}
    return cur;
  }
  function weekLabel(t) { var d = new Date(t); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); }
  function monthLabel(t) { var d = new Date(t); return MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); }

  // ---------- defaults from the visitor's locale ----------
  var region = ((navigator.language || "en-US").split("-")[1] || "").toUpperCase();
  var defCur = REGION_CUR[region] || (EURO.indexOf(region) >= 0 ? "EUR" : "USD");
  var system = (region === "US" || region === "LR" || region === "MM" || !region) ? "us" : region === "GB" ? "uk" : "metric";

  CURRENCIES.forEach(function (c) {
    var o = document.createElement("option");
    var name = "";
    try { name = new Intl.DisplayNames(["en"], { type: "currency" }).of(c); } catch (e) {}
    var sym = symbol(c);
    o.value = c;
    o.textContent = c + (sym !== c ? " " + sym : "");
    if (name) o.title = name;
    el.c.appendChild(o);
  });

  function applySystem(sys) {
    el.du.value = sys === "metric" ? "km" : "mi";
    el.eu.value = sys === "us" ? "mpg" : sys === "uk" ? "mpguk" : "l100";
    el.pu.value = sys === "us" ? "gal" : "l";
    el.d.value = DEFAULTS[el.du.value];
    el.e.value = DEFAULTS[el.eu.value];
  }
  applySystem(system);
  el.c.value = defCur;

  // ---------- conversions ----------
  function litresPerKm(v, unit) {
    if (!(v > 0)) return NaN;
    if (unit === "mpg") return L_PER_GAL / (v * KM_PER_MI);
    if (unit === "mpguk") return L_PER_UKGAL / (v * KM_PER_MI);
    if (unit === "l100") return v / 100;
    return 1 / v; // km/L
  }
  function fromLitresPerKm(lpk, unit) {
    if (unit === "mpg") return L_PER_GAL / (lpk * KM_PER_MI);
    if (unit === "mpguk") return L_PER_UKGAL / (lpk * KM_PER_MI);
    if (unit === "l100") return lpk * 100;
    return 1 / lpk;
  }
  function round(v, d) { var f = Math.pow(10, d); return Math.round(v * f) / f; }

  function usLatest() {
    if (!state.data) return null;
    var s = state.data[state.fuel];
    return s && s.length ? { date: s[s.length - 1][0], perGal: s[s.length - 1][1] } : null;
  }
  function usPriceInUnit() {
    var us = usLatest();
    if (!us) return null;
    return el.pu.value === "gal" ? us.perGal : us.perGal / L_PER_GAL;
  }
  function fillUsPrice() {
    if (state.touched || el.c.value !== "USD") return;
    var v = usPriceInUnit();
    if (v) el.p.value = round(v, el.pu.value === "gal" ? 2 : 3);
  }

  // ---------- calculation ----------
  function calc() {
    var dist = parseFloat(el.d.value), eff = parseFloat(el.e.value), price = parseFloat(el.p.value);
    var people = Math.max(1, Math.round(parseFloat(el.n.value) || 1));
    var km = dist * (el.du.value === "mi" ? KM_PER_MI : 1) * (el.rt.checked ? 2 : 1);
    var lpk = litresPerKm(eff, el.eu.value);
    var litres = km * lpk;
    var perLitre = el.pu.value === "gal" ? price / L_PER_GAL : price;
    var ok = km > 0 && litres > 0 && isFinite(litres);
    return {
      ok: ok, priced: ok && perLitre > 0, km: km, litres: litres, people: people,
      cost: litres * perLitre, perLitre: perLitre, unitDist: el.du.value,
      dist: dist * (el.rt.checked ? 2 : 1)
    };
  }

  function render() {
    var r = calc(), cur = el.c.value, mi = r.unitDist === "mi";
    el.perLabel.textContent = mi ? "Cost per mile" : "Cost per km";
    el.per100Label.textContent = mi ? "Cost per 100 miles" : "Cost per 100 km";
    el.fuelOut.textContent = !r.ok ? "–" : el.pu.value === "gal"
      ? num(r.litres / L_PER_GAL, 1) + " gallons" : num(r.litres, 1) + " litres";
    el.co2.textContent = r.ok ? num(r.litres * CO2_KG_PER_L[state.fuel], 0) + " kg" : "–";
    if (r.priced) {
      el.total.textContent = money(r.cost, cur);
      var perDist = r.cost / r.dist;
      el.per.textContent = money(perDist, cur);
      el.per100.textContent = money(perDist * 100, cur);
      el.person.hidden = r.people < 2;
      el.person.textContent = money(r.cost / r.people, cur) + " each, split between " + r.people + " people";
      el.hint.hidden = true;
    } else {
      el.total.textContent = "–"; el.per.textContent = "–"; el.per100.textContent = "–";
      el.person.hidden = true;
      el.hint.hidden = !r.ok;
    }
    renderRef();
    renderHistory(r);
    saveUrl();
  }

  function renderRef() {
    var us = usLatest(), t = el.ref.querySelector("[data-ref-text]");
    if (!us) { t.textContent = state.data === false ? "unavailable right now" : "loading…"; el.useUs.hidden = true; return; }
    var name = state.fuel === "diesel" ? "diesel" : "regular gasoline";
    t.textContent = money(us.perGal, "USD") + " a gallon (" + money(us.perGal / L_PER_GAL, "USD") + " a litre) for " + name +
      ", week of " + weekLabel(Date.parse(us.date)) + ".";
    var v = usPriceInUnit();
    el.useUs.hidden = el.c.value === "USD" && Math.abs(parseFloat(el.p.value) - v) < 0.0051;
  }

  // ---------- history chart ----------
  var NS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function niceStep(span, count) {
    var raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  function renderHistory(r) {
    el.hist.hidden = !el.h.checked;
    if (!el.h.checked) return;
    var box = el.hist.querySelector(".chart-box"), tip = box.querySelector(".chart-tip");
    var us = usLatest();
    el.hist.querySelector("[data-hist-fuel]").textContent = state.fuel === "diesel" ? "diesel" : "gasoline";
    el.hist.querySelector("[data-hist-cost]").textContent = r.priced ? money(r.cost, el.c.value) : "this money";
    el.hist.querySelectorAll("[data-range]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-range") === state.range ? "true" : "false");
    });
    var old = box.querySelector("svg"); if (old) old.remove();
    if (!us || !r.ok) {
      el.histSummary.textContent = us ? "Enter your trip details to see the chart." : "The price history couldn't load.";
      return;
    }
    var unit = r.unitDist === "mi" ? "mi" : "km";
    var years = { "1y": 1, "5y": 5, "10y": 10 }[state.range];
    var series = state.data[state.fuel];
    var lastT = Date.parse(series[series.length - 1][0]), from = lastT - years * 365.25 * 864e5;
    var pts = series.filter(function (p) { return Date.parse(p[0]) >= from; }).map(function (p) {
      return { t: Date.parse(p[0]), price: p[1], dist: r.dist * us.perGal / p[1] };
    });
    if (pts.length < 2) return;

    var W = box.clientWidth || 600, H = box.clientHeight || 300, m = { t: 12, r: 64, b: 26, l: 4 };
    var ds = pts.map(function (p) { return p.dist; });
    var lo = Math.min.apply(null, ds), hi = Math.max.apply(null, ds), pad = (hi - lo) * 0.1 || hi * 0.1;
    var step = niceStep(hi - lo + 2 * pad, 4);
    var y0 = Math.max(0, Math.floor((lo - pad) / step) * step), y1 = Math.ceil((hi + pad) / step) * step;
    var x0 = pts[0].t, x1 = pts[pts.length - 1].t;
    function X(t) { return m.l + (t - x0) / (x1 - x0) * (W - m.l - m.r); }
    function Y(v) { return m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b); }

    var svg = svgEl("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Distance the same money buys, " + monthLabel(x0) + " to " + monthLabel(x1) });
    for (var v = y0; v <= y1 + 1e-9; v += step) {
      svgEl("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), "class": "chart-grid" }, svg);
      svgEl("text", { x: W - m.r + 8, y: Y(v) + 4, "class": "chart-axis" }, svg).textContent = num(v, 0) + " " + unit;
    }
    var spanY = (x1 - x0) / (365.25 * 864e5), d0 = new Date(x0);
    if (spanY > 2) {
      for (var y = d0.getUTCFullYear() + 1; Date.UTC(y, 0, 1) <= x1; y++) {
        if (spanY > 6 && y % 2) continue;
        var tx = X(Date.UTC(y, 0, 1));
        if (tx > 18 && tx < W - m.r - 18) svgEl("text", { x: tx, y: H - 6, "class": "chart-axis", "text-anchor": "middle" }, svg).textContent = y;
      }
    } else {
      for (var mo = 1; mo <= 13; mo += 2) {
        var t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + mo, 1);
        if (t > x1) break;
        var txm = X(t), dm = new Date(t);
        if (txm > 18 && txm < W - m.r - 18) svgEl("text", { x: txm, y: H - 6, "class": "chart-axis", "text-anchor": "middle" }, svg).textContent =
          MONTHS[dm.getUTCMonth()] + (dm.getUTCMonth() === 0 ? " " + dm.getUTCFullYear() : "");
      }
    }
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.dist).toFixed(1); }).join("");
    svgEl("path", { d: line + "L" + X(x1) + " " + Y(y0) + "L" + X(x0) + " " + Y(y0) + "Z", "class": "chart-area" }, svg);
    svgEl("line", { x1: m.l, x2: W - m.r, y1: Y(r.dist), y2: Y(r.dist), "class": "fc-today-line" }, svg);
    svgEl("text", { x: m.l + 4, y: Y(r.dist) - 6, "class": "chart-axis fc-today-label" }, svg).textContent = "Today: " + num(r.dist, 0) + " " + unit;
    svgEl("path", { d: line, "class": "chart-line" }, svg);

    var guide = svgEl("line", { y1: m.t, y2: H - m.b, "class": "chart-guide", visibility: "hidden" }, svg);
    var dot = svgEl("circle", { r: 4, "class": "chart-dot", visibility: "hidden" }, svg);
    var hit = svgEl("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
    function show(evt) {
      var rect = svg.getBoundingClientRect(), t = x0 + (evt.clientX - rect.left - m.l) / (W - m.l - m.r) * (x1 - x0);
      var best = pts[0];
      for (var i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(best.t - t)) best = pts[i];
      var cx = X(best.t), cy = Y(best.dist);
      guide.setAttribute("x1", cx); guide.setAttribute("x2", cx); guide.setAttribute("visibility", "visible");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible");
      tip.innerHTML = "<strong>" + num(best.dist, 0) + " " + unit + "</strong><span>Week of " + weekLabel(best.t) +
        " · US " + (state.fuel === "diesel" ? "diesel" : "gas") + " " + money(best.price, "USD") + "/gal</span>";
      tip.hidden = false;
      tip.style.left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), W - tip.offsetWidth) + "px";
      tip.style.top = Math.max(cy - 62, 0) + "px";
    }
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", function () { guide.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; });
    box.insertBefore(svg, tip);

    var cheap = pts.reduce(function (a, b) { return b.price < a.price ? b : a; });
    var dear = pts.reduce(function (a, b) { return b.price > a.price ? b : a; });
    var usPrice = usPriceInUnit();
    var usUsed = el.c.value === "USD" && Math.abs(parseFloat(el.p.value) - usPrice) < 0.0051;
    var cost = r.priced ? "Your " + money(r.cost, el.c.value) : "The same money";
    var txt = cost + " covers " + num(r.dist, 0) + " " + unit + (usUsed ? " at today's US average of " + money(us.perGal, "USD") + " a gallon. " : " today. ");
    if (!usUsed) txt += "If prices had moved like the US average (now " + money(us.perGal, "USD") + " a gallon): ";
    var parts = [];
    if (cheap.price < us.perGal * 0.995) {
      parts.push("in the week of " + weekLabel(cheap.t) + ", when the US average was " + money(cheap.price, "USD") + ", the same money would have taken you " +
        num(cheap.dist, 0) + " " + unit + ", " + num((cheap.dist / r.dist - 1) * 100, 0) + "% further");
    }
    if (dear.price > us.perGal * 1.005) {
      parts.push("at the peak of " + money(dear.price, "USD") + " (week of " + weekLabel(dear.t) + "), only " + num(dear.dist, 0) + " " + unit);
    }
    if (parts.length) { var joined = parts.join(". At the other extreme, "); txt += (usUsed ? joined.charAt(0).toUpperCase() + joined.slice(1) : joined) + "."; }
    el.histSummary.textContent = txt;
    el.histNote.hidden = usUsed;
  }

  // ---------- shareable link ----------
  var urlTimer;
  function saveUrl() {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(function () {
      var q = new URLSearchParams();
      q.set("d", el.d.value); q.set("du", el.du.value); if (el.rt.checked) q.set("rt", "1");
      q.set("e", el.e.value); q.set("eu", el.eu.value); q.set("f", state.fuel); q.set("c", el.c.value);
      if (state.touched && el.p.value) q.set("p", el.p.value);
      q.set("pu", el.pu.value); if (+el.n.value > 1) q.set("n", el.n.value); if (el.h.checked) q.set("h", "1");
      try { history.replaceState(null, "", location.pathname + "?" + q.toString()); } catch (e) {}
    }, 300);
  }
  function loadUrl() {
    var q = new URLSearchParams(location.search);
    if (!q.has("d")) return;
    function set(input, key, allowed) {
      var v = q.get(key);
      if (v !== null && (!allowed || allowed.indexOf(v) >= 0)) input.value = v;
    }
    set(el.d, "d"); set(el.du, "du", ["mi", "km"]); set(el.e, "e"); set(el.eu, "eu", ["mpg", "l100", "kml", "mpguk"]);
    set(el.c, "c", CURRENCIES); set(el.pu, "pu", ["gal", "l"]); set(el.n, "n");
    el.rt.checked = q.get("rt") === "1"; el.h.checked = q.get("h") === "1";
    if (q.get("f") === "diesel") setFuel("diesel", true);
    if (q.has("p")) { el.p.value = q.get("p"); state.touched = true; }
  }

  // ---------- events ----------
  function setFuel(f, silent) {
    state.fuel = f;
    form.querySelectorAll("[data-fuel]").forEach(function (b) { b.setAttribute("aria-checked", b.getAttribute("data-fuel") === f ? "true" : "false"); });
    if (!silent) { fillUsPrice(); render(); }
  }
  form.querySelectorAll("[data-fuel]").forEach(function (b) {
    b.addEventListener("click", function () { setFuel(b.getAttribute("data-fuel")); });
  });
  el.du.addEventListener("change", function () {
    var v = parseFloat(el.d.value);
    if (v > 0) el.d.value = round(el.du.value === "km" ? v * KM_PER_MI : v / KM_PER_MI, 1);
    render();
  });
  var lastEu = el.eu.value;
  el.eu.addEventListener("change", function () {
    var lpk = litresPerKm(parseFloat(el.e.value), lastEu);
    if (lpk > 0) el.e.value = round(fromLitresPerKm(lpk, el.eu.value), 2);
    lastEu = el.eu.value;
    render();
  });
  el.pu.addEventListener("change", function () {
    var v = parseFloat(el.p.value);
    if (state.touched && v > 0) el.p.value = round(el.pu.value === "l" ? v / L_PER_GAL : v * L_PER_GAL, 3);
    else fillUsPrice();
    render();
  });
  el.c.addEventListener("change", function () {
    if (!state.touched) { if (el.c.value === "USD") fillUsPrice(); else el.p.value = ""; }
    render();
  });
  el.p.addEventListener("input", function () { state.touched = el.p.value !== ""; render(); });
  [el.d, el.e, el.n].forEach(function (i) { i.addEventListener("input", render); });
  [el.rt, el.h].forEach(function (i) { i.addEventListener("change", render); });
  el.useUs.addEventListener("click", function () {
    el.c.value = "USD"; state.touched = false; fillUsPrice(); render();
  });
  el.hist.querySelectorAll("[data-range]").forEach(function (b) {
    b.addEventListener("click", function () { state.range = b.getAttribute("data-range"); render(); });
  });
  el.copy.addEventListener("click", function () {
    clearTimeout(urlTimer); saveUrl();
    setTimeout(function () {
      var done = function () { el.copy.textContent = "Link copied"; setTimeout(function () { el.copy.textContent = "Copy link to this result"; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, function () { window.prompt("Copy this link:", location.href); });
      else window.prompt("Copy this link:", location.href);
    }, 320);
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  if ("ResizeObserver" in window) new ResizeObserver(function () { if (el.h.checked) renderHistory(calc()); }).observe(el.hist);

  loadUrl();
  lastEu = el.eu.value;
  render();
  fetch("/data/fuel.json")
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) { state.data = data; fillUsPrice(); render(); })
    .catch(function () { state.data = false; render(); });
})();
