(function () {
  "use strict";
  var p = window.oilPrivacy || { gpc: false, manual: false, optedOut: false };

  // "Privacy and cookie settings": reopens Google's consent message so visitors
  // in the EEA, UK and Switzerland can change or withdraw consent. Works once
  // AdSense with a European regulations message is live.
  document.querySelectorAll("[data-consent-settings]").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      window.googlefc = window.googlefc || {};
      window.googlefc.callbackQueue = window.googlefc.callbackQueue || [];
      window.googlefc.callbackQueue.push(function () {
        if (typeof window.googlefc.showRevocationMessage === "function") {
          window.googlefc.showRevocationMessage();
        }
      });
    });
  });

  // Footer notice when a Global Privacy Control signal is honoured.
  document.querySelectorAll("[data-gpc-notice]").forEach(function (el) {
    el.hidden = !p.gpc;
  });

  // Opt-out status and control on the privacy page.
  var status = document.querySelector("[data-optout-status]");
  var button = document.querySelector("[data-optout-toggle]");
  function render() {
    if (!status) return;
    if (p.gpc) {
      status.textContent = "Opt-out request honored. Your browser sends a Global Privacy Control signal, so you are opted out of the sale and sharing of personal information on this site.";
      if (button) button.hidden = true;
    } else if (p.manual) {
      status.textContent = "You are opted out of the sale and sharing of personal information on this site, in this browser.";
      if (button) { button.hidden = false; button.textContent = "Opt back in"; }
    } else {
      status.textContent = "You are not opted out.";
      if (button) { button.hidden = false; button.textContent = "Opt out of sale and sharing"; }
    }
  }
  if (button) {
    button.addEventListener("click", function () {
      p.manual = !p.manual;
      try {
        if (p.manual) localStorage.setItem("op_optout", "1");
        else localStorage.removeItem("op_optout");
      } catch (e) {}
      p.optedOut = p.gpc || p.manual;
      render();
      // Reload so the next ad requests use the new setting.
      setTimeout(function () { location.reload(); }, 600);
    });
  }
  render();
})();
