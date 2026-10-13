const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const {
  test, expect, COSOV, AKAM, PCDN, PCDN_VIDEO, ISSUED_VIDEO, EPISODE_ISSUED_VIDEO, SEGMENT_BYTES
} = require("./site");

// What the unit tests can't see, because they run the page script against a
// stub DOM: that the built userscript installs in a real browser, that its
// hooks sit where the page's own code goes through them, and that the panel
// renders. Routing decisions stay with the unit tests, and playback against
// the real site stays a manual check before a release.

const LIGHT_INK = "rgb(23, 32, 42)";
const DARK_INK = "rgb(232, 237, 242)";

const badge = (page) => page.getByRole("button", { name: "Bilibili Accelerator" });
const panel = (page) => page.locator("#bili-accelerator-panel");

test("the userscript installs and the panel opens from the badge", async ({ page }) => {
  expect(await page.evaluate(() => window.BiliAccelerator.getDiagnostics().version)).toBe(pkg.version);
  await expect(panel(page)).toBeHidden();
  await badge(page).click();
  await expect(panel(page)).toBeVisible();
  // The page's inline playurl was rewritten on the way in, and until a video
  // plays that is what the panel reports.
  await expect(page.locator("#ba-word")).toHaveText("Playing smoothly");
  await page.locator("body").click({ position: { x: 20, y: 20 } });
  await expect(panel(page)).toBeHidden();
});

// An XHR response is covered where the page parses its text, which goes
// through the JSON.parse hook.
test("a playurl is rewritten when the page reads it inline, by fetch, or by XHR", async ({ page }) => {
  const read = await page.evaluate(async () => ({
    inline: window.__playinfo__,
    fetch: await window.fixture.fetchPlayurl(),
    xhr: await window.fixture.xhrPlayurl()
  }));
  for (const how of ["inline", "fetch", "xhr"]) {
    expect(read[how].data.dash.video[0].baseUrl, how).toBe(ISSUED_VIDEO);
    expect(JSON.stringify(read[how]), how).not.toContain(PCDN);
  }
});

test("a fragment the player downloads shows up in the panel", async ({ page, site }) => {
  await badge(page).click();
  const received = await page.evaluate(async () => {
    const info = await window.fixture.fetchPlayurl();
    return window.fixture.loadSegment(info.data.dash.video[0].baseUrl);
  });
  expect(received).toBe(SEGMENT_BYTES);
  expect(site.segments).toEqual([ISSUED_VIDEO]);
  await expect(page.locator("#ba-word")).toHaveText("Playing smoothly");
  await expect(page.locator("#ba-note")).toHaveText("Native server · Overseas · Tencent Cloud");
  // The speed card leaves its empty state on the meter's next tick, which is
  // also the first time the chart is drawn on a real canvas.
  await expect(page.locator("#ba-speed")).not.toHaveClass(/empty/);
  await expect(page.locator("#ba-spd-canvas")).toBeVisible();
});

test("a request for a PCDN node leaves the browser for the rewritten URL", async ({ page, site }) => {
  const rewritten = await page.evaluate((url) => window.BiliAccelerator.rewriteUrl(url), PCDN_VIDEO);
  expect(new URL(rewritten).host).not.toBe(PCDN);
  await page.evaluate((url) => window.fixture.loadSegment(url), PCDN_VIDEO);
  expect(site.segments).toEqual([rewritten]);
});

// A bangumi page fetches an episode's playurl when the viewer changes episode
// and reads it with response.json(). That parse is the browser's own and never
// calls JSON.parse on the page, so the fetch hook is the only place the script
// sees the episode, and the one read there has to build the engine's table.
test("a bangumi episode's playurl, read with response.json(), is rewritten and gives the engine its table", async ({ page }) => {
  await page.evaluate(() => {
    const routing = window.BiliAcceleratorRouting;
    const buildTable = routing.buildTable;
    window.tablesBuilt = 0;
    routing.buildTable = function () {
      window.tablesBuilt += 1;
      return buildTable.apply(this, arguments);
    };
  });
  const info = await page.evaluate(() => window.fixture.changeEpisode());
  const video = info.data.video_info.dash.video[0];
  expect(video.base_url).toBe(EPISODE_ISSUED_VIDEO);
  expect(JSON.stringify(info)).not.toContain(PCDN);
  await page.evaluate((url) => window.fixture.loadSegment(url), video.base_url);
  const diag = await page.evaluate(() => window.BiliAccelerator.getDiagnostics());
  expect(diag.session.requiredMbps).toBe(0.6);
  expect(diag.session.issued).toEqual({ "video 32 avc1": [COSOV, AKAM], "audio 30280 mp4a": [COSOV, AKAM] });
  // One rewrite for the page's inline playurl, one for the episode's.
  expect(diag.recentRewrites.map((rewrite) => rewrite.source)).toEqual(["__playinfo__", "fetch"]);
  expect(await page.evaluate(() => window.tablesBuilt)).toBe(1);
});

test("the panel follows the system theme until one is picked, and keeps the pick", async ({ page }) => {
  const word = page.locator("#ba-word");
  await badge(page).click();
  await expect(word).toHaveCSS("color", LIGHT_INK);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(word).toHaveCSS("color", DARK_INK);

  await page.getByRole("button", { name: "Light theme" }).click();
  await expect(word).toHaveCSS("color", LIGHT_INK);
  await page.getByRole("button", { name: "中" }).click();
  await expect(word).toHaveText("播放流畅");

  await page.reload();
  await badge(page).click();
  await expect(word).toHaveText("播放流畅");
  await expect(word).toHaveCSS("color", LIGHT_INK);
});

// ---- one line per note ------------------------------------------------------

// The panel's strings live inside the page script's closure. Read the table
// out of the source so that a note added later is measured without anyone
// having to list it here.
function panelStrings() {
  const source = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");
  const table = /\n  const STRINGS = (\{\n[\s\S]*?\n  \});\n/.exec(source);
  if (!table) {
    throw new Error("STRINGS not found in the page script; panelStrings() needs to follow it");
  }
  return new Function("return " + table[1])();
}

// A note is fixed text, or a function of a server label or of a count. Its
// parameter name says which.
function variants(note, servers) {
  if (typeof note === "string") {
    return [note];
  }
  const param = /\(\s*(\w*)\s*\)/.exec(String(note))[1];
  if (param === "server") {
    return servers.map((server) => note(server));
  }
  if (param === "n") {
    return [1, 12].map((n) => note(n));
  }
  throw new Error("a note takes \"" + param + "\"; variants() needs a value to measure it with");
}

// Everything the status line and the count under it can say. Server labels
// are built as hostLabel() builds them, for every region and vendor.
function statusTexts(strings) {
  const servers = Object.values(strings.regions).flatMap((region) =>
    Object.values(strings.vendors).map((vendor) => region + " · " + vendor));
  const notes = Object.values(strings.status).map((pair) => pair[1])
    .concat(Object.values(strings.notes).flatMap((note) => variants(note, servers)));
  const counts = variants(strings.switchCount, servers).concat(variants(strings.p2pCount, servers));
  return { notes: notes.filter(Boolean), counts };
}

// Runs in the page. Returns every note that isn't exactly one line: the
// switch rows as rendered, and each status text set into its own element.
function notesOffOneLine(texts) {
  const shadow = document.getElementById("bili-accelerator-button").shadowRoot;
  const lines = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
  };
  const off = [];
  shadow.querySelectorAll(".ba-switch-note").forEach((el) => {
    if (lines(el) !== 1) {
      off.push(el.textContent);
    }
  });
  [["ba-note", texts.notes], ["ba-count", texts.counts]].forEach(([id, list]) => {
    const el = shadow.getElementById(id);
    const shown = el.textContent;
    list.forEach((text) => {
      el.textContent = text;
      if (lines(el) !== 1) {
        off.push(text);
      }
    });
    el.textContent = shown;
  });
  return off;
}

test.describe("with room for the whole panel", () => {
  // Tall enough that the open panel doesn't scroll: where scrollbars take up
  // space, one would come out of the width of every row.
  test.use({ viewport: { width: 1280, height: 1100 } });

  // Widths depend on the font. CI runs this on macOS, so it measures the
  // system font there, the same one the notes were written against.
  test("every note fits on one line in English and Chinese", async ({ page }) => {
    const strings = panelStrings();
    const off = {};
    await badge(page).click();
    await page.locator("#ba-adv-toggle").click();
    // A fixed server shows the rows that auto selection hides.
    await page.locator("select:has(option[value=fixed])").selectOption("fixed");
    for (const [lang, button] of [["en", "EN"], ["zh", "中"]]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(page.locator("#ba-adv-label")).toHaveText(strings[lang].advHide);
      off[lang] = await page.evaluate(notesOffOneLine, statusTexts(strings[lang]));
    }
    expect(off).toEqual({ en: [], zh: [] });
  });
});
