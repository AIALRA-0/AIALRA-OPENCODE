import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { RelayHttpRequest } from "@aialra-opencode/protocol";

const PATH_FIELDS = new Set([
  "cwd",
  "directory",
  "file",
  "path",
  "root",
  "target",
  "worktree",
]);

const METADATA_LIST_KEYS = new Set([
  "data",
  "entries",
  "items",
  "projects",
  "results",
  "sessions",
]);

const METADATA_PATH_KEYS = new Set([
  "cwd",
  "directory",
  "root",
  "target",
  "worktree",
]);
const MAX_METADATA_RESPONSE_BYTES = 16 * 1024 * 1024;

function contained(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function rejectWindowsSpecialPath(value: string): void {
  if (process.platform !== "win32") return;
  if (/^(?:\\\\|\\\\\?\\|\\\\\.\\)/u.test(value))
    throw new Error("workspace path uses a forbidden Windows namespace");
}

async function nearestExisting(value: string): Promise<string> {
  let current = value;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function pathValues(input: unknown, key = ""): string[] {
  if (typeof input === "string")
    return PATH_FIELDS.has(key.toLowerCase()) ? [input] : [];
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input))
    return input.flatMap((value) => pathValues(value, key));
  return Object.entries(input).flatMap(([name, value]) =>
    pathValues(value, name),
  );
}

function metadataResource(pathname: string): "project" | "session" | null {
  const segments = pathname.split("/").filter(Boolean);
  const namespace = segments[0] === "api" ? segments[1] : segments[0];
  return namespace === "project" || namespace === "session" ? namespace : null;
}

function metadataPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  for (const [name, child] of Object.entries(value)) {
    if (METADATA_PATH_KEYS.has(name.toLowerCase()) && typeof child === "string")
      return child;
    if ((name === "project" || name === "worktreeInfo") && child) {
      const nested = metadataPath(child);
      if (nested) return nested;
    }
  }
  return undefined;
}

interface MetadataSanitization {
  body: Uint8Array;
  status: number | null;
  filteredCount: number;
}

function locationEnvelope(
  root: string,
  data: unknown,
): Record<string, unknown> {
  return {
    location: {
      directory: root,
      project: { id: "aialra-workspace", directory: root },
    },
    data,
  };
}

function compatibilityMetadata(
  pathname: string,
  root: string,
): { body: Uint8Array; status: number | null } | null {
  const json = (value: unknown, status: number | null = null) => ({
    body: Buffer.from(JSON.stringify(value), "utf8"),
    status,
  });

  // The published App client still probes these aliases while talking to the
  // newer server API.  They are read-only compatibility responses, never a
  // proxy for an arbitrary route or directory.
  if (pathname === "/api/model/default")
    return json(locationEnvelope(root, null));
  if (pathname === "/api/project") return json([]);
  if (pathname === "/api/project/current")
    return json({ id: "aialra-workspace", directory: root });
  if (/^\/api\/project\/[^/]+\/directories$/u.test(pathname))
    return json([{ directory: root }]);
  if (pathname === "/api/mcp") return json(locationEnvelope(root, []));
  if (pathname === "/api/mcp/resource")
    return json(locationEnvelope(root, { resources: [], templates: [] }));
  if (pathname === "/api/form/request") return json(locationEnvelope(root, []));
  if (pathname === "/api/plugin") return json(locationEnvelope(root, []));
  if (pathname === "/api/vcs/diff" || pathname === "/api/vcs/status")
    return json(locationEnvelope(root, []));
  if (pathname === "/api/shell") return json(locationEnvelope(root, []));
  if (/^\/api\/shell\/[^/]+(?:\/output)?$/u.test(pathname))
    return json(locationEnvelope(root, []), 404);
  if (/^\/api\/session\/[^/]+\/form(?:\/[^/]+(?:\/state)?)?$/u.test(pathname))
    return json([]);
  if (
    /^\/api\/session\/[^/]+\/(?:pending|instructions\/entries)$/u.test(pathname)
  )
    return json([]);
  return null;
}

function safeReadShape(
  pathname: string,
  root: string,
): { body: Uint8Array; status: number | null } | null {
  const json = (value: unknown, status: number | null = null) => ({
    body: Buffer.from(JSON.stringify(value), "utf8"),
    status,
  });
  if (pathname === "/path" || pathname === "/api/path")
    return json({
      state: root,
      config: root,
      worktree: root,
      directory: root,
      home: root,
    });
  if (pathname === "/provider" || pathname === "/agent" || pathname === "/mcp")
    return json({});
  if (
    pathname === "/lsp" ||
    pathname === "/permission" ||
    pathname === "/question"
  )
    return json([]);
  if (pathname === "/command" || pathname === "/vcs") return json([]);
  if (pathname === "/config" || pathname === "/global/config") return json({});
  if (
    pathname === "/api/model" ||
    pathname === "/api/provider" ||
    pathname === "/api/agent"
  )
    return json(locationEnvelope(root, []));
  if (pathname === "/api/reference" || pathname === "/api/command")
    return json(locationEnvelope(root, []));
  if (
    pathname === "/api/permission/request" ||
    pathname === "/api/question/request"
  )
    return json(locationEnvelope(root, []));
  if (pathname === "/api/session") return json({ data: [], cursor: {} });
  return null;
}

export class WorkspaceBoundary {
  private constructor(
    readonly root: string,
    private readonly canonicalRoot: string,
  ) {}

  static async create(workspaceRoot: string): Promise<WorkspaceBoundary> {
    rejectWindowsSpecialPath(workspaceRoot);
    if (!isAbsolute(workspaceRoot))
      throw new Error("workspace root must be absolute");
    const root = resolve(workspaceRoot);
    const info = await lstat(root);
    if (!info.isDirectory())
      throw new Error("workspace root must be a directory");
    const canonicalRoot = await realpath(root);
    return new WorkspaceBoundary(root, canonicalRoot);
  }

  async assertPath(value: string, base = this.root): Promise<void> {
    if (value === "") return;
    if (value.includes("\0")) throw new Error("workspace path is invalid");
    rejectWindowsSpecialPath(value);
    const candidate = resolve(base, value);
    if (!contained(candidate, this.root))
      throw new Error("workspace boundary rejected path");
    const existing = await nearestExisting(candidate);
    const canonical = await realpath(existing);
    if (!contained(canonical, this.canonicalRoot))
      throw new Error("workspace boundary rejected linked path");
  }

  async isInside(value: string, base = this.root): Promise<boolean> {
    try {
      await this.assertPath(value, base);
      return true;
    } catch {
      return false;
    }
  }

  async assertRequest(request: RelayHttpRequest): Promise<void> {
    const url = this.parseQuery(request.path, request.query);
    const headerDirectory = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === "x-opencode-directory",
    )?.[1];
    await this.assertQuery(url, headerDirectory);
    const queryDirectory = url.searchParams.get("directory") ?? undefined;
    const base = queryDirectory ?? headerDirectory ?? this.root;
    await this.assertPath(base);

    if (!request.bodyBase64) return;
    const contentType = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    if (!contentType?.toLowerCase().includes("application/json")) return;
    let body: unknown;
    try {
      body = JSON.parse(
        Buffer.from(request.bodyBase64, "base64url").toString("utf8"),
      );
    } catch {
      throw new Error("workspace request JSON is invalid");
    }
    for (const value of pathValues(body)) await this.assertPath(value, base);
  }

  async safeMetadataRead(
    request: RelayHttpRequest,
  ): Promise<MetadataSanitization | null> {
    if (request.method !== "GET") return null;
    const url = this.parseQuery(request.path, request.query);
    const headerDirectory = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === "x-opencode-directory",
    )?.[1];
    const directory = url.searchParams.get("directory") ?? headerDirectory;
    const compatibility = compatibilityMetadata(request.path, this.root);
    if (compatibility) {
      // Compatibility aliases are safe to answer locally even for the valid
      // workspace because the pinned upstream server does not expose all of
      // the older client paths.
      return { ...compatibility, filteredCount: 0 };
    }
    const resource = metadataResource(request.path);
    if (!resource) {
      if (!directory || (await this.isInside(directory))) return null;
      const safe = safeReadShape(request.path, this.root);
      return safe ? { ...safe, filteredCount: 1 } : null;
    }
    if (!directory || (await this.isInside(directory))) return null;
    const segments = request.path.split("/").filter(Boolean);
    const direct =
      segments[0] === "api" ? segments.length > 2 : segments.length > 1;
    const safe = safeReadShape(request.path, this.root);
    if (safe) return { ...safe, filteredCount: 1 };
    return {
      body: Buffer.from(
        request.path === "/api/session"
          ? JSON.stringify({ data: [], cursor: {} })
          : direct
            ? "{}"
            : "[]",
        "utf8",
      ),
      status: direct ? 404 : 200,
      filteredCount: 1,
    };
  }

  async assertSocket(pathname: string, query: string): Promise<void> {
    const url = this.parseQuery(pathname, query);
    await this.assertQuery(url);
  }

  private parseQuery(pathname: string, query: string): URL {
    const normalizedQuery = query
      ? query.startsWith("?")
        ? query
        : `?${query}`
      : "";
    return new URL(`http://workspace.invalid${pathname}${normalizedQuery}`);
  }

  private async assertQuery(url: URL, headerDirectory?: string): Promise<void> {
    const queryDirectory = url.searchParams.get("directory") ?? undefined;
    const base = queryDirectory ?? headerDirectory ?? this.root;
    await this.assertPath(base);

    for (const name of PATH_FIELDS) {
      for (const value of url.searchParams.getAll(name))
        await this.assertPath(value, base);
    }
  }

  sanitizePathResponse(pathname: string, body: Uint8Array): Uint8Array {
    if (pathname !== "/path" && pathname !== "/api/path") return body;
    try {
      const value = JSON.parse(Buffer.from(body).toString("utf8")) as Record<
        string,
        unknown
      >;
      for (const name of ["home", "worktree", "directory"])
        value[name] = this.root;
      return Buffer.from(JSON.stringify(value));
    } catch {
      return body;
    }
  }

  async sanitizeMetadataResponse(
    pathname: string,
    body: Uint8Array,
  ): Promise<MetadataSanitization | null> {
    const resource = metadataResource(pathname);
    if (!resource) return null;
    if (body.byteLength > MAX_METADATA_RESPONSE_BYTES)
      throw new Error("workspace metadata response exceeds sanitization limit");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      throw new Error("workspace metadata response is not JSON");
    }

    let filteredCount = 0;
    const filterList = async (items: unknown[]): Promise<unknown[]> => {
      const output: unknown[] = [];
      for (const item of items) {
        const path = metadataPath(item);
        if (!path || !(await this.isInside(path))) {
          filteredCount += 1;
          continue;
        }
        output.push(await filterValue(item, false));
      }
      return output;
    };
    const filterValue = async (
      input: unknown,
      listItem: boolean,
    ): Promise<unknown> => {
      if (Array.isArray(input)) {
        return listItem
          ? filterList(input)
          : Promise.all(input.map((item) => filterValue(item, false)));
      }
      if (!input || typeof input !== "object") return input;
      const output: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(input)) {
        if (
          Array.isArray(child) &&
          METADATA_LIST_KEYS.has(name.toLowerCase())
        ) {
          output[name] = await filterList(child);
        } else {
          output[name] = await filterValue(child, false);
        }
      }
      return output;
    };

    const segments = pathname.split("/").filter(Boolean);
    const direct =
      segments[0] === "api" ? segments.length > 2 : segments.length > 1;
    const directPath = direct ? metadataPath(value) : undefined;
    if (direct && (!directPath || !(await this.isInside(directPath)))) {
      return { body: Buffer.from("{}", "utf8"), status: 404, filteredCount: 1 };
    }
    if (Array.isArray(value)) value = await filterList(value);
    else value = await filterValue(value, false);

    return {
      body: Buffer.from(JSON.stringify(value), "utf8"),
      status: null,
      filteredCount,
    };
  }
}

export function workspaceExternalDirectoryConfig(): string {
  return JSON.stringify({
    permission: { external_directory: "deny" },
  });
}
