import { expect, test } from "vitest";
import { cacheControlFor } from "../src/app.js";

test("uses immutable caching only for hashed static assets", () => {
  expect(cacheControlFor("/assets/index-DB-wx8Ss.js")).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(cacheControlFor("/assets/index-Kfnnxvhr.css")).toBe(
    "public, max-age=31536000, immutable",
  );
});

test("keeps unhashed runtime assets revalidated and dynamic routes uncached", () => {
  expect(cacheControlFor("/ghostty-vt.wasm")).toBe(
    "public, max-age=3600, must-revalidate",
  );
  expect(cacheControlFor("/fonts/inter.woff2")).toBe(
    "public, max-age=3600, must-revalidate",
  );
  for (const path of [
    "/",
    "/session",
    "/api/v1/me",
    "/auth/callback",
    "/health/ready",
  ]) {
    expect(cacheControlFor(path)).toBe("no-store");
  }
});
