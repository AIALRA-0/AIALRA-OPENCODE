import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [
  sourceArg,
  outputArg,
  version,
  commit,
  runtimeOpenapiSha256,
  generatedAt,
] = process.argv.slice(2);
if (
  !sourceArg ||
  !outputArg ||
  !version ||
  !commit ||
  !runtimeOpenapiSha256 ||
  !generatedAt
) {
  throw new Error(
    "usage: generate-route-manifest <source-openapi> <output> <version> <commit> <runtime-openapi-sha256> <generated-at>",
  );
}
if (!/^[0-9a-f]{64}$/.test(runtimeOpenapiSha256))
  throw new Error("runtime OpenAPI SHA-256 is invalid");

const source = resolve(sourceArg);
const output = resolve(outputArg);
const raw = await readFile(source);
// Keep the manifest stable when Git checks out the official JSON with CRLF on
// Windows and LF on Linux.
const canonicalSource = raw.toString("utf8").replace(/\r\n/g, "\n");
const openapi = JSON.parse(canonicalSource);
const methods = new Set(["get", "post", "put", "patch", "delete", "options"]);
const excludedPaths = new Set([
  "/api/integration/{integrationID}/connect/key",
  "/auth/{providerID}",
  "/global/upgrade",
]);
const routes = [];

for (const [pathTemplate, item] of Object.entries(openapi.paths ?? {})) {
  if (pathTemplate.includes("/share") || excludedPaths.has(pathTemplate))
    continue;
  const grouped = new Map();
  for (const [method, operation] of Object.entries(item ?? {})) {
    if (!methods.has(method)) continue;
    const upper = method.toUpperCase();
    const operationId = String(operation?.operationId ?? "");
    const websocket =
      pathTemplate.endsWith("/connect") && pathTemplate.includes("/pty/");
    const event =
      !websocket &&
      (pathTemplate.endsWith("/event") ||
        operationId.toLowerCase().includes("event.subscribe"));
    const category = websocket
      ? "pty"
      : event
        ? "event"
        : upper === "GET" || upper === "OPTIONS"
          ? "read"
          : "write";
    const stream = websocket ? "websocket" : event ? "sse" : "none";
    const maxBodyBytes =
      category === "read" || category === "event" || category === "pty"
        ? 0
        : 16 * 1024 * 1024;
    const key = `${category}:${stream}:${maxBodyBytes}`;
    const current = grouped.get(key) ?? {
      methods: [],
      pathTemplate,
      category,
      maxBodyBytes,
      stream,
    };
    current.methods.push(upper);
    grouped.set(key, current);
  }
  routes.push(...grouped.values());
}

routes.sort(
  (left, right) =>
    left.pathTemplate.localeCompare(right.pathTemplate) ||
    left.category.localeCompare(right.category),
);
for (const route of routes) route.methods.sort();

const manifest = {
  version: 1,
  upstreamVersion: version,
  upstreamCommit: commit,
  sourceOpenapiSha256: createHash("sha256")
    .update(canonicalSource, "utf8")
    .digest("hex"),
  openapiSha256: runtimeOpenapiSha256,
  generatedAt,
  routes,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify({
    routes: routes.length,
    openapiSha256: manifest.openapiSha256,
  }),
);
