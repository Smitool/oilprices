// US crude oil imports map (MapLibre + OpenFreeMap tiles).
// Expects window.IMPORTS_DATA (mockup) or loads data/imports.json (live site).
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var STATE_NAMES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico", VI: "U.S. Virgin Islands", GU: "Guam" };
  var STYLE = window.MAP_STYLE || "https://tiles.openfreemap.org/styles/positron";
  var FLOW = "#0b5563", INK = "#13222c", OIL = "#000000";
  var MAX_ROUTES = 250;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var S = { period: 0, grade: "", origin: "", st: "", playTimer: null, pinned: false };
  var D, mult = 1000, map, current, ready = false;
  var mapEl = $("map"), tip = $("map-tip"), msg = $("map-msg");
  var HOME = function () {
    var narrow = mapEl.clientWidth < 760;
    return { center: narrow ? [-92, 33] : [-80, 30], zoom: narrow ? 1.9 : 2.4 };
  };

  // ---------- helpers ----------
  function periodLabel(i, short) {
    var p = D.periods[i].split("-"), m = MONTHS[+p[1] - 1];
    return (short ? m.slice(0, 3) : m) + " " + p[0];
  }
  function daysIn(i) { var p = D.periods[i].split("-"); return new Date(+p[0], +p[1], 0).getDate(); }
  function fmtBbl(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " billion";
    if (b >= 1e6) return (b / 1e6).toFixed(1) + " million";
    if (b >= 1e4) return Math.round(b / 1e3).toLocaleString("en-US") + ",000";
    return Math.round(b).toLocaleString("en-US");
  }
  function fmtShort(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + "B";
    if (b >= 1e6) return (b / 1e6).toFixed(1) + "M";
    if (b >= 1e3) return Math.round(b / 1e3) + "K";
    return String(Math.round(b));
  }
  function pct(x) { return (x * 100 >= 10 ? Math.round(x * 100) : (x * 100).toFixed(1)) + "%"; }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function showMsg(t) { msg.textContent = t; msg.hidden = !t; }

  // Great-circle arc between two [lon, lat] points, longitudes unwrapped so lines never jump across the map.
  function arc(a, b, n) {
    var r = Math.PI / 180;
    var la1 = a[1] * r, lo1 = a[0] * r, la2 = b[1] * r, lo2 = b[0] * r;
    var p1 = [Math.cos(la1) * Math.cos(lo1), Math.cos(la1) * Math.sin(lo1), Math.sin(la1)];
    var p2 = [Math.cos(la2) * Math.cos(lo2), Math.cos(la2) * Math.sin(lo2), Math.sin(la2)];
    var d = Math.acos(Math.max(-1, Math.min(1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2])));
    if (d < 1e-6) return [a, b];
    var pts = [], prev = null;
    for (var i = 0; i <= n; i++) {
      var f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      var x = A * p1[0] + B * p2[0], y = A * p1[1] + B * p2[1], z = A * p1[2] + B * p2[2];
      var lon = Math.atan2(y, x) / r, lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / r;
      if (prev !== null) { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
      pts.push([lon, lat]); prev = lon;
    }
    return pts;
  }

  function km(a, b) {
    var r = Math.PI / 180, dLa = (b[1] - a[1]) * r, dLo = (b[0] - a[0]) * r;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ---------- start ----------
  var dataReady = window.IMPORTS_DATA ? Promise.resolve(window.IMPORTS_DATA)
    : fetch("data/imports.json").then(function (r) { if (!r.ok) throw new Error("nodata"); return r.json(); });

  dataReady.then(function (data) {
    D = data;
    if (!D.periods || !D.periods.length) throw new Error("nodata");
    mult = /thousand/i.test(D.units || "thousand") ? 1000 : 1;
    S.period = D.periods.length - 1;
    initFilters();
    initMap();
  }).catch(function (e) {
    showMsg(e && e.message === "nodata" ? "Import data is being prepared and will appear after the next data update." : "The map couldn't load. Refresh the page to try again.");
  });

  // ---------- filters ----------
  function totalsBy(index) { var t = {}; D.rows.forEach(function (r) { t[r[index]] = (t[r[index]] || 0) + r[4]; }); return t; }
  function initFilters() {
    var m = $("f-month");
    for (var i = D.periods.length - 1; i >= 0; i--) m.add(new Option(periodLabel(i), i));
    m.value = S.period;
    var g = $("f-grade");
    D.grades.forEach(function (gr, i) { g.add(new Option(gr.name, i)); });
    var o = $("f-origin"), ot = totalsBy(1);
    D.origins.map(function (c, i) { return i; }).filter(function (i) { return ot[i] > 0; })
      .sort(function (a, b) { return ot[b] - ot[a]; }).forEach(function (i) { o.add(new Option(D.origins[i].name, i)); });
    var s = $("f-state"), seen = {};
    D.ports.forEach(function (p) { if (p.state) seen[p.state] = 1; });
    Object.keys(seen).sort(function (a, b) { return (STATE_NAMES[a] || a).localeCompare(STATE_NAMES[b] || b); })
      .forEach(function (st) { s.add(new Option(STATE_NAMES[st] || st, st)); });

    m.addEventListener("change", function () { stopPlay(); S.period = +m.value; update(); });
    g.addEventListener("change", function () { S.grade = g.value; update(); });
    o.addEventListener("change", function () { S.origin = o.value; update(); });
    s.addEventListener("change", function () { S.st = s.value; update(); });
    $("filters").addEventListener("submit", function (e) { e.preventDefault(); });
    $("filters").addEventListener("reset", function () {
      stopPlay();
      setTimeout(function () { S.period = D.periods.length - 1; S.grade = ""; S.origin = ""; S.st = ""; m.value = S.period; update(); });
    });
    $("f-play").addEventListener("click", function () { S.playTimer ? stopPlay() : startPlay(); });
  }
  function startPlay() {
    var b = $("f-play"); b.setAttribute("aria-pressed", "true"); b.textContent = "Pause";
    S.period = S.period >= D.periods.length - 1 ? 0 : S.period + 1;
    $("f-month").value = S.period; update();
    S.playTimer = setInterval(function () {
      if (S.period >= D.periods.length - 1) { stopPlay(); return; }
      S.period += 1; $("f-month").value = S.period; update();
    }, 1600);
  }
  function stopPlay() {
    clearInterval(S.playTimer); S.playTimer = null;
    var b = $("f-play"); b.setAttribute("aria-pressed", "false"); b.textContent = "Play months";
  }
  function match(r) {
    if (S.grade !== "" && r[3] !== +S.grade) return false;
    if (S.origin !== "" && r[1] !== +S.origin) return false;
    if (S.st && D.ports[r[2]].state !== S.st) return false;
    return true;
  }
  function selection() {
    var routes = {}, byO = {}, byP = {}, total = 0;
    D.rows.forEach(function (r) {
      if (r[0] !== S.period || !match(r)) return;
      var v = r[4] * mult, k = r[1] + "-" + r[2];
      var rt = routes[k] || (routes[k] = { k: k, o: r[1], p: r[2], v: 0, g: {} });
      rt.v += v; rt.g[r[3]] = (rt.g[r[3]] || 0) + v;
      byO[r[1]] = (byO[r[1]] || 0) + v; byP[r[2]] = (byP[r[2]] || 0) + v; total += v;
    });
    var list = Object.keys(routes).map(function (k) { return routes[k]; }).sort(function (a, b) { return b.v - a.v; });
    return { routes: list, byO: byO, byP: byP, total: total, byKey: routes };
  }
  function series(test) {
    var per = new Array(D.periods.length).fill(0);
    D.rows.forEach(function (r) { if (S.grade !== "" && r[3] !== +S.grade) return; if (test(r)) per[r[0]] += r[4] * mult; });
    return per;
  }
  function peak(per) {
    var best = 0, active = 0;
    per.forEach(function (v, i) { if (v > per[best]) best = i; if (v > 0) active++; });
    return { i: best, v: per[best], active: active };
  }

  // ---------- map ----------
  function initMap() {
    var home = HOME();
    map = new maplibregl.Map({
      container: "map", style: STYLE, center: home.center, zoom: home.zoom,
      minZoom: 1, maxZoom: 10, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    $("z-reset").addEventListener("click", function () { var h = HOME(); map.flyTo({ center: h.center, zoom: h.zoom, duration: 600 }); });

    map.on("load", function () {
      map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "route-base", type: "line", source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": OIL, "line-width": ["get", "w"], "line-opacity": BASE_OPACITY } });
      map.addLayer({ id: "route-hit", type: "line", source: "routes",
        paint: { "line-color": FLOW, "line-width": ["+", ["get", "w"], 14], "line-opacity": 0 } });
      map.addLayer({ id: "points", type: "circle", source: "points",
        paint: { "circle-radius": ["get", "r"], "circle-color": ["case", ["==", ["get", "kind"], "origin"], FLOW, INK],
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 } });
      if (!window.MAP_NO_LABELS) {
        map.addLayer({ id: "labels", type: "symbol", source: "points", filter: ["!=", ["get", "label"], ""],
          layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 12,
            "text-anchor": "left", "text-offset": [0.9, 0], "text-optional": true },
          paint: { "text-color": INK, "text-halo-color": "#ffffff", "text-halo-width": 1.6 } });
      }
      bindHover();
      if (!reduceMotion) Flow.init();
      ready = true;
      update();
    });
  }

  // ---------- oil flow animation ----------
  // Streaks of oil move along each route on a canvas above the map. They start slowly at the
  // country of origin and speed up as they approach the US port, stretching as they accelerate.
  var BASE_OPACITY = reduceMotion ? 0.6 : 0.26;
  var Flow = {
    canvas: null, ctx: null, routes: [], dirty: true, hot: null, dpr: 1,
    init: function () {
      var c = document.createElement("canvas");
      c.className = "flow-canvas";
      map.getCanvasContainer().appendChild(c);
      this.canvas = c; this.ctx = c.getContext("2d");
      var self = this;
      map.on("move", function () { self.dirty = true; });
      map.on("resize", function () { self.dirty = true; });
      requestAnimationFrame(function loop(t) { self.draw(t); requestAnimationFrame(loop); });
    },
    set: function (feats, maxV) {
      if (!this.ctx) return;
      this.routes = feats.map(function (f) {
        var r = f.properties, km = f.properties.km;
        return {
          k: r.k, o: r.o, p: r.p, w: r.w, coords: f.geometry.coordinates,
          n: Math.max(3, Math.round(3 + 12 * Math.sqrt(r.v / maxV))),  // more oil, more streaks
          T: 3 + km / 2200,                                              // seconds from origin to port
          phase: Math.random(), px: null, cum: null
        };
      });
      this.dirty = true;
    },
    project: function () {
      var W = map.getCanvas().clientWidth, H = map.getCanvas().clientHeight, dpr = window.devicePixelRatio || 1;
      if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
        this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
        this.canvas.style.width = W + "px"; this.canvas.style.height = H + "px";
      }
      this.dpr = dpr;
      this.routes.forEach(function (r) {
        var px = r.coords.map(function (c) { var p = map.project(c); return [p.x, p.y]; });
        var cum = [0];
        for (var i = 1; i < px.length; i++) {
          var dx = px[i][0] - px[i - 1][0], dy = px[i][1] - px[i - 1][1];
          cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
        }
        r.px = px; r.cum = cum;
      });
      this.dirty = false;
    },
    at: function (r, s) {
      var L = r.cum[r.cum.length - 1] * s, i = 1;
      while (i < r.cum.length - 1 && r.cum[i] < L) i++;
      var seg = r.cum[i] - r.cum[i - 1] || 1, f = (L - r.cum[i - 1]) / seg;
      return [r.px[i - 1][0] + (r.px[i][0] - r.px[i - 1][0]) * f, r.px[i - 1][1] + (r.px[i][1] - r.px[i - 1][1]) * f];
    },
    match: function (r) {
      var h = this.hot;
      if (!h) return true;
      return h.k ? r.k === h.k : r[h.field] === h.val;
    },
    draw: function (t) {
      if (!this.ctx) return;
      if (this.dirty) this.project();
      var ctx = this.ctx, dpr = this.dpr, now = t / 1000, self = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      var ease = function (u) { return Math.pow(u, 2.2); };       // slow start, fast finish
      this.routes.forEach(function (r) {
        if (!r.px || r.cum[r.cum.length - 1] < 4) return;
        var on = self.match(r), alpha = on ? 1 : 0.07;
        var width = Math.max(1.8, r.w * 0.75);
        for (var j = 0; j < r.n; j++) {
          var u = (now / r.T + r.phase + j / r.n) % 1;
          var s1 = ease(u), s0 = ease(Math.max(0, u - 0.09));      // tail: longer when moving faster
          var fade = Math.min(1, u / 0.08, (1 - u) / 0.06);         // ease in at origin, sink into the port
          if (fade <= 0) continue;
          var a = self.at(r, s0), b = self.at(r, s1);
          ctx.globalAlpha = alpha * fade;
          ctx.strokeStyle = "#000000"; ctx.lineWidth = width;
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = Math.max(0.6, width * 0.28);   // oily sheen
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
      });
      ctx.globalAlpha = 1;
    }
  };

  function update() {
    if (!D) return;
    current = selection();
    renderPanel(); renderTable();
    var countries = Object.keys(current.byO).length;
    $("imports-sub").textContent = current.total > 0
      ? periodLabel(S.period) + ": " + fmtBbl(current.total) + " barrels of crude oil from " + countries + (countries === 1 ? " country" : " countries") +
        (S.grade !== "" ? " (" + D.grades[+S.grade].name.toLowerCase() + ")" : "") + "."
      : periodLabel(S.period) + ": no imports match this selection.";
    showMsg(current.total > 0 ? "" : "No imports match this selection. Try another month, grade, country or state.");
    if (!ready) return;
    unpin();

    var routes = current.routes.filter(function (r) { return D.origins[r.o].lon != null; }).slice(0, MAX_ROUTES);
    var maxV = routes.length ? routes[0].v : 1;
    var feats = routes.map(function (r, i) {
      var o = D.origins[r.o], p = D.ports[r.p];
      return { type: "Feature", id: i, properties: { k: r.k, o: r.o, p: r.p, v: r.v, w: 1.2 + 9 * Math.sqrt(r.v / maxV), km: km([o.lon, o.lat], [p.lon, p.lat]) },
        geometry: { type: "LineString", coordinates: arc([o.lon, o.lat], [p.lon, p.lat], 64) } };
    });
    map.getSource("routes").setData({ type: "FeatureCollection", features: feats });
    Flow.set(feats, maxV);

    var maxO = Math.max.apply(null, Object.values(current.byO).concat([1]));
    var maxP = Math.max.apply(null, Object.values(current.byP).concat([1]));
    var topO = Object.keys(current.byO).sort(function (a, b) { return current.byO[b] - current.byO[a]; }).slice(0, 8);
    var topP = Object.keys(current.byP).sort(function (a, b) { return current.byP[b] - current.byP[a]; }).slice(0, 6);
    var pts = [];
    Object.keys(current.byO).forEach(function (o) {
      var c = D.origins[o]; if (c.lon == null) return;
      pts.push({ type: "Feature", properties: { kind: "origin", i: +o, v: current.byO[o], r: 3.5 + 8 * Math.sqrt(current.byO[o] / maxO),
        label: topO.indexOf(o) >= 0 ? c.name : "" }, geometry: { type: "Point", coordinates: [c.lon, c.lat] } });
    });
    Object.keys(current.byP).forEach(function (p) {
      var c = D.ports[p];
      pts.push({ type: "Feature", properties: { kind: "port", i: +p, v: current.byP[p], r: 3 + 7 * Math.sqrt(current.byP[p] / maxP),
        label: topP.indexOf(p) >= 0 ? c.name : "" }, geometry: { type: "Point", coordinates: [c.lon, c.lat] } });
    });
    map.getSource("points").setData({ type: "FeatureCollection", features: pts });
  }

  // ---------- hover & tooltips ----------
  function highlight(expr, hot) {
    Flow.hot = expr ? hot : null;
    map.setPaintProperty("route-base", "line-opacity", expr ? ["case", expr, 0.55, 0.04] : BASE_OPACITY);
  }
  function hide() { tip.hidden = true; if (ready) highlight(null); map && (map.getCanvas().style.cursor = ""); }
  function unpin() { S.pinned = false; hide(); }
  function placeTip(pt) {
    var W = mapEl.clientWidth, H = mapEl.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = pt.x + 16 + tw > W ? pt.x - 16 - tw : pt.x + 16;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.min(Math.max(8, pt.y - th / 2), H - th - 8) + "px";
  }
  function tipStart(title) { tip.replaceChildren(); tip.appendChild(el("div", "tt-title", title)); }
  function tipBig(b) {
    tip.appendChild(el("div", "tt-big", fmtBbl(b) + " barrels"));
    tip.appendChild(el("div", "tt-sub", "in " + periodLabel(S.period) + ", about " + fmtBbl(b / daysIn(S.period)) + " barrels per day"));
  }
  function tipRows(rows) {
    var dl = el("dl", "tt-rows");
    rows.forEach(function (r) { var w = el("div"); w.appendChild(el("dt", null, r[0])); w.appendChild(el("dd", null, r[1])); dl.appendChild(w); });
    tip.appendChild(dl);
  }
  function showRoute(f, pt) {
    var d = current.byKey[f.properties.k]; if (!d) return;
    var o = D.origins[d.o], p = D.ports[d.p];
    tipStart(o.name + " to " + p.name);
    tipBig(d.v);
    var grades = Object.keys(d.g).sort(function (a, b) { return d.g[b] - d.g[a]; }).map(function (g) { return D.grades[g].name + " " + pct(d.g[g] / d.v); }).join(", ");
    var pk = peak(series(function (r) { return r[1] === d.o && r[2] === d.p; }));
    tipRows([["Share of selection", pct(d.v / current.total)], ["Grades", grades],
      ["Largest month", periodLabel(pk.i, true) + ", " + fmtBbl(pk.v) + " barrels"], ["Months with imports", pk.active + " of " + D.periods.length]]);
    if (p.approx) tip.appendChild(el("p", "tt-note", "Port shown at the centre of " + (STATE_NAMES[p.state] || "its state") + "."));
    tip.hidden = false; placeTip(pt);
    highlight(["==", ["get", "k"], d.k], { k: d.k });
  }
  function showPoint(f, pt) {
    var isO = f.properties.kind === "origin", i = f.properties.i, v = f.properties.v;
    var src = isO ? D.origins[i] : D.ports[i];
    tipStart(src.name);
    tipBig(v);
    var related = current.routes.filter(function (r) { return isO ? r.o === i : r.p === i; }).slice(0, 3)
      .map(function (r) { return (isO ? D.ports[r.p].name : D.origins[r.o].name) + " " + pct(r.v / v); }).join(", ");
    var pk = peak(series(function (r) { return isO ? r[1] === i : r[2] === i; }));
    tipRows([["Share of selection", pct(v / current.total)], [isO ? "Main ports of entry" : "Main suppliers", related],
      ["Largest month", periodLabel(pk.i, true) + ", " + fmtBbl(pk.v) + " barrels"]]);
    if (!isO && src.approx) tip.appendChild(el("p", "tt-note", "Port shown at the centre of " + (STATE_NAMES[src.state] || "its state") + "."));
    tip.hidden = false; placeTip(pt);
    highlight(["==", ["get", isO ? "o" : "p"], i], { field: isO ? "o" : "p", val: i });
  }
  function pick(point) {
    var pf = map.queryRenderedFeatures(point, { layers: ["points"] });
    if (pf.length) return { kind: "point", f: pf[0] };
    var rf = map.queryRenderedFeatures(point, { layers: ["route-hit"] });
    if (rf.length) {
      rf.sort(function (a, b) { return a.properties.w - b.properties.w; }); // thinnest on top is easier to hover
      return { kind: "route", f: rf[0] };
    }
    return null;
  }
  function bindHover() {
    map.on("mousemove", function (e) {
      if (S.pinned) return;
      var hit = pick(e.point);
      if (!hit) { hide(); return; }
      map.getCanvas().style.cursor = "pointer";
      hit.kind === "point" ? showPoint(hit.f, e.point) : showRoute(hit.f, e.point);
    });
    map.getCanvas().addEventListener("mouseleave", function () { if (!S.pinned) hide(); });
    map.on("click", function (e) {
      var hit = pick(e.point);
      if (!hit) { unpin(); return; }
      S.pinned = true;
      hit.kind === "point" ? showPoint(hit.f, e.point) : showRoute(hit.f, e.point);
    });
    map.on("movestart", function () { if (!S.pinned) hide(); });
  }

  // ---------- panel & table ----------
  function renderPanel() {
    var t = current.total;
    $("k-total").textContent = t ? fmtShort(t) + " bbl" : "–";
    $("k-day").textContent = t ? fmtShort(t / daysIn(S.period)) + " bbl" : "–";
    $("k-countries").textContent = t ? Object.keys(current.byO).length : "–";
    bars($("b-origins"), current.byO, function (i) { return D.origins[i].name; }, function (i) {
      S.origin = S.origin === String(i) ? "" : String(i); $("f-origin").value = S.origin; update();
    });
    bars($("b-ports"), current.byP, function (i) { return D.ports[i].name; });
  }
  function bars(ol, obj, name, onClick) {
    ol.replaceChildren();
    var keys = Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).slice(0, 8);
    var max = keys.length ? obj[keys[0]] : 1;
    keys.forEach(function (k) {
      var li = el("li"), row = el(onClick ? "button" : "div", "bar-row");
      if (onClick) { row.type = "button"; row.title = "Show only " + name(k); row.addEventListener("click", function () { onClick(+k); }); }
      row.appendChild(el("span", "bar-name", name(k)));
      row.appendChild(el("span", "bar-val", fmtShort(obj[k]) + " bbl, " + pct(obj[k] / current.total)));
      var track = el("span", "bar-track"), fill = el("span", "bar-fill");
      fill.style.width = Math.max(2, (obj[k] / max) * 100) + "%";
      track.appendChild(fill); row.appendChild(track); li.appendChild(row); ol.appendChild(li);
    });
  }
  function renderTable() {
    var tb = document.querySelector("#t-routes tbody"); tb.replaceChildren();
    var days = daysIn(S.period);
    current.routes.forEach(function (r) {
      var tr = el("tr");
      [D.origins[r.o].name, D.ports[r.p].name, Math.round(r.v).toLocaleString("en-US"), Math.round(r.v / days).toLocaleString("en-US"), pct(r.v / current.total)]
        .forEach(function (v, i) { tr.appendChild(el(i === 0 ? "th" : "td", null, v)); });
      tr.firstChild.scope = "row"; tb.appendChild(tr);
    });
  }
})();
