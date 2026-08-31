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
}

export function workspaceExternalDirectoryConfig(): string {
  return JSON.stringify({
    permission: { external_directory: "deny" },
  });
}
