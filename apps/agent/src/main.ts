#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentRuntime, enroll } from "./agent.js";
import { defaultConfigPath, loadConfig, saveConfig } from "./config.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readPairingCode(value: string): Promise<string> {
  if (value !== "-") return (await readFile(resolve(value), "utf8")).trim();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  if (command === "enroll") {
    const pairingFile = required("--pairing-code-file");
    const pairingCode = await readPairingCode(pairingFile);
    const mode = required("--mode");
    if (mode !== "vps" && mode !== "remote")
      throw new Error("--mode must be vps or remote");
    const server = required("--server");
    const identity = await enroll({
      server,
      code: pairingCode,
      displayName: required("--name"),
      mode,
    });
    await saveConfig(
      {
        schemaVersion: 1,
        server,
        ...identity,
        displayName: required("--name"),
        mode,
        opencodePath: resolve(required("--opencode")),
        upstreamCommit: required("--upstream-commit"),
        expectedVersion: required("--expected-version"),
        expectedOpenapiSha256: required("--openapi-sha256"),
        manifestPath: resolve(required("--manifest")),
      },
      option("--config") ? resolve(option("--config")!) : defaultConfigPath(),
    );
    process.stdout.write(
      JSON.stringify({ enrolled: true, hostId: identity.hostId }) + "\n",
    );
    return;
  }
  if (command !== "run")
    throw new Error("supported commands are enroll and run");
  const config = await loadConfig(
    option("--config") ? resolve(option("--config")!) : defaultConfigPath(),
  );
  const runtime = await AgentRuntime.create(config);
  const stop = async () => {
    await runtime.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await runtime.run();
}

main().catch((error) => {
  process.stderr.write(
    `[agent] ${error instanceof Error ? error.message : "failed"}\n`,
  );
  process.exitCode = 1;
});
