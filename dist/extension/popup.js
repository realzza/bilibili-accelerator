(function popup() {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const STORE_KEY = "biliAcceleratorConfig";
  const enabled = document.getElementById("enabled");

  function load() {
    if (!api.storage || !api.storage.sync) {
      enabled.checked = true;
      return;
    }
    api.storage.sync.get(STORE_KEY, function (data) {
      const config = (data && data[STORE_KEY]) || {};
      enabled.checked = config.enabled !== false;
    });
  }

  function save() {
    if (!api.storage || !api.storage.sync) {
      return;
    }
    api.storage.sync.get(STORE_KEY, function (data) {
      const config = Object.assign({}, data && data[STORE_KEY], { enabled: enabled.checked });
      api.storage.sync.set({ [STORE_KEY]: config });
    });
  }

  enabled.addEventListener("change", save);
  load();
})();
