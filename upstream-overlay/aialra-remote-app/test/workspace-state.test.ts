import { expect, test } from "bun:test";
import {
  encodeWorkspaceDirectory,
  hostWorkspaceLabel,
  workspaceSessionRoute,
} from "../src/workspace-state";

test("builds the official classic session route without a V2 draft route", () => {
  const directory = "F:/AIALRA OpenCode Workspace";
  const encoded = encodeWorkspaceDirectory(directory);
  expect(workspaceSessionRoute(directory)).toBe(`/${encoded}/session`);
  expect(workspaceSessionRoute(directory)).not.toContain("new-session");
});

test("keeps host labels tied to the declared deployment mode", () => {
  expect(
    hostWorkspaceLabel({ mode: "vps" } as Parameters<
      typeof hostWorkspaceLabel
    >[0]),
  ).toBe("VPS 工作区");
  expect(
    hostWorkspaceLabel({ mode: "remote" } as Parameters<
      typeof hostWorkspaceLabel
    >[0]),
  ).toBe("远程工作区");
});
