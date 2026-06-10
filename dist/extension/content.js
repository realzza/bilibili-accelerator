(function injectBiliAccelerator() {
  "use strict";

  const runtime = typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
  const script = document.createElement("script");
  script.src = runtime.getURL("bili-accelerator.page.js");
  script.async = false;
  script.onload = function removeScript() {
    script.remove();
  };

  (document.documentElement || document.head).appendChild(script);
})();
