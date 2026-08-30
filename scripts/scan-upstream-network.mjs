import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import lock from "../upstream.lock.json" with { type: "json" };

const root = resolve(
  process.argv[2] ?? process.env.OPENCODE_UPSTREAM_SOURCE ?? ".build/upstream",
);
const sourceRoot = join(root, "packages", "app", "src");
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
}

await walk(sourceRoot);
const findings = {
  platformFetchReferences: 0,
  directWebSockets: [],
  directEventSources: [],
  directWorkers: [],
  globalFetchAllowlist: [],
};

for (const file of files) {
  const text = await readFile(file, "utf8");
  const name = relative(root, file).split(sep).join("/");
  findings.platformFetchReferences +=
    text.match(/platform\.fetch/g)?.length ?? 0;
  if (/new\s+WebSocket\s*\(/.test(text)) findings.directWebSockets.push(name);
  if (/new\s+EventSource\s*\(/.test(text))
    findings.directEventSources.push(name);
  if (
    /new\s+(?:Shared)?Worker\s*\(/.test(text) ||
    /navigator\.serviceWorker/.test(text)
  )
    findings.directWorkers.push(name);
  if (
    /\bfetch\s*\(/.test(text) &&
    !/platform\.fetch/.test(text) &&
    !name.endsWith("utils/server-protocol.ts")
  ) {
    if (name.endsWith("utils/draft-store.ts"))
      findings.globalFetchAllowlist.push(name);
    else if (!/\.refetch\s*\(/.test(text) && !/\.prefetch\s*\(/.test(text))
      findings.globalFetchAllowlist.push(`UNREVIEWED:${name}`);
  }
}

for (const key of [
  "directWebSockets",
  "directEventSources",
  "directWorkers",
  "globalFetchAllowlist",
])
  findings[key].sort();
const expected = lock.networkBaseline;
if (JSON.stringify(findings) !== JSON.stringify(expected)) {
  console.error(JSON.stringify({ expected, observed: findings }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(findings));
