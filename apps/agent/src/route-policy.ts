import type {
  RelayHttpRequest,
  RouteCapability,
  RouteCapabilityManifest,
} from "@aialra-opencode/protocol";

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "if-none-match",
  "x-opencode-directory",
  "x-opencode-project",
  "x-opencode-protocol",
  "x-opencode-ticket",
]);

const RESPONSE_HEADER_BLOCKLIST = new Set([
  "authorization",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function normalizedPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /%2f|%5c|%2e/i.test(value)
  ) {
    throw new Error("route path is not a normalized absolute path");
  }
  const decoded = decodeURIComponent(value);
  if (decoded.split("/").some((part) => part === ".." || part === "."))
    throw new Error("route path traversal rejected");
  return decoded;
}

function templateMatches(template: string, path: string): boolean {
  const expected = template.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every(
    (part, index) =>
      (part.startsWith("{") && part.endsWith("}")) || part === actual[index],
  );
}

export class RoutePolicy {
  constructor(readonly manifest: RouteCapabilityManifest) {}

  authorizeHttp(request: RelayHttpRequest): RouteCapability {
    const path = normalizedPath(request.path);
    const bodyBytes = request.bodyBase64
      ? Buffer.from(request.bodyBase64, "base64url").byteLength
      : 0;
    const route = this.manifest.routes.find(
      (candidate) =>
        candidate.methods.includes(request.method) &&
        templateMatches(candidate.pathTemplate, path),
    );
    if (!route)
      throw new Error("route is not present in the pinned capability manifest");
    if (bodyBytes > route.maxBodyBytes)
      throw new Error("request body exceeds the route limit");
    return route;
  }

  authorizeSocket(path: string): RouteCapability {
    const normalized = normalizedPath(path);
    const route = this.manifest.routes.find(
      (candidate) =>
        candidate.stream === "websocket" &&
        templateMatches(candidate.pathTemplate, normalized),
    );
    if (!route)
      throw new Error(
        "socket route is not present in the pinned capability manifest",
      );
    return route;
  }

  requestHeaders(input: Record<string, string>): Headers {
    const output = new Headers();
    for (const [name, value] of Object.entries(input)) {
      const normalized = name.toLowerCase();
      if (REQUEST_HEADER_ALLOWLIST.has(normalized))
        output.set(normalized, value);
    }
    return output;
  }

  responseHeaders(input: Headers): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [name, value] of input) {
      if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase()))
        output[name.toLowerCase()] = value;
    }
    return output;
  }
}
