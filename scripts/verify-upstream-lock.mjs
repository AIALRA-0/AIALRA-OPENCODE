import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import lock from "../upstream.lock.json" with { type: "json" };

const sourceRoot = resolve(
  process.argv[2] ?? process.env.OPENCODE_UPSTREAM_SOURCE ?? ".build/upstream",
);
const openapi = await readFile(resolve(sourceRoot, lock.protocol.openapiPath));
// Git may materialize text files as CRLF on Windows. Hash the canonical LF
// representation so the same pinned upstream object verifies on every host.
const canonicalOpenapi = Buffer.from(
  openapi.toString("utf8").replace(/\r\n/g, "\n"),
  "utf8",
);
const openapiSha256 = createHash("sha256")
  .update(canonicalOpenapi)
  .digest("hex");
if (openapiSha256 !== lock.protocol.sourceOpenapiSha256)
  throw new Error("source OpenAPI digest differs from the pinned release");

const manifest = await readFile(resolve(lock.protocol.manifestPath));
const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
if (manifestSha256 !== lock.protocol.manifestSha256)
  throw new Error("route manifest digest differs from the pinned release");
const manifestValue = JSON.parse(manifest.toString("utf8"));
const forbiddenRemotePaths = new Set([
  "/api/integration/{integrationID}/connect/key",
  "/auth/{providerID}",
  "/global/upgrade",
]);
for (const route of manifestValue.routes ?? []) {
  if (forbiddenRemotePaths.has(route.pathTemplate))
    throw new Error(`forbidden remote route is present: ${route.pathTemplate}`);
  if (String(route.pathTemplate).includes("/share"))
    throw new Error(`public sharing route is present: ${route.pathTemplate}`);
}

console.log(
  JSON.stringify({
    version: lock.upstream.version,
    commit: lock.upstream.commit,
    openapiSha256,
    manifestSha256,
  }),
);
