# oilprices.io

Static site showing live Brent and WTI crude oil prices.

- `site/` is the website (plain HTML/CSS/JS, no build step).
- Prices and the chart are TradingView widgets (`site/widgets.js`), showing OANDA's Brent (`OANDA:BCOUSD`) and WTI (`OANDA:WTICOUSD`) quotes.
- `.github/workflows/update.yml` publishes `site/` to GitHub Pages on every change.
