// Where US oil goes: flow chart of US petroleum supply, exports and uses, by year.
// Data: /data/flows.json, written from EIA data by scripts/fetch_flows.py. Plain JavaScript, no libraries.
(function () {
  "use strict";

  var svg = document.getElementById("of-chart");
  if (!svg) return;
  var NS = "http://www.w3.org/2000/svg";
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (id) { return document.getElementById(id); };
  var tip = $("of-tip"), box = $("of-scroll");

  // ---------- layout (SVG units) ----------
  // Domestic supply flows in from the left, imports rise from below, exports leave the top,
  // and what stays in the US splits into transport fuels and materials, then into each use.
  var W = 1340, H = 650, K = 7.5;           // K = SVG units per million barrels a day
  var T = 250;                              // top of the junction
  var XL = 160;                             // domestic flows start here
  var NX0 = 470, NX1 = 590;                 // the "total supply" junction: everything enters left, leaves right
  var XS = 810, XG = 890, XG2 = 970, XU = 1060;  // groups curve away at XS, run XG..XG2, fan out to uses at XU

  var DOMESTIC = [
    { id: "crude", k: "US crude oil",        y: 120, note: "Oil pumped from US wells." },
    { id: "ngl",   k: "Natural gas liquids", y: 282, note: "Ethane, propane and butane separated from natural gas at processing plants." },
    { id: "bio",   k: "Biofuels",            y: 392, note: "Mostly ethanol, blended into gasoline, plus biodiesel and renewable diesel." }
  ];
  var IMPORTS = [
    { id: "impcrude", k: "Imported crude", a: 270, r: 28, base: 590, note: "Crude oil bought from other countries, most of it from Canada." },
    { id: "impfuel",  k: "Imported fuels", a: 350, r: 26, base: 560, note: "Gasoline blending components, unfinished oils and finished fuels." },
    { id: "gain",     k: "Refinery gain",  a: 410, r: 24, base: 532, note: "Refined products take up more space than the crude they are made from." }
  ];
  var EXPORTS = [
    { id: "xcrude", k: "Crude exports",      cx: 600, r: 26, top: 60,  note: "Crude oil sold abroad." },
    { id: "xhgl",   k: "Gas liquid exports", cx: 668, r: 26, top: 90,  note: "Mostly propane, ethane and butane." },
    { id: "xfuel",  k: "Fuel exports",       cx: 736, r: 26, top: 120, note: "Diesel, gasoline, petroleum coke, jet fuel, biofuels and other products." }
  ];
  var GROUPS = [
    { id: "transport", k: "Transport", y: 220, uses: ["gas", "dsl", "jet"], note: "Gasoline, diesel and jet fuel." },
    { id: "materials", k: "Materials", y: 505, uses: ["other", "hgl"], note: "Gas liquids, asphalt, petroleum coke and other products." }
  ];
  var ICONS = {
    car: '<path d="M4 15v-3.5L6.3 7h11.4L20 11.5V15z"/><path d="M4 11.5h16"/><circle cx="7.5" cy="16.5" r="1.6"/><circle cx="16.5" cy="16.5" r="1.6"/>',
    truck: '<path d="M2.5 6.5h11v9h-11z"/><path d="M13.5 9.5h4l3 3.2v2.8h-7z"/><circle cx="6.5" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/>',
    plane: '<path d="M12 3c.8 0 1.2.9 1.2 2v4.3l7 4.2v1.8l-7-2.1v4l2 1.5v1.5L12 19.6l-3.2.6v-1.5l2-1.5v-4l-7 2.1v-1.8l7-4.2V5c0-1.1.4-2 1.2-2z"/>',
    road: '<path d="M8 21 10.2 3"/><path d="M16 21 13.8 3"/><path d="M12 5.5v2"/><path d="M12 11v2"/><path d="M12 16.5v2"/>',
    flask: '<path d="M9 3h6"/><path d="M10 3v6.2L5.2 17.6A2.3 2.3 0 0 0 7.2 21h9.6a2.3 2.3 0 0 0 2-3.4L14 9.2V3"/><path d="M7.6 15h8.8"/>'
  };
  var USES = [
    { id: "gas",   g: "transport", icon: "car",   p: "Gasoline",                 k: "Driving",            y: 110, d: ["Gasoline for cars, SUVs, pickups,", "motorbikes and boats"] },
    { id: "dsl",   g: "transport", icon: "truck", p: "Diesel & heating oil",     k: "Freight & farms",    y: 235, d: ["Diesel for trucks, trains, ships and", "tractors; heating oil for homes"] },
    { id: "jet",   g: "transport", icon: "plane", p: "Jet fuel",                 k: "Flying",             y: 335, d: ["Jet fuel for passenger and cargo planes"] },
    { id: "other", g: "materials", icon: "road",  p: "Asphalt, coke & other",    k: "Roads & industry",   y: 445, d: ["Asphalt for roads, petroleum coke,", "lubricants, refinery fuel, biofuels"] },
    { id: "hgl",   g: "materials", icon: "flask", p: "Propane, ethane & butane", k: "Plastics & heating", y: 555, d: ["Ethane and propane become plastics", "and chemicals; propane heats homes"] }
  ];
  var INPUTS = DOMESTIC.concat(IMPORTS);

  var S = { data: null, year: null, shown: null, hover: null, anim: 0 };

  // ---------- helpers ----------
  function num(v, d) { return new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v); }
  function mbd(v) { return num(v, 1) + " mb/d"; }
  function el(name, attrs, parent, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function sum(o) { var s = 0; for (var k in o) s += o[k]; return s; }
  function f(n) { return Math.round(n * 100) / 100; }

  // smooth band between two vertical spans (x0: y0..y1) -> (x1: z0..z1), optionally running straight on to x2
  function ribbon(x0, y0, y1, x1, z0, z1, x2) {
    var m = (x0 + x1) / 2, e = x2 || x1;
    return "M" + x0 + "," + f(y0) + " C" + m + "," + f(y0) + " " + m + "," + f(z0) + " " + x1 + "," + f(z0) + " L" + e + "," + f(z0) +
      " L" + e + "," + f(z1) + " L" + x1 + "," + f(z1) + " C" + m + "," + f(z1) + " " + m + "," + f(y1) + " " + x0 + "," + f(y1) + " Z";
  }
  // band rising from y = base, turning right into the trunk at slot y = s
  function joinPath(a, w, s, r, base, xEnd) {
    var R = r + w, cx = a + R, cy = s + R;
    return "M" + a + "," + base + " L" + a + "," + f(cy) + " A" + f(R) + "," + f(R) + " 0 0 1 " + f(cx) + "," + f(s) +
      " L" + xEnd + "," + f(s) + " L" + xEnd + "," + f(s + w) +
      " L" + f(cx) + "," + f(s + w) + " A" + r + "," + r + " 0 0 0 " + f(a + w) + "," + f(cy) + " L" + f(a + w) + "," + base + " Z";
  }
  // band leaving the top of the trunk at slot y = t, turning up to y = top
  function leavePath(cx, w, t, r, top, xStart) {
    var R = r + w, cy = t - r;
    return "M" + xStart + "," + f(t) + " L" + cx + "," + f(t) + " A" + r + "," + r + " 0 0 0 " + (cx + r) + "," + f(cy) + " L" + (cx + r) + "," + top +
      " L" + f(cx + R) + "," + top + " L" + f(cx + R) + "," + f(cy) + " A" + f(R) + "," + f(R) + " 0 0 1 " + cx + "," + f(t + w) + " L" + xStart + "," + f(t + w) + " Z";
  }

  // ---------- draw ----------
  function render(v) {
    while (svg.lastChild) svg.removeChild(svg.lastChild);
    var defs = el("defs", {}, svg);
    var g = el("g", {}, svg);
    var labels = el("g", {}, svg);
    var hover = S.hover;
    var off = function (id) { return hover && hover !== id; };
    var cls = function (id) { return off(id) ? "of-part of-fade" : "of-part of-main"; };
    var val = function (grp, id) { return (v[grp] && v[grp][id]) || 0; };

    // slots in the trunk, top to bottom: domestic, then imports
    var s = T;
    var dom = DOMESTIC.map(function (d) { var w = val("in", d.id) * K, o = { d: d, w: w, s: s, v: val("in", d.id) }; s += w; return o; });
    var imp = IMPORTS.map(function (d) { var w = val("in", d.id) * K, o = { d: d, w: w, s: s, x: d.a + d.r + w, v: val("in", d.id) }; s += w; return o; });
    var BOT = s, t = T;
    var outs = EXPORTS.map(function (d) { var w = val("out", d.id) * K, o = { d: d, w: w, t: t, v: val("out", d.id) }; t += w; return o; });
    var uses = {}, u = t;
    var groups = GROUPS.map(function (gr) {
      var list = gr.uses.map(function (id) { return USES.filter(function (x) { return x.id === id; })[0]; });
      var w = 0; list.forEach(function (x) { w += val("use", x.id) * K; });
      var o = { d: gr, w: w, s0: u, s1: u + w, z0: gr.y - w / 2, z1: gr.y + w / 2, v: w / K, list: list };
      u += w;
      var z = o.z0;
      list.forEach(function (x) { var ww = val("use", x.id) * K; uses[x.id] = { d: x, w: ww, s0: z, s1: z + ww, z0: x.y - ww / 2, z1: x.y + ww / 2, v: ww / K }; z += ww; });
      return o;
    });

    // gradients: imports fade in from below, exports fade out to the accent colour
    function grad(id, y1, y2, c1, c2) {
      var gr = el("linearGradient", { id: id, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: f(y1), y2: f(y2) }, defs);
      el("stop", { offset: 0, style: "stop-color: " + c1 }, gr);
      el("stop", { offset: 1, style: "stop-color: " + c2 }, gr);
      return "url(#" + id + ")";
    }

    // the junction: one solid block every flow enters on the left and leaves on the right
    var NB = Math.max(BOT, u);
    el("rect", { x: NX0, y: T, width: NX1 - NX0, height: f(NB - T), rx: 3, "class": "of-node" + (hover ? " of-node-off" : ""), "data-id": "total" }, g);

    dom.forEach(function (o) {
      el("path", { d: ribbon(XL, o.d.y, o.d.y + o.w, NX0, o.s, o.s + o.w), "class": cls(o.d.id), "data-id": o.d.id }, g);
    });
    imp.forEach(function (o, i) {
      var p = el("path", { d: joinPath(o.d.a, o.w, o.s, o.d.r, o.d.base, NX0), "class": "of-part of-strand", "data-id": o.d.id }, g);
      p.style.fill = off(o.d.id) ? "var(--rule)" : grad("of-i" + i, o.d.base, o.s + o.w + o.d.r, "var(--ink-3)", "var(--ink)");
    });
    outs.forEach(function (o, i) {
      var p = el("path", { d: leavePath(o.d.cx, o.w, o.t, o.d.r, o.d.top, NX1), "class": "of-part of-strand", "data-id": o.d.id }, g);
      p.style.fill = off(o.d.id) ? "var(--rule)" : grad("of-x" + i, o.t + o.w, o.t - o.d.r, "var(--ink)", "var(--accent)");
    });
    groups.forEach(function (o) {
      var on = !hover || hover === o.d.id || o.list.some(function (x) { return x.id === hover; });
      var m = (XS + XG) / 2;
      var d = "M" + NX1 + "," + f(o.s0) + " L" + XS + "," + f(o.s0) + " C" + m + "," + f(o.s0) + " " + m + "," + f(o.z0) + " " + XG + "," + f(o.z0) +
        " L" + XG2 + "," + f(o.z0) + " L" + XG2 + "," + f(o.z1) + " L" + XG + "," + f(o.z1) +
        " C" + m + "," + f(o.z1) + " " + m + "," + f(o.s1) + " " + XS + "," + f(o.s1) + " L" + NX1 + "," + f(o.s1) + " Z";
      el("path", { d: d, "class": "of-part " + (on ? "of-main" : "of-fade"), "data-id": o.d.id }, g);
    });
    USES.forEach(function (x) {
      var o = uses[x.id], gOn = hover && GROUPS.some(function (gr) { return gr.id === hover && gr.uses.indexOf(x.id) >= 0; });
      el("path", { d: ribbon(XG2, o.s0, o.s1, XU, o.z0, o.z1), "class": "of-part " + (!hover || hover === x.id || gOn ? "of-main" : "of-fade"), "data-id": x.id }, g);
    });

    // ---------- labels ----------
    function lab(id) {
      var on = hover === id || GROUPS.some(function (gr) { return gr.id === hover && gr.uses.indexOf(id) >= 0; });
      return el("g", { "class": "of-lab" + (on ? " on" : ""), "data-id": id }, labels);
    }
    dom.forEach(function (o) {
      var e = lab(o.d.id), cy = o.d.y + o.w / 2;
      el("text", { x: XL - 12, y: f(cy - 2), "text-anchor": "end", "class": "of-k" }, e, o.d.k);
      el("text", { x: XL - 12, y: f(cy + 14), "text-anchor": "end", "class": "of-v" }, e, mbd(o.v));
    });
    imp.forEach(function (o) {
      var e = lab(o.d.id);
      el("text", { x: o.d.a, y: o.d.base + 20, "class": "of-k" }, e, o.d.k);
      el("text", { x: o.d.a, y: o.d.base + 36, "class": "of-v" }, e, mbd(o.v));
    });
    outs.forEach(function (o) {
      var e = lab(o.d.id), x = o.d.cx + o.d.r;
      el("text", { x: x, y: o.d.top - 22, "class": "of-k out" }, e, o.d.k);
      el("text", { x: x, y: o.d.top - 7, "class": "of-v" }, e, mbd(o.v));
    });
    // inside the junction
    var lx = (NX0 + NX1) / 2, ly = (T + Math.max(BOT, u)) / 2;
    var tl = el("text", { x: lx, y: f(ly - 12), "text-anchor": "middle", "pointer-events": "none" }, labels);
    el("tspan", { "class": "of-trunk-k" }, tl, "Total");
    el("tspan", { "class": "of-trunk-k", x: lx, dy: "1.25em" }, tl, "supply");
    el("tspan", { "class": "of-trunk-v", x: lx, dy: "1.45em" }, tl, mbd(sum(v.in)));
    // inside the group bands
    groups.forEach(function (o) {
      var mx = (XG + XG2) / 2, cy = (o.z0 + o.z1) / 2;
      var tg = el("text", { x: mx, y: f(cy - 3), "text-anchor": "middle", "pointer-events": "none" }, labels);
      el("tspan", { "class": "of-grp-k" }, tg, o.d.k);
      el("tspan", { "class": "of-grp-v", x: mx, dy: "1.35em" }, tg, mbd(o.v));
    });

    USES.forEach(function (x) {
      var o = uses[x.id], e = lab(x.id);
      e.setAttribute("transform", "translate(" + (XU + 22) + "," + x.y + ")");
      el("circle", { cx: 16, cy: -4, r: 16, "class": "of-n" }, e);
      var ic = el("g", { transform: "translate(6,-14) scale(0.84)", "class": "of-icon" }, e);
      ic.innerHTML = ICONS[x.icon];
      el("text", { x: 44, y: -19, "class": "of-p" }, e, x.p);
      var tt = el("text", { x: 44, y: 0 }, e);
      el("tspan", { "class": "of-t" }, tt, x.k + "  ");
      el("tspan", { "class": "of-tv" }, tt, mbd(o.v));
      x.d.forEach(function (line, i) { el("text", { x: 44, y: 18 + i * 14, "class": "of-d" }, e, line); });
    });
    svg.classList.toggle("of-dim", !!hover);
  }

  // ---------- numbers above the chart ----------
  function renderTop(v) {
    var t = v.totals;
    $("of-produced").innerHTML = num(t.produced, 1) + " <small>mb/d</small>";
    $("of-imported").innerHTML = num(t.imported, 1) + " <small>mb/d</small>";
    $("of-used").innerHTML = num(t.used, 1) + " <small>mb/d</small>";
    $("of-exported").innerHTML = num(t.exported, 1) + " <small>mb/d</small>";
    var m = v.mix;
    if (m && m.petroleum) {
      $("of-mix").hidden = false;
      $("of-mix-pet").style.width = m.petroleum + "%";
      $("of-mix-gas").style.width = m.gas + "%";
      $("of-mix-oth").style.width = m.other + "%";
      $("of-mix-text").innerHTML = "<strong>Petroleum: " + Math.round(m.petroleum) + "% of all US energy use</strong> · natural gas " +
        Math.round(m.gas) + "% · coal, nuclear and renewables " + Math.round(m.other) + "%";
    } else {
      $("of-mix").hidden = true;
    }
  }

  // ---------- year changes animate between values ----------
  function lerpObj(a, b, f) {
    var o = {};
    for (var k in b) o[k] = (typeof b[k] === "object" && b[k]) ? lerpObj(a && a[k] || {}, b[k], f) : ((a && a[k] != null ? a[k] : b[k]) + (b[k] - (a && a[k] != null ? a[k] : b[k])) * f);
    return o;
  }
  function show(year) {
    var to = S.data.years[year], from = S.shown || to, t0 = performance.now(), dur = reduced || !S.shown ? 0 : 650;
    S.year = year;
    document.querySelectorAll("#of-years button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.year === year)); });
    $("of-year-note").textContent = year;
    cancelAnimationFrame(S.anim);
    (function step(now) {
      var f = dur ? Math.min(1, (now - t0) / dur) : 1, e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      S.shown = lerpObj(from, to, e);
      render(S.shown); renderTop(S.shown);
      if (f < 1) S.anim = requestAnimationFrame(step);
      else { S.shown = to; render(to); renderTop(to); }
    })(t0);
  }

  // ---------- hover and tap ----------
  var NAMES = {};
  INPUTS.concat(EXPORTS).forEach(function (d) { NAMES[d.id] = { head: d.k, note: d.note }; });
  GROUPS.forEach(function (d) { NAMES[d.id] = { head: d.k + " in the US", note: d.note }; });
  NAMES.total = { head: "Total supply", note: "Everything the US produced and imported, plus refinery gain." };
  USES.forEach(function (d) { NAMES[d.id] = { head: d.p + " → " + d.k }; });
  function valueOf(id) {
    var v = S.data.years[S.year], gr = GROUPS.filter(function (x) { return x.id === id; })[0];
    if (gr) return gr.uses.reduce(function (a, k) { return a + (v.use[k] || 0); }, 0);
    if (id === "total") return sum(v.in);
    return v.in[id] != null ? v.in[id] : v.out[id] != null ? v.out[id] : v.use[id];
  }

  function place(e) {
    var r = box.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = e.clientX - r.left + box.scrollLeft, y = e.clientY - r.top;
    var right = x > box.scrollLeft + box.clientWidth * 0.55;
    var left = right ? x - tw - 16 : x + 16, top = y - th - 14;
    if (top < 0) top = y + 18;
    tip.style.left = Math.max(box.scrollLeft + 4, left) + "px";
    tip.style.top = top + "px";
  }
  function setHover(id, e) {
    if (S.hover !== id) { S.hover = id; render(S.shown); }
    if (!id) { tip.hidden = true; return; }
    var v = valueOf(id), total = sum(S.data.years[S.year].in), n = NAMES[id];
    tip.innerHTML = '<div class="tt-title">' + n.head + '</div><div class="tt-big">' + num(v, 1) + ' million barrels a day</div>' +
      '<div class="tt-sub">' + num(v * 42, 0) + " million gallons a day · " + Math.round(v / total * 100) + "% of total supply</div>" +
      (n.note ? '<p class="tt-note">' + n.note + "</p>" : "");
    tip.hidden = false;
    place(e);
  }
  function idFrom(target) { var n = target.closest && target.closest("[data-id]"); return n ? n.getAttribute("data-id") : null; }
  svg.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse") setHover(idFrom(e.target), e); });
  svg.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") setHover(null); });
  svg.addEventListener("click", function (e) { var id = idFrom(e.target); setHover(id && id !== S.hover ? id : null, e); });

  // ---------- load ----------
  fetch("/data/flows.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (data) {
    S.data = data;
    var years = Object.keys(data.years).sort();
    var latest = String(data.latest || years[years.length - 1]);
    var wrap = $("of-years"), shownYears = years.slice(-6);
    if (shownYears.length > 1) {
      shownYears.forEach(function (y) {
        var b = document.createElement("button");
        b.type = "button"; b.dataset.year = y; b.textContent = y;
        b.addEventListener("click", function () { show(y); });
        wrap.appendChild(b);
      });
      $("of-year-wrap").hidden = false;
    }
    show(latest);
  }).catch(function () {
    $("of-error").hidden = false;
  });
})();
