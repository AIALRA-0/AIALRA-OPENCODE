import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceBoundary } from "../src/workspace-boundary.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aialra-workspace-root-"));
  const outside = await mkdtemp(join(tmpdir(), "aialra-workspace-outside-"));
  cleanup.push(root, outside);
  await mkdir(join(root, "project"));
  return { root, outside, boundary: await WorkspaceBoundary.create(root) };
}

describe("WorkspaceBoundary", () => {
  it("accepts the root, children, and new children", async () => {
    const { root, boundary } = await fixture();
    await expect(boundary.assertPath(root)).resolves.toBeUndefined();
    await expect(
      boundary.assertPath(join(root, "project")),
    ).resolves.toBeUndefined();
    await expect(
      boundary.assertPath(join(root, "project", "new")),
    ).resolves.toBeUndefined();
  });

  it("rejects lexical and linked escapes", async () => {
    const { root, outside, boundary } = await fixture();
    await expect(boundary.assertPath(outside)).rejects.toThrow(
      "workspace boundary",
    );
    const link = join(root, "escape");
    await symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(boundary.assertPath(link)).rejects.toThrow("linked path");
  });

  it("checks headers, query parameters, and JSON payload paths", async () => {
    const { root, outside, boundary } = await fixture();
    const request = (input: Partial<Record<string, unknown>>) => ({
      type: "relay.http.request" as const,
      requestId: "2fb2c977-d7ed-4f61-a1fb-90e82e78611f",
      method: "POST" as const,
      path: "/pty",
      query: "",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": root,
      },
      bodyBase64: null,
      ...input,
    });
    await expect(boundary.assertRequest(request({}))).resolves.toBeUndefined();
    await expect(
      boundary.assertRequest(
        request({ query: `directory=${encodeURIComponent(outside)}` }),
      ),
    ).rejects.toThrow("workspace boundary");
    await expect(
      boundary.assertRequest(
        request({
          bodyBase64: Buffer.from(JSON.stringify({ cwd: outside })).toString(
            "base64url",
          ),
        }),
      ),
    ).rejects.toThrow("workspace boundary");
  });

  it("maps the path response to the public workspace view", async () => {
    const { root, boundary } = await fixture();
    const value = JSON.parse(
      Buffer.from(
        boundary.sanitizePathResponse(
          "/path",
          Buffer.from(
            JSON.stringify({
              home: "/private",
              worktree: "/private",
              directory: "/private",
            }),
          ),
        ),
      ).toString("utf8"),
    ) as Record<string, string>;
    expect(value).toMatchObject({
      home: root,
      worktree: root,
      directory: root,
    });
  });

  it("checks PTY directory query values", async () => {
    const { root, outside, boundary } = await fixture();
    await expect(
      boundary.assertSocket("/pty", `directory=${encodeURIComponent(root)}`),
    ).resolves.toBeUndefined();
    await expect(
      boundary.assertSocket("/pty", `directory=${encodeURIComponent(outside)}`),
    ).rejects.toThrow("workspace boundary");
  });

  it("filters project and session metadata without deleting history", async () => {
    const { root, outside, boundary } = await fixture();
    const projects = await boundary.sanitizeMetadataResponse(
      "/project",
      Buffer.from(
        JSON.stringify({
          projects: [
            { worktree: root, name: "inside" },
            { worktree: outside, name: "outside" },
            { name: "unknown" },
          ],
        }),
      ),
    );
    expect(projects?.status).toBeNull();
    expect(projects?.filteredCount).toBe(2);
    expect(JSON.parse(Buffer.from(projects!.body).toString("utf8"))).toEqual({
      projects: [{ worktree: root, name: "inside" }],
    });

    const session = await boundary.sanitizeMetadataResponse(
      "/session/ses_outside",
      Buffer.from(JSON.stringify({ id: "ses_outside", directory: outside })),
    );
    expect(session?.status).toBe(404);
    expect(JSON.parse(Buffer.from(session!.body).toString("utf8"))).toEqual({});
  });

  it("returns a safe 404 for direct metadata without a verifiable directory", async () => {
    const { boundary } = await fixture();
    const result = await boundary.sanitizeMetadataResponse(
      "/api/session/ses_unknown",
      Buffer.from(JSON.stringify({ id: "ses_unknown" })),
    );
    expect(result).toMatchObject({ status: 404, filteredCount: 1 });
    expect(Buffer.from(result!.body).toString("utf8")).toBe("{}");
  });

  it("short-circuits stale metadata reads outside the workspace", async () => {
    const { outside, boundary } = await fixture();
    const result = await boundary.safeMetadataRead({
      type: "relay.http.request",
      requestId: "2fb2c977-d7ed-4f61-a1fb-90e82e78611f",
      method: "GET",
      path: "/session",
      query: `directory=${encodeURIComponent(outside)}`,
      headers: {},
      bodyBase64: null,
    });
    expect(result).toMatchObject({ status: 200, filteredCount: 1 });
    expect(Buffer.from(result!.body).toString("utf8")).toBe("[]");
  });

  it("returns client-compatible empty shapes for legacy bootstrap aliases", async () => {
    const { root, boundary } = await fixture();
    const model = await boundary.safeMetadataRead({
      type: "relay.http.request",
      requestId: "2fb2c977-d7ed-4f61-a1fb-90e82e78611f",
      method: "GET",
      path: "/api/model/default",
      query: `location[directory]=${encodeURIComponent(root)}`,
      headers: {},
      bodyBase64: null,
    });
    expect(JSON.parse(Buffer.from(model!.body).toString("utf8"))).toMatchObject(
      {
        data: null,
      },
    );

    const mcp = await boundary.safeMetadataRead({
      type: "relay.http.request",
      requestId: "2fb2c977-d7ed-4f61-a1fb-90e82e78611f",
      method: "GET",
      path: "/api/mcp",
      query: "",
      headers: {},
      bodyBase64: null,
    });
    expect(JSON.parse(Buffer.from(mcp!.body).toString("utf8"))).toMatchObject({
      data: [],
    });
  });

  it("keeps the v2 session list response shape when an old directory is requested", async () => {
    const { outside, boundary } = await fixture();
    const result = await boundary.safeMetadataRead({
      type: "relay.http.request",
      requestId: "2fb2c977-d7ed-4f61-a1fb-90e82e78611f",
      method: "GET",
      path: "/api/session",
      query: `directory=${encodeURIComponent(outside)}`,
      headers: {},
      bodyBase64: null,
    });
    expect(result?.status).toBeNull();
    expect(JSON.parse(Buffer.from(result!.body).toString("utf8"))).toEqual({
      data: [],
      cursor: {},
    });
  });
});
