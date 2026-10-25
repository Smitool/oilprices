// US Strategic Petroleum Reserve tracker: animated barrel, drag-to-explore estimates, 12-month playback, history chart.
// Data: /data/spr.json, written weekly from EIA data by scripts/fetch_spr.py. Plain JavaScript, no libraries.
(function () {
  "use strict";

  var CAPACITY = 714, MAX_RATE = 4.4;            // million barrels; million barrels a day
  var TOP = 64, BOTTOM = 356, X0 = 30, X1 = 290;  // barrel interior in SVG units
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (id) { return document.getElementById(id); };
  var svg = $("spr-barrel");
  if (!svg) return;

  var el = {
    wave: $("spr-wave"), back: $("spr-wave-back"), surface: $("spr-surface"), level: $("spr-level"), marks: $("spr-marks"),
    mode: $("spr-mode"), mb: $("spr-mb"), sub: $("spr-sub"), chips: $("spr-chips"), use: $("spr-days-use"), imp: $("spr-days-imp"),
    max: $("spr-days-max"), refill: $("spr-refill"), basisUse: $("spr-basis-use"), basisImp: $("spr-basis-imp"),
    refillBasis: $("spr-refill-basis"), rate: $("spr-rate"), rateOut: $("spr-rate-out"), price: $("spr-price"), cost: $("spr-cost"),
    reset: $("spr-reset"), play: $("spr-play"), playIcon: $("spr-play-icon"), time: $("spr-time"), timeOut: $("spr-time-out"), hint: $("spr-hint")
  };
  var S = { data: null, mode: "today", value: 0, shown: 0, tilt: 0, tiltV: 0, energy: 0, t: 0, playing: false, playPos: 0, week: null, range: "all" };

  // ---------- helpers ----------
  function num(v, d) { return new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v); }
  function dayText(t) { var d = new Date(t); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); }
  function monthText(t) { var d = new Date(t); return MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); }
  function yOf(v) { return BOTTOM - Math.max(0, Math.min(v, CAPACITY * 1.03)) / CAPACITY * (BOTTOM - TOP); }
  function vOf(y) { return Math.max(0, Math.min(CAPACITY, (BOTTOM - y) / (BOTTOM - TOP) * CAPACITY)); }
  function avg(rows) { var n = 0, s = 0; rows.slice(-4).forEach(function (r) { s += r[1]; n++; }); return n ? s / n : null; }
  function duration(months) {
    if (months <= 0) return "Already full";
    var y = Math.floor(months / 12), m = Math.round(months - y * 12);
    if (m === 12) { y++; m = 0; }
    return (y ? y + (y === 1 ? " year" : " years") : "") + (y && m ? " " : "") + (m ? m + (m === 1 ? " month" : " months") : "");
  }

  // ---------- capacity marks ----------
  [0.25, 0.5, 0.75, 1].forEach(function (f) {
    var y = yOf(CAPACITY * f), ns = "http://www.w3.org/2000/svg";
    var l = document.createElementNS(ns, "line");
    l.setAttribute("x1", 44); l.setAttribute("x2", 56); l.setAttribute("y1", y); l.setAttribute("y2", y);
    el.marks.appendChild(l);
    var t = document.createElementNS(ns, "text");
    t.setAttribute("x", 38); t.setAttribute("y", y + 4); t.setAttribute("text-anchor", "end");
    t.textContent = f === 1 ? "714" : Math.round(CAPACITY * f);
    el.marks.appendChild(t);
  });

  // ---------- the liquid ----------
  function wavePath(y0, t, phase, amp) {
    var d = "", tilt = S.tilt;
    for (var x = X0; x <= X1; x += 5) {
      var y = y0 + amp * Math.sin(x * 0.045 + t * 1.6 + phase) + amp * 0.55 * Math.sin(x * 0.11 - t * 2.3 + phase * 2)
        + tilt * (x - 160) / 130;
      d += (x === X0 ? "M" : "L") + x + " " + y.toFixed(2);
    }
    return d;
  }
  function draw() {
    var y0 = yOf(S.shown), amp = reduced ? 0 : 1.6 + Math.min(S.energy, 6);
    var front = wavePath(y0, S.t, 0, amp);
    el.surface.setAttribute("d", front);
    el.wave.setAttribute("d", front + "L" + X1 + " 400L" + X0 + " 400Z");
    el.back.setAttribute("d", wavePath(y0 - 3, S.t * 0.8, 1.9, amp * 0.8) + "L" + X1 + " 400L" + X0 + " 400Z");
    el.level.setAttribute("transform", "translate(0 " + y0.toFixed(1) + ")");
  }
  var last = 0, running = false, visible = true;
  function frame(ts) {
    var dt = Math.min(0.05, (ts - (last || ts)) / 1000); last = ts;
    S.t += dt;
    // ease the shown level towards the target and slosh with the movement
    var delta = S.value - S.shown;
    S.shown += delta * Math.min(1, dt * (S.playing ? 30 : 9));
    S.tiltV += (-30 * S.tilt - 3.2 * S.tiltV) * dt - delta * 0.9 * dt * 60 / 60;
    S.tilt += S.tiltV * dt;
    S.tilt = Math.max(-14, Math.min(14, S.tilt));
    S.energy = Math.max(0, S.energy - dt * 2.5);
    if (S.playing) advancePlay(dt);
    draw();
    if (running) requestAnimationFrame(frame);
  }
  function start() { if (!running && visible && !document.hidden && !reduced) { running = true; last = 0; requestAnimationFrame(frame); } }
  function stop() { running = false; }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (e) { visible = e[0].isIntersecting; if (visible) start(); else stop(); }).observe(svg);
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });

  function setValue(v, kick) {
    if (kick) { S.energy = Math.min(6, S.energy + Math.abs(v - S.value) / 25); S.tiltV += (S.value - v) * 0.25; }
    S.value = v;
    if (reduced) { S.shown = v; draw(); }
    renderPanel();
  }

  // ---------- panel ----------
  function series() { return S.data ? S.data.level : []; }
  function latest() { var s = series(); return s[s.length - 1]; }
  function valueAt(i) { return series()[i][1] / 1000; }

  function renderPanel() {
    if (!S.data) return;
    var v = S.value, lt = latest(), today = lt[1] / 1000;
    var use = avg(S.data.consumption), imp = avg(S.data.netImports);
    el.mb.textContent = num(v, 1);
    el.reset.hidden = S.mode === "today";
    el.hint.hidden = S.mode === "whatif";
    if (S.mode === "today") {
      el.mode.textContent = "This week";
      el.sub.textContent = num(v / CAPACITY * 100, 1) + "% of its 714 million-barrel capacity · week ending " + dayText(Date.parse(lt[0]));
    } else if (S.mode === "history") {
      el.mode.textContent = "Week ending " + dayText(S.week);
      el.sub.textContent = num(v / CAPACITY * 100, 1) + "% of capacity · " + (v >= today ? num(v - today, 1) + " million barrels more than this week" : num(today - v, 1) + " million barrels less than this week");
    } else {
      el.mode.textContent = "What if the reserve held…";
      el.sub.textContent = num(v / CAPACITY * 100, 1) + "% of capacity · " + (v >= today ? "+" : "−") + num(Math.abs(v - today), 1) + " million barrels vs this week";
    }
    renderChips();
    el.use.textContent = use ? num(v * 1000 / use, 0) + " days" : "–";
    el.basisUse.textContent = use ? "at " + num(use / 1000, 1) + " million barrels a day" : "";
    el.imp.textContent = imp && imp > 0 ? num(v * 1000 / imp, 0) + " days" : "–";
    el.basisImp.textContent = imp && imp > 0 ? "at " + num(imp / 1000, 1) + " million barrels a day" : "";
    el.max.textContent = num(v / MAX_RATE, 0) + " days";
    var rate = parseFloat(el.rate.value), gap = CAPACITY - v;
    el.rateOut.textContent = num(rate, 1);
    el.refill.textContent = duration(gap / rate);
    var paceNote = S.data.pace && Math.abs(rate - S.data.pace.rate) < 0.05 ? " (the " + S.data.pace.year + " pace)" : "";
    el.refillBasis.textContent = gap > 0 ? num(gap, 0) + " million barrels at " + num(rate, 1) + " a month" + paceNote : "";
    var price = parseFloat(el.price.value);
    el.cost.textContent = gap > 0 && price > 0 ? "$" + num(gap * price / 1000, 1) + " billion" : "–";
  }

  function renderChips() {
    var out = [], s = series(), n = s.length, lt = s[n - 1], cur = lt[1] / 1000, tNow = Date.parse(lt[0]);
    function before(days) {
      for (var i = n - 1; i >= 0; i--) if (Date.parse(s[i][0]) <= tNow - days * 864e5) return s[i][1] / 1000;
      return null;
    }
    if (S.mode === "today") {
      var w = before(7), y = before(365);
      if (w !== null) out.push(chip("1 week", cur - w, null));
      if (y !== null) out.push(chip("1 year", cur - y, (cur - y) / y * 100));
      var since = lowSince();
      if (since) out.push('<li class="spr-chip-note">' + since + "</li>");
    }
    el.chips.innerHTML = out.join("");
  }
  function chip(label, diff, pct) {
    var cls = diff > 0.05 ? "up" : diff < -0.05 ? "down" : "";
    var sign = diff > 0.05 ? "+" : diff < -0.05 ? "−" : "";
    return '<li class="' + cls + '">' + label + " " + sign + num(Math.abs(diff), 1) + " M" + (pct !== null ? " (" + sign + num(Math.abs(pct), 0) + "%)" : "") + "</li>";
  }
  function lowSince() {
    var s = series(), n = s.length, cur = s[n - 1][1];
    for (var i = n - 2; i >= 0; i--) {
      if (s[i][1] <= cur) {
        if (Date.parse(s[n - 1][0]) - Date.parse(s[i][0]) < 120 * 864e5) return null;
        return "Lowest since " + monthText(Date.parse(s[i][0]));
      }
    }
    return "Lowest on record";
  }

  // ---------- drag the level ----------
  function svgY(evt) {
    var pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse()).y;
  }
  var dragging = false;
  svg.addEventListener("pointerdown", function (e) {
    if (!S.data) return;
    dragging = true; svg.setPointerCapture(e.pointerId); stopPlay();
    S.mode = "whatif"; setValue(vOf(svgY(e)), true); e.preventDefault();
  });
  svg.addEventListener("pointermove", function (e) { if (dragging) setValue(vOf(svgY(e)), true); });
  svg.addEventListener("pointerup", function () { dragging = false; });
  svg.addEventListener("pointercancel", function () { dragging = false; });
  el.level.setAttribute("tabindex", "0");
  el.level.setAttribute("role", "slider");
  el.level.setAttribute("aria-label", "Oil level in million barrels");
  el.level.setAttribute("aria-valuemin", "0");
  el.level.setAttribute("aria-valuemax", String(CAPACITY));
  el.level.addEventListener("keydown", function (e) {
    var step = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 50, PageDown: -50 }[e.key];
    if (step === undefined) return;
    e.preventDefault(); stopPlay(); S.mode = "whatif";
    setValue(Math.max(0, Math.min(CAPACITY, S.value + step)), true);
  });
  el.reset.addEventListener("click", function () { stopPlay(); showToday(true); });
  el.rate.addEventListener("input", renderPanel);
  el.price.addEventListener("input", renderPanel);

  // ---------- 12-month playback ----------
  var yearIdx = [];
  function setupTimeline() {
    var s = series(), tNow = Date.parse(s[s.length - 1][0]);
    yearIdx = [];
    for (var i = 0; i < s.length; i++) if (Date.parse(s[i][0]) >= tNow - 366 * 864e5) yearIdx.push(i);
    el.time.max = String(yearIdx.length - 1);
    el.time.value = el.time.max;
    el.timeOut.textContent = "Week ending " + dayText(tNow);
  }
  function showWeek(pos, kick) {
    var a = Math.floor(pos), b = Math.min(a + 1, yearIdx.length - 1), f = pos - a;
    var s = series(), ia = yearIdx[a], ib = yearIdx[b];
    var v = valueAt(ia) + (valueAt(ib) - valueAt(ia)) * f;
    var near = f < 0.5 ? ia : ib;
    S.week = Date.parse(s[near][0]);
    el.timeOut.textContent = "Week ending " + dayText(S.week);
    el.level.setAttribute("aria-valuenow", v.toFixed(1));
    S.mode = near === s.length - 1 && !S.playing ? "today" : "history";
    setValue(v, kick);
  }
  function advancePlay(dt) {
    S.playPos += dt * (yearIdx.length - 1) / 9;   // the whole year in about 9 seconds
    if (S.playPos >= yearIdx.length - 1) { S.playPos = yearIdx.length - 1; stopPlay(); showToday(false); return; }
    el.time.value = S.playPos.toFixed(2);
    showWeek(S.playPos, true);
  }
  function stopPlay() {
    if (!S.playing) return;
    S.playing = false;
    el.play.setAttribute("aria-pressed", "false");
    el.playIcon.setAttribute("d", "M3 1.5v11l9-5.5z");
    el.play.querySelector("span").textContent = "Play the last 12 months";
  }
  el.time.step = "0.01";
  el.play.addEventListener("click", function () {
    if (!S.data) return;
    if (S.playing) { stopPlay(); return; }
    S.playing = true; S.playPos = 0;
    el.play.setAttribute("aria-pressed", "true");
    el.playIcon.setAttribute("d", "M3 1.5h3v11H3zM8 1.5h3v11H8z");
    el.play.querySelector("span").textContent = "Pause";
    if (reduced) {  // no animation: jump through the year quickly
      var p = 0, timer = setInterval(function () {
        p += 1; el.time.value = p; showWeek(Math.min(p, yearIdx.length - 1));
        if (p >= yearIdx.length - 1) { clearInterval(timer); stopPlay(); showToday(false); }
      }, 120);
    } else start();
  });
  el.time.addEventListener("input", function () { stopPlay(); showWeek(parseFloat(el.time.value), true); });

  function showToday(kick) {
    S.mode = "today";
    el.time.value = el.time.max;
    el.timeOut.textContent = "Week ending " + dayText(Date.parse(latest()[0]));
    setValue(latest()[1] / 1000, kick);
  }

  // ---------- history chart ----------
  var NS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs, parent) { var n = document.createElementNS(NS, name); for (var k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; }
  function chart() {
    var fig = document.querySelector(".spr-history"), box = fig.querySelector(".chart-box"), tip = box.querySelector(".chart-tip");
    fig.querySelectorAll("[data-range]").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-range") === S.range ? "true" : "false"); });
    var old = box.querySelector("svg"); if (old) old.remove();
    var s = series(), tNow = Date.parse(s[s.length - 1][0]);
    var days = { "1y": 366, "10y": 3653, "all": Infinity }[S.range];
    var pts = s.filter(function (r) { return days === Infinity || Date.parse(r[0]) >= tNow - days * 864e5; })
      .map(function (r) { return [Date.parse(r[0]), r[1] / 1000]; });
    if (pts.length < 2) return;
    var W = box.clientWidth || 600, H = box.clientHeight || 300, m = { t: 12, r: 46, b: 26, l: 4 };
    var x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    var vals = pts.map(function (p) { return p[1]; });
    var lo = Math.min.apply(null, vals), hi = Math.max(Math.max.apply(null, vals), S.range === "all" ? CAPACITY : 0);
    var pad = (hi - lo) * 0.1 || 10, step = (hi - lo + 2 * pad) > 300 ? 100 : (hi - lo + 2 * pad) > 120 ? 50 : 20;
    var y0 = Math.max(0, Math.floor((lo - pad) / step) * step), y1 = Math.ceil((hi + pad) / step) * step;
    function X(t) { return m.l + (t - x0) / (x1 - x0) * (W - m.l - m.r); }
    function Y(v) { return m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b); }
    var g = svgEl("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "SPR level from " + monthText(x0) + " to " + monthText(x1) });
    for (var v = y0; v <= y1 + 1e-9; v += step) {
      svgEl("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), "class": "chart-grid" }, g);
      svgEl("text", { x: W - m.r + 8, y: Y(v) + 4, "class": "chart-axis" }, g).textContent = v;
    }
    var spanY = (x1 - x0) / (365.25 * 864e5), every = spanY > 25 ? 5 : spanY > 6 ? 2 : 1;
    if (spanY > 1.5) {
      for (var yy = new Date(x0).getUTCFullYear() + 1; Date.UTC(yy, 0, 1) <= x1; yy++) {
        if (yy % every) continue;
        var tx = X(Date.UTC(yy, 0, 1));
        if (tx > 16 && tx < W - m.r - 16) svgEl("text", { x: tx, y: H - 6, "class": "chart-axis", "text-anchor": "middle" }, g).textContent = yy;
      }
    } else {
      var d0 = new Date(x0);
      for (var mo = 1; mo <= 13; mo += 2) {
        var t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + mo, 1); if (t > x1) break;
        var txm = X(t), dm = new Date(t);
        if (txm > 16 && txm < W - m.r - 16) svgEl("text", { x: txm, y: H - 6, "class": "chart-axis", "text-anchor": "middle" }, g).textContent = MONTHS[dm.getUTCMonth()] + (dm.getUTCMonth() === 0 ? " " + dm.getUTCFullYear() : "");
      }
    }
    if (CAPACITY <= y1) svgEl("line", { x1: m.l, x2: W - m.r, y1: Y(CAPACITY), y2: Y(CAPACITY), "class": "fc-today-line" }, g);
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1); }).join("");
    svgEl("path", { d: line + "L" + X(x1) + " " + Y(y0) + "L" + X(x0) + " " + Y(y0) + "Z", "class": "chart-area spr-area" }, g);
    svgEl("path", { d: line, "class": "chart-line spr-line" }, g);
    var guide = svgEl("line", { y1: m.t, y2: H - m.b, "class": "chart-guide", visibility: "hidden" }, g);
    var dot = svgEl("circle", { r: 4, "class": "chart-dot", visibility: "hidden" }, g);
    var hit = svgEl("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, g);
    function show(evt) {
      var r = g.getBoundingClientRect(), t = x0 + (evt.clientX - r.left - m.l) / (W - m.l - m.r) * (x1 - x0), a = 0, b = pts.length - 1;
      while (b - a > 1) { var mid = (a + b) >> 1; if (pts[mid][0] < t) a = mid; else b = mid; }
      var p = Math.abs(pts[a][0] - t) < Math.abs(pts[b][0] - t) ? pts[a] : pts[b], cx = X(p[0]), cy = Y(p[1]);
      guide.setAttribute("x1", cx); guide.setAttribute("x2", cx); guide.setAttribute("visibility", "visible");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible");
      tip.innerHTML = "<strong>" + num(p[1], 1) + " million barrels</strong><span>" + dayText(p[0]) + "</span>";
      tip.hidden = false;
      tip.style.left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), W - tip.offsetWidth) + "px";
      tip.style.top = Math.max(cy - 58, 0) + "px";
    }
    hit.addEventListener("pointermove", show); hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", function () { guide.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; });
    box.insertBefore(g, tip);
  }
  document.querySelectorAll(".spr-history [data-range]").forEach(function (b) {
    b.addEventListener("click", function () { S.range = b.getAttribute("data-range"); chart(); });
  });
  if ("ResizeObserver" in window) new ResizeObserver(function () { if (S.data) chart(); }).observe(document.querySelector(".spr-history"));

  // ---------- start ----------
  draw();
  fetch("/data/spr.json")
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) {
      S.data = data;
      if (data.pace && data.pace.rate > 0) el.rate.value = data.pace.rate.toFixed(1);
      setupTimeline();
      S.shown = 0;
      showToday(true);
      chart();
      start();
    })
    .catch(function () { el.sub.textContent = "The latest data couldn't load. Please try again later."; });
})();
