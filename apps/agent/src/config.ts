import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const AgentConfigSchema = z.object({
  schemaVersion: z.literal(2),
  server: z.string().url(),
  hostId: z.string().min(8).max(128),
  displayName: z.string().min(1).max(120),
  mode: z.enum(["vps", "remote"]),
  identityPrivateKeyPem: z.string().includes("PRIVATE KEY"),
  identityPublicKeyPem: z.string().includes("PUBLIC KEY"),
  grantVerificationKeyPem: z.string().includes("PUBLIC KEY"),
  opencodePath: z.string().min(1),
  upstreamCommit: z.string().regex(/^[0-9a-f]{40}$/),
  expectedVersion: z.string().min(1),
  expectedOpenapiSha256: z.string().regex(/^[0-9a-f]{64}$/),
  manifestPath: z.string().min(1),
  workspaceRoot: z.string().min(1),
  workspaceLabel: z.string().min(1).max(80),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function defaultConfigPath(): string {
  const configured = process.env.AIALRA_OPENCODE_AGENT_CONFIG;
  if (configured) return resolve(configured);
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA;
    if (!root) throw new Error("LOCALAPPDATA is unavailable");
    return join(root, "AIALRA", "OpenCode", "agent.json");
  }
  const root =
    process.env.XDG_CONFIG_HOME ??
    (process.env.HOME ? join(process.env.HOME, ".config") : null);
  if (!root) throw new Error("a user configuration directory is unavailable");
  return join(root, "aialra-opencode", "agent.json");
}

export async function loadConfig(
  path = defaultConfigPath(),
): Promise<AgentConfig> {
  return AgentConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function saveConfig(
  config: AgentConfig,
  path = defaultConfigPath(),
): Promise<void> {
  const validated = AgentConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (process.platform !== "win32") await chmod(path, 0o600);
}
