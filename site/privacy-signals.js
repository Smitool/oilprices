// Loaded in <head> BEFORE the AdSense script.
// If the visitor has opted out of "sale/sharing" on this site, or their browser
// sends a Global Privacy Control (GPC) signal, ask Google for non-personalised
// ads only. Applies to every visitor who sends the signal, wherever they are.
(function () {
  var gpc = navigator.globalPrivacyControl === true;
  var manual = false;
  try { manual = localStorage.getItem("op_optout") === "1"; } catch (e) {}
  window.oilPrivacy = { gpc: gpc, manual: manual, optedOut: gpc || manual };
  if (window.oilPrivacy.optedOut) {
    (window.adsbygoogle = window.adsbygoogle || []).requestNonPersonalizedAds = 1;
  }
})();
