import { expect, test } from "bun:test";
import {
  claimApplicationRoot,
  markApplicationRoot,
} from "../src/app-lifecycle";

test("allows only one application runtime to claim a document root", () => {
  const root = { dataset: {} as Record<string, string | undefined> };
  expect(claimApplicationRoot(root)).toBe(true);
  expect(claimApplicationRoot(root)).toBe(false);
  markApplicationRoot(root, "running");
  expect(claimApplicationRoot(root)).toBe(false);
});

test("allows a failed startup to be replaced", () => {
  const root = {
    dataset: { aialraAppState: "failed" } as Record<string, string | undefined>,
  };
  expect(claimApplicationRoot(root)).toBe(true);
});
