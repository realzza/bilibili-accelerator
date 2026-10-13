const { defineConfig, devices } = require("@playwright/test");

// The browser tests in browser/. `node --test` doesn't pick these up; run
// them with `npm run test:browser`.
module.exports = defineConfig({
  testDir: "browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a test that only passes the second time is one to fix or drop.
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "webkit", use: devices["Desktop Safari"] }
  ]
});
