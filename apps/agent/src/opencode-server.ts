import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceExternalDirectoryConfig } from "./workspace-boundary.js";

export interface OpenCodeProbe {
  version: string;
  openapiSha256: string;
  baseUrl: URL;
  authorization: string;
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("failed to allocate a loopback port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function commandPath(path: string): { command: string; argsPrefix: string[] } {
  if (process.platform === "win32" && /\.(?:cmd|ps1)$/i.test(path)) {
    throw new Error(
      "the immutable OpenCode executable must be a native binary",
    );
  }
  return { command: path, argsPrefix: [] };
}

export class OpenCodeServer {
  private child: ChildProcess | null = null;
  private probe: OpenCodeProbe | null = null;

  constructor(
    private readonly executable: string,
    private readonly expectedVersion: string,
    private readonly expectedOpenapiSha256: string,
    private readonly workspaceRoot: string,
  ) {}

  async start(): Promise<OpenCodeProbe> {
    if (this.probe && this.child?.exitCode === null) return this.probe;
    const version = await this.readVersion();
    if (version !== this.expectedVersion)
      throw new Error(
        `OpenCode version mismatch: expected ${this.expectedVersion}, received ${version}`,
      );
    const port = await freeLoopbackPort();
    const username = "opencode";
    const password = randomBytes(32).toString("base64url");
    const { command, argsPrefix } = commandPath(this.executable);
    const child = spawn(
      command,
      [
        ...argsPrefix,
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: username,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: workspaceExternalDirectoryConfig(),
        },
        cwd: this.workspaceRoot,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      },
    );
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.probe = null;
      }
    });
    const baseUrl = new URL(`http://127.0.0.1:${port}`);
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null)
        throw new Error(
          `OpenCode server exited before readiness with code ${child.exitCode}`,
        );
      try {
        const health = await fetch(new URL("/global/health", baseUrl), {
          headers: { authorization },
          signal: AbortSignal.timeout(2_000),
        });
        if (health.ok) {
          const doc = await fetch(new URL("/doc", baseUrl), {
            headers: { authorization },
            signal: AbortSignal.timeout(10_000),
          });
          if (!doc.ok) throw new Error(`OpenCode /doc returned ${doc.status}`);
          const raw = new Uint8Array(await doc.arrayBuffer());
          const openapiSha256 = createHash("sha256").update(raw).digest("hex");
          if (openapiSha256 !== this.expectedOpenapiSha256) {
            await this.stop();
            throw new Error(
              "runtime OpenAPI digest differs from the pinned release",
            );
          }
          this.probe = { version, openapiSha256, baseUrl, authorization };
          return this.probe;
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("differs from"))
          throw error;
      }
      await delay(250);
    }
    await this.stop();
    throw new Error("OpenCode server did not become ready within 20 seconds");
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.probe = null;
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      await Promise.race([once(killer, "exit"), delay(5_000)]);
      return;
    }
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private async readVersion(): Promise<string> {
    const { command, argsPrefix } = commandPath(this.executable);
    const child = spawn(command, [...argsPrefix, "--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const [code] = (await once(child, "exit")) as [number | null];
    if (code !== 0) throw new Error("failed to read the OpenCode version");
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
