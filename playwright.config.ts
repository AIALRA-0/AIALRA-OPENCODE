import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
