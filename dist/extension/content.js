(function injectBiliAccelerator() {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const runtime = api.runtime;
  const STORE_KEY = "biliAcceleratorConfig";

  // Inject the page-context script that does the actual rewriting. It runs in
  // the page world so it can patch fetch/XHR/JSON.parse and window globals.
  const script = document.createElement("script");
  script.src = runtime.getURL("bili-accelerator.page.js");
  script.async = false;
  script.onload = function removeScript() {
    script.remove();
    pushConfig();
  };
  (document.documentElement || document.head).appendChild(script);

  // Bridge synced settings (set from the toolbar popup) into the page world.
  function pushConfig() {
    if (!api.storage || !api.storage.sync) {
      return;
    }
    api.storage.sync.get(STORE_KEY, function (data) {
      const config = data && data[STORE_KEY];
      if (config) {
        window.postMessage({ __biliAccel: "config", config: config }, "*");
      }
    });
  }

  // Re-push on load milestones in case the page listener wasn't ready yet.
  document.addEventListener("DOMContentLoaded", pushConfig);
  setTimeout(pushConfig, 800);

  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area === "sync" && changes[STORE_KEY] && changes[STORE_KEY].newValue) {
        window.postMessage({ __biliAccel: "config", config: changes[STORE_KEY].newValue }, "*");
      }
    });
  }
})();
