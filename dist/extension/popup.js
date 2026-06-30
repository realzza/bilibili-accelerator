(function popup() {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const STORE_KEY = "biliAcceleratorConfig";
  const enabled = document.getElementById("enabled");

  const STRINGS = {
    en: {
      title: "Bilibili Accelerator",
      accelTitle: "Acceleration",
      accelNote: "Speed up slow videos",
      hint: "Open a Bilibili video and tap the ⚡ in the corner for live status and advanced settings.",
      langTitle: "Language"
    },
    zh: {
      title: "Bilibili Accelerator",
      accelTitle: "加速",
      accelNote: "为慢视频提速",
      hint: "打开任意 B 站视频，点击角落的 ⚡ 查看实时状态与高级设置。",
      langTitle: "语言"
    }
  };

  let lang = "en";

  function applyLang() {
    const s = STRINGS[lang] || STRINGS.en;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = s[el.dataset.i18n];
    });
    document.querySelectorAll(".lang-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.lang === lang);
    });
  }

  function getConfig(cb) {
    if (!api.storage || !api.storage.sync) {
      cb({});
      return;
    }
    api.storage.sync.get(STORE_KEY, function (data) {
      cb((data && data[STORE_KEY]) || {});
    });
  }

  function setConfig(patch) {
    if (!api.storage || !api.storage.sync) {
      return;
    }
    getConfig(function (config) {
      api.storage.sync.set({ [STORE_KEY]: Object.assign({}, config, patch) });
    });
  }

  getConfig(function (config) {
    enabled.checked = config.enabled !== false;
    lang = config.lang === "zh" ? "zh" : "en";
    applyLang();
  });

  enabled.addEventListener("change", function () {
    setConfig({ enabled: enabled.checked });
  });

  document.querySelectorAll(".lang-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      if (lang === b.dataset.lang) {
        return;
      }
      lang = b.dataset.lang;
      applyLang();
      setConfig({ lang: lang });
    });
  });
})();
