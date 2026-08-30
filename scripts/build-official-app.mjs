import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import lock from "../upstream.lock.json" with { type: "json" };

const root = resolve(".build");
const upstream = resolve(root, "upstream");
const overlay = resolve("upstream-overlay", "aialra-remote-app");
const target = resolve(upstream, "packages", "aialra-remote-app");
const npmBun = process.env.APPDATA
  ? resolve(process.env.APPDATA, "npm", "node_modules", "bun", "bin", "bun.exe")
  : "";
const bun =
  process.platform === "win32" && npmBun && existsSync(npmBun) ? npmBun : "bun";

await mkdir(root, { recursive: true });
try {
  await stat(resolve(upstream, ".git"));
} catch {
  execFileSync(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/anomalyco/opencode.git",
      upstream,
    ],
    { stdio: "inherit" },
  );
}
execFileSync("git", ["fetch", "--depth=1", "origin", lock.upstream.commit], {
  cwd: upstream,
  stdio: "inherit",
});
execFileSync("git", ["checkout", "--detach", lock.upstream.commit], {
  cwd: upstream,
  stdio: "inherit",
});
execFileSync("git", ["reset", "--hard", lock.upstream.commit], {
  cwd: upstream,
  stdio: "inherit",
});
await rm(target, { recursive: true, force: true });
await cp(overlay, target, { recursive: true });

execFileSync("node", ["scripts/verify-upstream-lock.mjs", upstream], {
  stdio: "inherit",
});
execFileSync("node", ["scripts/scan-upstream-network.mjs", upstream], {
  stdio: "inherit",
});
execFileSync(bun, ["install"], { cwd: upstream, stdio: "inherit" });
execFileSync(bun, ["run", "--cwd", "packages/aialra-remote-app", "test"], {
  cwd: upstream,
  stdio: "inherit",
});
execFileSync(bun, ["run", "--cwd", "packages/aialra-remote-app", "typecheck"], {
  cwd: upstream,
  stdio: "inherit",
});
execFileSync(bun, ["run", "--cwd", "packages/aialra-remote-app", "build"], {
  cwd: upstream,
  stdio: "inherit",
});

const changed = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: upstream, encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((line) => !line.endsWith(" bun.lock"));
if (changed.length)
  throw new Error(
    `official source changed during build: ${changed.join(", ")}`,
  );

const dist = resolve("apps", "web", "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(target, "dist"), dist, { recursive: true });

// ghostty-web resolves this runtime asset from the application origin instead
// of importing it through Vite. Keep the upstream source tree untouched and
// copy the pinned dependency asset into the wrapper output explicitly.
const ghosttyWasm = resolve(
  upstream,
  "packages",
  "app",
  "node_modules",
  "ghostty-web",
  "ghostty-vt.wasm",
);
const ghosttyWasmTarget = resolve(dist, "ghostty-vt.wasm");
await cp(ghosttyWasm, ghosttyWasmTarget);
const wasm = await readFile(ghosttyWasmTarget);
if (
  wasm.byteLength < 8 ||
  !wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))
)
  throw new Error("ghostty-vt.wasm is missing or invalid");

execFileSync("node", ["scripts/add-sri.mjs", dist], { stdio: "inherit" });
execFileSync("node", ["scripts/add-sri.mjs", "--verify", dist], {
  stdio: "inherit",
});
const index = await readFile(resolve(dist, "index.html"), "utf8");
if (!index.includes("AIALRA OpenCode"))
  throw new Error(
    "remote wrapper marker is missing from the built application",
  );
console.log(JSON.stringify({ version: lock.upstream.version, dist }));
