// Live prices and chart from TradingView widgets (free, licensed by TradingView).
// Prices are OANDA's Brent and WTI crude oil CFD quotes.
(function () {
  "use strict";

  var BASE = "https://s3.tradingview.com/external-embedding/";
  var SYMBOLS = { brent: "OANDA:BCOUSD", wti: "OANDA:WTICOUSD" };
  var darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  var COLORS = {
    light: { line: "#0b5563", top: "rgba(11, 85, 99, 0.16)", bottom: "rgba(11, 85, 99, 0)", grid: "rgba(19, 34, 44, 0.06)", font: "#6b7880" },
    dark:  { line: "#6cc3d1", top: "rgba(108, 195, 209, 0.18)", bottom: "rgba(108, 195, 209, 0)", grid: "rgba(232, 238, 240, 0.06)", font: "#8795a0" }
  };

  function mount(slot, script, config) {
    var box = slot.querySelector("[data-tv-target]");
    var fallback = slot.querySelector("[data-tv-fallback]");
    box.replaceChildren();
    if (fallback) fallback.hidden = true;

    var container = document.createElement("div");
    container.className = "tradingview-widget-container";
    var inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    var s = document.createElement("script");
    s.type = "text/javascript";
    s.src = BASE + script;
    s.async = true;
    s.textContent = JSON.stringify(config);
    container.append(inner, s);
    box.append(container);

    // If the widget hasn't appeared after 12 seconds (blocked or offline), say so.
    setTimeout(function () {
      if (fallback && !box.querySelector("iframe")) fallback.hidden = false;
    }, 12000);
  }

  function render() {
    var theme = darkQuery.matches ? "dark" : "light";
    var c = COLORS[theme];

    // One lightweight widget for both prices (one download instead of two).
    var tickers = document.querySelector("[data-tv-tickers]");
    if (tickers) {
      mount(tickers, "embed-widget-tickers.js", {
        symbols: [
          { proName: SYMBOLS.brent, title: "Brent crude" },
          { proName: SYMBOLS.wti, title: "WTI crude" }
        ],
        colorTheme: "dark",
        isTransparent: true,
        showSymbolLogo: true,
        locale: "en"
      });
    }

    var chart = document.querySelector("[data-tv-chart]");
    if (chart) whenIdle(function () { mountChart(chart, theme, c); });
  }

  // Run after the price widgets have started loading (or within 1.2 s at the latest).
  function whenIdle(fn) {
    if ("requestIdleCallback" in window) window.requestIdleCallback(fn, { timeout: 1200 });
    else setTimeout(fn, 400);
  }

  function mountChart(chart, theme, c) {
    {
      mount(chart, "embed-widget-symbol-overview.js", {
        symbols: [["Brent", SYMBOLS.brent + "|12M"], ["WTI", SYMBOLS.wti + "|12M"]],
        chartOnly: false,
        width: "100%",
        height: "100%",
        autosize: true,
        locale: "en",
        colorTheme: theme,
        isTransparent: true,
        backgroundColor: "rgba(0, 0, 0, 0)",
        showVolume: false,
        showMA: false,
        hideDateRanges: false,
        hideMarketStatus: false,
        hideSymbolLogo: true,
        scalePosition: "right",
        scaleMode: "Normal",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        fontSize: "11",
        noTimeScale: false,
        valuesTracking: "1",
        changeMode: "price-and-percent",
        chartType: "area",
        lineWidth: 2,
        lineType: 0,
        lineColor: c.line,
        topColor: c.top,
        bottomColor: c.bottom,
        gridLineColor: c.grid,
        fontColor: c.font,
        widgetFontColor: c.font,
        dateRanges: ["1d|1", "1m|30", "3m|60", "12m|1D", "60m|1W", "all|1M"]
      });
    }
  }

  render();
  if (darkQuery.addEventListener) darkQuery.addEventListener("change", render);
})();
