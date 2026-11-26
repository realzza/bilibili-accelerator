const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core/rewrite");

// The ⚡ badge's drag, dock and hide geometry. The page only applies what
// these return, so the browser smoke test covers the wiring and this covers
// where things land.

const VW = 1280;
const VH = 720;

test("a stored badge that is missing or malformed falls back to the stock corner", () => {
  assert.deepEqual(core.normalizeBadge(), Object.assign({}, core.DEFAULT_BADGE));
  assert.deepEqual(core.normalizeBadge("junk"), Object.assign({}, core.DEFAULT_BADGE));
  const b = core.normalizeBadge({ custom: true, side: "up", x: -5, y: NaN, hidden: "yes" });
  assert.equal(b.side, "right");
  assert.equal(b.x, 0);
  assert.equal(b.y, core.DEFAULT_BADGE.y);
  assert.equal(b.hidden, false);
});

test("only a badge the viewer placed can be docked", () => {
  assert.equal(core.normalizeBadge({ docked: true }).docked, false);
  assert.equal(core.normalizeBadge({ custom: true, docked: true }).docked, true);
});

test("a drop near either side edge docks the badge there", () => {
  const left = core.badgeDrop(10, 300, VW, VH);
  assert.equal(left.side, "left");
  assert.equal(left.docked, true);
  assert.equal(left.x, 0);
  assert.equal(left.y, VH - 300 - core.BADGE_SIZE);

  const right = core.badgeDrop(VW - core.BADGE_SIZE - 4, 100, VW, VH);
  assert.equal(right.side, "right");
  assert.equal(right.docked, true);
  assert.equal(right.x, 0);
});

test("a drop away from the edges is measured from the nearer side", () => {
  const nearLeft = core.badgeDrop(200, 300, VW, VH);
  assert.deepEqual([nearLeft.side, nearLeft.x, nearLeft.docked], ["left", 200, false]);

  const nearRight = core.badgeDrop(1000, 300, VW, VH);
  assert.deepEqual([nearRight.side, nearRight.x, nearRight.docked], ["right", VW - 1000 - core.BADGE_SIZE, false]);
  assert.equal(nearRight.custom, true);
  assert.equal(nearRight.hidden, false);
});

test("a badge stays on screen when the window shrinks", () => {
  const placed = { custom: true, side: "left", x: 1200, y: 700 };
  const b = core.clampBadge(placed, 800, 600);
  assert.equal(b.x, 800 - core.BADGE_SIZE);
  assert.equal(b.y, 600 - core.BADGE_SIZE);
  // No viewport size (a stub DOM): left as stored.
  assert.equal(core.clampBadge(placed, 0, 0).x, 1200);
});

test("the stock corner opens the panel where it always did", () => {
  const rect = { left: VW - 58, top: VH - 58, width: 40, height: 40 };
  const place = core.panelPlacement(rect, VW, VH, 340);
  // right:0 / bottom:48px, the stylesheet's own placement.
  assert.equal(place.offsetX, -300);
  assert.equal(place.up, true);
  assert.equal(place.maxHeight, VH - 18 - 48 - 18);
});

test("a badge in the top-left opens the panel down and to the right", () => {
  const rect = { left: 0, top: 20, width: 40, height: 40 };
  const place = core.panelPlacement(rect, VW, VH, 340);
  assert.equal(place.up, false);
  // Kept off the left edge even though the badge sits on it.
  assert.equal(place.offsetX, 18);
  assert.equal(place.maxHeight, VH - 20 - 48 - 18);
});

test("the panel is shifted to stay inside a narrow viewport", () => {
  const vw = 400;
  const rect = { left: 220, top: 600, width: 40, height: 40 };
  const width = vw - 36;
  const place = core.panelPlacement(rect, vw, VH, width);
  const panelLeft = rect.left + place.offsetX;
  assert.ok(panelLeft >= 18);
  assert.ok(panelLeft + width <= vw - 18);
});

test("a cramped badge still gets a usable panel height", () => {
  const rect = { left: 600, top: 340, width: 40, height: 40 };
  assert.ok(core.panelPlacement(rect, VW, 300, 340).maxHeight >= 160);
});
